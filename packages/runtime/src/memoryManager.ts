import type {
  CompactBoundary,
  MemoryAddInput,
  MemoryCandidate,
  MemoryFact,
  MemoryFactKind,
  MemoryImportInput,
  MemoryImportResult,
  MemoryPage,
  MemoryRecallFeedback,
  MemoryRecallFeedbackInput,
  MemoryRecallRecord,
  MemoryReplayRecallInput,
  MemoryReplayRecallResult,
  MemoryRecordStatus,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
  MemorySnapshot,
  MemoryTransfer,
  MemoryUpdateInput
} from "@supbot/shared";
import { clampNumber, nowIso } from "@supbot/shared";

export interface MemoryManagerHost {
  randomId(prefix: string): string;
  nowIso(): string;
}

export interface MemoryCandidateInput {
  conversationId: string;
  subagentName?: string;
  source: string;
  summary: string;
}

export class MemoryManager {
  constructor(private readonly host: MemoryManagerHost = { randomId: fallbackId, nowIso }) {}

  search(memory: MemorySnapshot, query: MemorySearchQuery = {}): MemorySearchResult[] {
    const limit = clampNumber(query.limit ?? 8, 1, 100);
    const budgetChars = query.budgetChars ? clampNumber(query.budgetChars, 200, 50_000) : undefined;
    const results = rankMemoryResults(memory, query, limit, this.matchesScope.bind(this));
    return budgetChars ? splitResultsByBudget(results, budgetChars).selected : results;
  }

  recall(memory: MemorySnapshot, query: MemorySearchQuery): { memory: MemorySnapshot; results: MemorySearchResult[]; excludedResults: MemorySearchResult[]; block?: string; budgetChars: number; usedChars: number; injected: boolean } {
    const budgetChars = clampNumber(query.budgetChars ?? 6000, 500, 50_000);
    const replay = this.replayRecall(memory, { ...query, query: query.query || "", budgetChars });
    const results = replay.results;
    const usedChars = estimateMemoryBlockLength(results);
    if (!results.length) {
      return { memory, results, excludedResults: replay.excludedResults, budgetChars, usedChars: 0, injected: false };
    }
    const touchedAt = this.host.nowIso();
    const ids = new Set(results.map((item) => item.id));
    const next = {
      ...memory,
      pages: memory.pages.map((page) => ids.has(page.id) ? { ...page, lastAccessedAt: touchedAt, accessCount: page.accessCount + 1 } : page),
      facts: memory.facts.map((fact) => ids.has(fact.id) ? { ...fact, lastAccessedAt: touchedAt, accessCount: fact.accessCount + 1 } : fact)
    };
    return {
      memory: next,
      results,
      excludedResults: replay.excludedResults,
      block: formatMemoryBlock(results),
      budgetChars,
      usedChars,
      injected: true
    };
  }

  replayRecall(memory: MemorySnapshot, input: MemoryReplayRecallInput): MemoryReplayRecallResult {
    const budgetChars = clampNumber(input.budgetChars ?? 6000, 500, 50_000);
    const limit = clampNumber(input.limit ?? 12, 1, 100);
    const ranked = rankMemoryResults(memory, input, limit, this.matchesScope.bind(this));
    const split = splitResultsByBudget(ranked, budgetChars);
    const history = input.recallId ? memory.recallHistory.find((item) => item.id === input.recallId) : undefined;
    const currentIds = split.selected.map((item) => item.id);
    const previousIds = history?.resultIds || [];
    return {
      query: input.query,
      recallId: input.recallId,
      results: split.selected,
      excludedResults: split.excluded,
      blockPreview: split.selected.length ? formatMemoryBlock(split.selected) : undefined,
      budgetChars,
      usedChars: estimateMemoryBlockLength(split.selected),
      comparedTo: history
        ? {
            resultIds: previousIds,
            addedIds: currentIds.filter((id) => !previousIds.includes(id)),
            removedIds: previousIds.filter((id) => !currentIds.includes(id))
          }
        : undefined
    };
  }

  recordFeedback(memory: MemorySnapshot, input: MemoryRecallFeedbackInput): { memory: MemorySnapshot; feedback: MemoryRecallFeedback } {
    const createdAt = this.host.nowIso();
    const feedback: MemoryRecallFeedback = {
      id: this.host.randomId("mem_feedback"),
      memoryId: input.memoryId,
      kind: input.kind,
      query: input.query,
      recallId: input.recallId,
      note: input.note,
      createdAt
    };
    return {
      memory: {
        ...memory,
        recallFeedback: [feedback, ...(memory.recallFeedback || [])].slice(0, 300)
      },
      feedback
    };
  }

  recordRecall(memory: MemorySnapshot, record: MemoryRecallRecord): MemorySnapshot {
    return {
      ...memory,
      recallHistory: [
        record,
        ...(memory.recallHistory || []).filter((item) => item.id !== record.id)
      ].slice(0, 100)
    };
  }

  add(memory: MemorySnapshot, input: MemoryAddInput): { memory: MemorySnapshot; record: MemoryPage | MemoryFact } {
    const createdAt = this.host.nowIso();
    const base = {
      id: this.host.randomId(input.type === "page" ? "mem_page" : "mem_fact"),
      scope: input.scope,
      conversationId: input.conversationId,
      subagentName: input.subagentName,
      title: input.title.trim(),
      content: input.content.trim(),
      source: input.source?.trim() || "manual",
      status: "active" as MemoryRecordStatus,
      keywords: normalizeKeywords(input.keywords, `${input.title} ${input.content}`),
      createdAt,
      updatedAt: createdAt,
      accessCount: 0
    };
    const record = input.type === "page"
      ? { ...base, type: "page" as const }
      : {
          ...base,
          type: "fact" as const,
          kind: normalizeFactKind(input.kind),
          confidence: clampNumber(input.confidence ?? 0.7, 0, 1)
        };
    const chunks = chunkRecord(record, this.host.randomId, createdAt);
    return {
      memory: {
        ...memory,
        pages: record.type === "page" ? [record, ...memory.pages] : memory.pages,
        facts: record.type === "fact" ? [record, ...memory.facts] : memory.facts,
        chunks: [...chunks, ...memory.chunks]
      },
      record
    };
  }

  update(memory: MemorySnapshot, id: string, input: MemoryUpdateInput): { memory: MemorySnapshot; record?: MemoryPage | MemoryFact } {
    const updatedAt = this.host.nowIso();
    let updated: MemoryPage | MemoryFact | undefined;
    const updateBase = <T extends MemoryPage | MemoryFact>(record: T): T => {
      const next = {
        ...record,
        title: input.title?.trim() || record.title,
        content: input.content?.trim() || record.content,
        status: input.status || record.status,
        scope: input.scope || record.scope,
        conversationId: input.conversationId === undefined ? record.conversationId : input.conversationId,
        subagentName: input.subagentName === undefined ? record.subagentName : input.subagentName,
        keywords: input.keywords ? normalizeKeywords(input.keywords, `${input.title || record.title} ${input.content || record.content}`) : record.keywords,
        updatedAt
      } as T;
      if (next.type === "fact") {
        next.kind = normalizeFactKind(input.kind || next.kind);
        next.confidence = clampNumber(input.confidence ?? next.confidence, 0, 1);
      }
      updated = next;
      return next;
    };
    const pages = memory.pages.map((page) => page.id === id ? updateBase(page) : page);
    const facts = memory.facts.map((fact) => fact.id === id ? updateBase(fact) : fact);
    const chunks = updated
      ? [...chunkRecord(updated, this.host.randomId, updatedAt), ...memory.chunks.filter((chunk) => chunk.memoryId !== id)]
      : memory.chunks;
    return { memory: { ...memory, pages, facts, chunks }, record: updated };
  }

  delete(memory: MemorySnapshot, id: string): MemorySnapshot {
    return {
      ...memory,
      pages: memory.pages.filter((page) => page.id !== id),
      facts: memory.facts.filter((fact) => fact.id !== id),
      chunks: memory.chunks.filter((chunk) => chunk.memoryId !== id),
      links: memory.links.filter((link) => link.sourceId !== id && link.targetId !== id)
    };
  }

  createCandidates(memory: MemorySnapshot, input: MemoryCandidateInput): { memory: MemorySnapshot; candidates: MemoryCandidate[] } {
    const facts = extractCandidateFacts(input.summary);
    if (!facts.length) {
      return { memory, candidates: [] };
    }
    const createdAt = this.host.nowIso();
    const scope: MemoryScope = input.subagentName ? "subagent" : "conversation";
    const candidates = facts
      .filter((content) => !hasSimilarCandidateOrMemory(memory, input.conversationId, input.source, content, scope, input.subagentName))
      .map((content) => ({
        id: this.host.randomId("mem_candidate"),
        scope,
        conversationId: input.conversationId,
        subagentName: input.subagentName,
        title: candidateTitle(content),
        content,
        source: input.source,
        kind: inferFactKind(content),
        confidence: 0.62,
        keywords: normalizeKeywords(undefined, content),
        status: "pending" as const,
        createdAt,
        updatedAt: createdAt
      }));
    if (!candidates.length) {
      return { memory, candidates: [] };
    }
    return {
      memory: { ...memory, candidates: [...candidates, ...memory.candidates].slice(0, 100) },
      candidates
    };
  }

  approveCandidate(memory: MemorySnapshot, id: string): { memory: MemorySnapshot; record?: MemoryPage | MemoryFact; candidate?: MemoryCandidate } {
    const candidate = memory.candidates.find((item) => item.id === id);
    if (!candidate || candidate.status !== "pending") {
      return { memory };
    }
    const approvedAt = this.host.nowIso();
    const approved = { ...candidate, status: "approved" as const, updatedAt: approvedAt };
    const mergeTarget = findMergeTarget(memory, candidate);
    if (mergeTarget) {
      const mergedContent = mergeContent(mergeTarget.content, candidate.content);
      const merged = this.update(memory, mergeTarget.id, {
        content: mergedContent,
        title: mergeTarget.title || candidate.title,
        keywords: [...mergeTarget.keywords, ...candidate.keywords],
        confidence: mergeTarget.type === "fact" ? Math.max(mergeTarget.confidence, candidate.confidence) : candidate.confidence,
        kind: candidate.kind
      });
      return {
        memory: {
          ...merged.memory,
          candidates: merged.memory.candidates.map((item) => item.id === id ? approved : item)
        },
        record: merged.record,
        candidate: approved
      };
    }
    const result = this.add(memory, {
      type: "fact",
      scope: candidate.scope,
      conversationId: candidate.conversationId,
      subagentName: candidate.subagentName,
      title: candidate.title,
      content: candidate.content,
      source: candidate.source,
      kind: candidate.kind,
      confidence: candidate.confidence,
      keywords: candidate.keywords
    });
    return {
      memory: {
        ...result.memory,
        candidates: result.memory.candidates.map((item) => item.id === id ? approved : item)
      },
      record: result.record.type === "fact" ? result.record : undefined,
      candidate: approved
    };
  }

  denyCandidate(memory: MemorySnapshot, id: string): { memory: MemorySnapshot; candidate?: MemoryCandidate } {
    const deniedAt = this.host.nowIso();
    let denied: MemoryCandidate | undefined;
    return {
      memory: {
        ...memory,
        candidates: memory.candidates.map((candidate) => {
          if (candidate.id !== id) {
            return candidate;
          }
          denied = { ...candidate, status: "denied", updatedAt: deniedAt };
          return denied;
        })
      },
      candidate: denied
    };
  }

  candidateFromCompact(memory: MemorySnapshot, boundary: CompactBoundary, subagentName?: string): { memory: MemorySnapshot; candidates: MemoryCandidate[] } {
    return this.createCandidates(memory, {
      conversationId: boundary.conversationId,
      subagentName,
      source: `compact:${boundary.id}`,
      summary: boundary.summary
    });
  }

  exportSnapshot(memory: MemorySnapshot, exportedAt = this.host.nowIso()): MemoryTransfer {
    return {
      version: 1,
      exportedAt,
      memory: cloneMemory(memory)
    };
  }

  importSnapshot(current: MemorySnapshot, input: MemoryImportInput): MemoryImportResult {
    const incoming = normalizeIncomingMemory("version" in input.data ? input.data.memory : input.data);
    const mode = input.mode === "replace" ? "replace" : "merge";
    const memory = mode === "replace" ? incoming : mergeMemory(current, incoming);
    return {
      memory,
      mode,
      imported: {
        pages: incoming.pages.length,
        facts: incoming.facts.length,
        chunks: incoming.chunks.length,
        links: incoming.links.length,
        candidates: incoming.candidates.length,
        recallHistory: incoming.recallHistory.length,
        recallFeedback: incoming.recallFeedback.length
      }
    };
  }

  private matchesScope(record: MemoryPage | MemoryFact, query: MemorySearchQuery): boolean {
    if (query.scope && query.scope !== "all" && record.scope !== query.scope) {
      return false;
    }
    if (record.scope === "global") {
      return true;
    }
    if (record.scope === "conversation") {
      return query.conversationId
        ? record.conversationId === query.conversationId
        : query.scope === "conversation" || query.scope === "all";
    }
    if (record.scope === "subagent") {
      return query.subagentName
        ? record.subagentName === query.subagentName
        : query.scope === "subagent" || (query.scope === "all" && !query.conversationId);
    }
    return false;
  }
}

function formatMemoryBlock(results: MemorySearchResult[]): string {
  return [
    "<memory>",
    ...results.map((item, index) => [
      `#${index + 1} [${item.scope}${item.subagentName ? `:@${item.subagentName}` : ""}] ${item.title}`,
      `Source: ${item.sourceLabel}`,
      `Why recalled: ${item.reason}`,
      item.content
    ].join("\n")),
    "</memory>"
  ].join("\n\n");
}

function scoreRecord(record: MemoryPage | MemoryFact, terms: string[]): number {
  const text = `${record.title} ${record.content} ${record.keywords.join(" ")}`.toLowerCase();
  const termScore = terms.length
    ? terms.reduce((score, term) => score + (text.includes(term) ? 2 : 0) + record.keywords.filter((keyword) => keyword === term).length, 0)
    : 1;
  const ageMs = Date.now() - Date.parse(record.updatedAt);
  const recency = Number.isFinite(ageMs) ? Math.max(0.15, 1 - ageMs / (1000 * 60 * 60 * 24 * 90)) : 0.5;
  return termScore + recency + Math.min(record.accessCount * 0.02, 0.3);
}

function latestFeedback(memory: MemorySnapshot, memoryId: string): MemoryRecallFeedback | undefined {
  return (memory.recallFeedback || []).find((item) => item.memoryId === memoryId);
}

function feedbackScore(kind?: MemoryRecallFeedback["kind"]): number {
  if (kind === "useful") {
    return 1.25;
  }
  if (kind === "irrelevant") {
    return -3;
  }
  if (kind === "stale") {
    return -2;
  }
  if (kind === "wrong") {
    return -5;
  }
  return 0;
}

function matchedKeywords(record: MemoryPage | MemoryFact, terms: string[]): string[] {
  const text = `${record.title} ${record.content}`.toLowerCase();
  const keywords = new Set(record.keywords.map((keyword) => keyword.toLowerCase()));
  return [...new Set(terms.filter((term) => text.includes(term) || keywords.has(term)))].slice(0, 12);
}

function recallReason(matches: string[], score: number, feedback?: MemoryRecallFeedback["kind"]): string {
  if (matches.length) {
    return `${feedback ? `${feedback} feedback; ` : ""}Matched ${matches.slice(0, 5).join(", ")}`;
  }
  return feedback ? `${feedback} feedback` : score > 1 ? "Recent active memory" : "Scope match";
}

function sourceLabel(source: string): string {
  if (source.startsWith("compact:")) {
    return "Compact summary";
  }
  if (source === "manual") {
    return "Manual memory";
  }
  if (source.startsWith("import:")) {
    return "Imported memory";
  }
  return source || "Memory";
}

function rankMemoryResults(
  memory: MemorySnapshot,
  query: MemorySearchQuery,
  limit: number,
  matchesScope: (record: MemoryPage | MemoryFact, query: MemorySearchQuery) => boolean
): MemorySearchResult[] {
  const terms = tokenize(query.query || "");
  const records: Array<MemoryPage | MemoryFact> = [
    ...memory.pages,
    ...memory.facts
  ].filter((record) => matchesScope(record, query))
    .filter((record) => !(query.excludeSources || []).includes(record.source))
    .filter((record) => query.includeDisabled || record.status === "active");

  return records
    .map((record) => {
      const matches = matchedKeywords(record, terms);
      const feedback = latestFeedback(memory, record.id);
      const score = scoreRecord(record, terms) + feedbackScore(feedback?.kind);
      return { record, score, matchedKeywords: matches, feedback };
    })
    .filter((item) => !terms.length || item.score > 0)
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .slice(0, limit)
    .map(({ record, score, matchedKeywords, feedback }) => ({
      id: record.id,
      type: record.type,
      scope: record.scope,
      conversationId: record.conversationId,
      subagentName: record.subagentName,
      title: record.title,
      content: record.content,
      source: record.source,
      keywords: record.keywords,
      score,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastAccessedAt: record.lastAccessedAt,
      status: record.status,
      matchedKeywords,
      reason: recallReason(matchedKeywords, score, feedback?.kind),
      sourceLabel: sourceLabel(record.source),
      feedback: feedback?.kind
    }));
}

function splitResultsByBudget(results: MemorySearchResult[], budgetChars: number): { selected: MemorySearchResult[]; excluded: MemorySearchResult[] } {
  const selected: MemorySearchResult[] = [];
  const excluded: MemorySearchResult[] = [];
  let used = "<memory>\n</memory>".length;
  for (const result of results) {
    const nextLength = formatMemoryEntry(result, selected.length).length + 2;
    if (selected.length && used + nextLength > budgetChars) {
      excluded.push(result);
      continue;
    }
    if (!selected.length && used + nextLength > budgetChars) {
      selected.push({
        ...result,
        content: result.content.slice(0, Math.max(80, budgetChars - used - 180)).trimEnd()
      });
      break;
    }
    selected.push(result);
    used += nextLength;
  }
  return { selected, excluded };
}

function estimateMemoryBlockLength(results: MemorySearchResult[]): number {
  return formatMemoryBlock(results).length;
}

function formatMemoryEntry(item: MemorySearchResult, index: number): string {
  return [
    `#${index + 1} [${item.scope}${item.subagentName ? `:@${item.subagentName}` : ""}] ${item.title}`,
    `Source: ${item.sourceLabel}`,
    `Why recalled: ${item.reason}`,
    item.content
  ].join("\n");
}

function chunkRecord(record: MemoryPage | MemoryFact, randomId: (prefix: string) => string, createdAt: string) {
  const chunks = splitChunks(record.content, 700);
  return chunks.map((content, index) => ({
    id: randomId("mem_chunk"),
    memoryId: record.id,
    memoryType: record.type,
    ordinal: index,
    heading: index === 0 ? record.title : `${record.title} (${index + 1})`,
    content,
    keywords: normalizeKeywords(record.keywords, content),
    createdAt
  }));
}

function splitChunks(content: string, maxLength: number): string[] {
  const text = content.trim();
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength).trim());
  }
  return chunks.filter(Boolean);
}

function normalizeKeywords(input: string[] | undefined, text: string): string[] {
  const words = input?.length ? input : tokenize(text);
  return [...new Set(words.map((word) => word.toLowerCase()).filter((word) => word.length >= 2))].slice(0, 16);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 64) || [];
}

function normalizeFactKind(kind: MemoryFactKind | undefined): MemoryFactKind {
  return kind === "preference" || kind === "decision" || kind === "task" || kind === "warning" || kind === "fact" ? kind : "fact";
}

function inferFactKind(text: string): MemoryFactKind {
  const lower = text.toLowerCase();
  if (lower.includes("prefer") || lower.includes("preference") || lower.includes("喜欢") || lower.includes("偏好")) {
    return "preference";
  }
  if (lower.includes("decision") || lower.includes("decided") || lower.includes("决定")) {
    return "decision";
  }
  if (lower.includes("todo") || lower.includes("task") || lower.includes("next") || lower.includes("任务")) {
    return "task";
  }
  if (lower.includes("warning") || lower.includes("risk") || lower.includes("风险")) {
    return "warning";
  }
  return "fact";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function candidateTitle(content: string): string {
  return firstLine(content).slice(0, 80) || "Conversation memory";
}

function hasSimilarCandidateOrMemory(memory: MemorySnapshot, conversationId: string, source: string, content: string, scope: MemoryScope, subagentName?: string): boolean {
  const normalized = normalizeForSimilarity(content);
  const sameScope = (record: { scope: MemoryScope; conversationId?: string; subagentName?: string }) => record.scope === scope
    && record.conversationId === conversationId
    && (scope !== "subagent" || record.subagentName === subagentName);
  return memory.candidates.some((candidate) => sameScope(candidate)
      && (candidate.source === source || textSimilarity(normalized, normalizeForSimilarity(candidate.content)) >= 0.82))
    || [...memory.pages, ...memory.facts].some((record) => sameScope(record)
      && textSimilarity(normalized, normalizeForSimilarity(record.content)) >= 0.82);
}

function findMergeTarget(memory: MemorySnapshot, candidate: MemoryCandidate): MemoryPage | MemoryFact | undefined {
  const normalized = normalizeForSimilarity(candidate.content);
  return [...memory.facts, ...memory.pages]
    .filter((record) => record.status === "active"
      && record.scope === candidate.scope
      && record.conversationId === candidate.conversationId
      && (record.scope !== "subagent" || record.subagentName === candidate.subagentName))
    .map((record) => ({ record, similarity: textSimilarity(normalized, normalizeForSimilarity(record.content)), keywordOverlap: overlapCount(record.keywords, candidate.keywords) }))
    .filter((item) => item.similarity >= 0.72 || item.keywordOverlap >= 3)
    .sort((left, right) => right.similarity - left.similarity || right.keywordOverlap - left.keywordOverlap)[0]?.record;
}

function mergeContent(current: string, next: string): string {
  if (normalizeForSimilarity(current).includes(normalizeForSimilarity(next))) {
    return current;
  }
  return `${current.trim()}\n\n${next.trim()}`.trim();
}

function extractCandidateFacts(summary: string): string[] {
  const cleaned = summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").replace(/^(?:user|assistant|system):\s*/i, "").trim())
    .filter(Boolean)
    .join("\n");
  const pieces = cleaned
    .split(/(?:[。！？!?]\s*|\.\s+|\r?\n+)/)
    .map((piece) => piece.trim())
    .map((piece) => piece.replace(/\s+/g, " "))
    .filter((piece) => piece.length >= 40 && piece.length <= 420)
    .filter((piece) => !isTransientMemory(piece));
  const unique: string[] = [];
  for (const piece of pieces.length ? pieces : [cleaned]) {
    const content = piece.length > 420 ? `${piece.slice(0, 417).trimEnd()}...` : piece;
    if (content.length >= 40 && !isTransientMemory(content) && !unique.some((item) => textSimilarity(normalizeForSimilarity(item), normalizeForSimilarity(content)) >= 0.82)) {
      unique.push(content);
    }
    if (unique.length >= 6) {
      break;
    }
  }
  return unique;
}

function isTransientMemory(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "exit code",
    "stack trace",
    "temporary",
    "one-time",
    "shell output",
    "tool error",
    "permission denied",
    "npm run",
    "build failed",
    "failed with",
    "queued locally",
    "is thinking"
  ].some((marker) => lower.includes(marker));
}

function normalizeForSimilarity(text: string): string {
  return tokenize(text).join(" ");
}

function textSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  return left.filter((item) => rightSet.has(item.toLowerCase())).length;
}

function cloneMemory(memory: MemorySnapshot): MemorySnapshot {
  return {
    pages: memory.pages.map((item) => ({ ...item, keywords: [...item.keywords] })),
    facts: memory.facts.map((item) => ({ ...item, keywords: [...item.keywords] })),
    chunks: memory.chunks.map((item) => ({ ...item, keywords: [...item.keywords] })),
    links: memory.links.map((item) => ({ ...item })),
    candidates: memory.candidates.map((item) => ({ ...item, keywords: [...item.keywords] })),
    recallHistory: (memory.recallHistory || []).map((item) => ({
      ...item,
      resultIds: [...item.resultIds],
      results: item.results.map((result) => ({ ...result, matchedKeywords: [...result.matchedKeywords] })),
      excludedResults: item.excludedResults?.map((result) => ({ ...result, matchedKeywords: [...result.matchedKeywords] }))
    })),
    recallFeedback: (memory.recallFeedback || []).map((item) => ({ ...item }))
  };
}

function normalizeIncomingMemory(memory: MemorySnapshot): MemorySnapshot {
  return {
    pages: Array.isArray(memory.pages) ? memory.pages : [],
    facts: Array.isArray(memory.facts) ? memory.facts : [],
    chunks: Array.isArray(memory.chunks) ? memory.chunks : [],
    links: Array.isArray(memory.links) ? memory.links : [],
    candidates: Array.isArray(memory.candidates) ? memory.candidates : [],
    recallHistory: Array.isArray(memory.recallHistory) ? memory.recallHistory : [],
    recallFeedback: Array.isArray(memory.recallFeedback) ? memory.recallFeedback : []
  };
}

function mergeMemory(current: MemorySnapshot, incoming: MemorySnapshot): MemorySnapshot {
  return {
    pages: mergeById(current.pages, incoming.pages),
    facts: mergeById(current.facts, incoming.facts),
    chunks: mergeById(current.chunks, incoming.chunks),
    links: mergeById(current.links, incoming.links),
    candidates: mergeById(current.candidates, incoming.candidates),
    recallHistory: mergeById(current.recallHistory || [], incoming.recallHistory || []).slice(0, 100),
    recallFeedback: mergeById(current.recallFeedback || [], incoming.recallFeedback || []).slice(0, 300)
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...incoming, ...current]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

function fallbackId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
