import { useCallback, useEffect, useState } from "react";
import { ClockCircleOutlined, FileTextOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Checkbox, Empty, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Tag, message } from "antd";
import type { Conversation, MemoryAddInput, MemoryFactKind, MemoryReplayRecallResult, MemoryScope, MemorySearchResult, RuntimeSnapshot } from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";

export function MemoryPanel({
  snapshot,
  activeConversationId,
  refresh,
  t,
  embedded = false
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  embedded?: boolean;
}) {
  const [form] = Form.useForm<MemoryAddInput & { type: "page" | "fact" }>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [records, setRecords] = useState<MemorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transferText, setTransferText] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [memoryView, setMemoryView] = useState<"manage" | "debug">("manage");
  const [replayQuery, setReplayQuery] = useState("");
  const [replayResult, setReplayResult] = useState<MemoryReplayRecallResult | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const addScope = Form.useWatch("scope", form) || "global";
  const pendingCandidates = snapshot.memory.candidates.filter((candidate) => candidate.status === "pending");
  const recallHistory = (snapshot.memory.recallHistory || []).slice(0, 5);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.supbot.listMemory({
        query,
        scope,
        conversationId: activeConversationId || undefined,
        includeDisabled: true,
        limit: 80
      });
      setRecords(next);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeConversationId, messageApi, query, scope]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords, snapshot.memory.pages.length, snapshot.memory.facts.length, snapshot.memory.candidates.length]);

  const saveMemory = async (values: MemoryAddInput & { type: "page" | "fact" }) => {
    if (values.scope === "conversation" && !activeConversationId) {
      messageApi.warning(t("Choose a conversation before adding conversation memory."));
      return;
    }
    setSaving(true);
    try {
      await window.supbot.addMemory({
        ...values,
        conversationId: values.scope === "conversation" ? activeConversationId : undefined,
        source: "manual"
      });
      form.resetFields();
      messageApi.success(t("Memory saved."));
      await refresh();
      await loadRecords();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const approveCandidate = async (id: string) => {
    await window.supbot.approveMemoryCandidate(id);
    setSelectedCandidateIds((ids) => ids.filter((item) => item !== id));
    messageApi.success(t("Memory approved."));
    await refresh();
    await loadRecords();
  };

  const denyCandidate = async (id: string) => {
    await window.supbot.denyMemoryCandidate(id);
    setSelectedCandidateIds((ids) => ids.filter((item) => item !== id));
    messageApi.success(t("Memory candidate denied."));
    await refresh();
  };

  const approveSelectedCandidates = async () => {
    await Promise.all(selectedCandidateIds.map((id) => window.supbot.approveMemoryCandidate(id)));
    setSelectedCandidateIds([]);
    messageApi.success(t("Selected candidates approved."));
    await refresh();
    await loadRecords();
  };

  const denySelectedCandidates = async () => {
    await Promise.all(selectedCandidateIds.map((id) => window.supbot.denyMemoryCandidate(id)));
    setSelectedCandidateIds([]);
    messageApi.success(t("Selected candidates denied."));
    await refresh();
  };

  const toggleRecord = async (record: MemorySearchResult) => {
    await window.supbot.updateMemory(record.id, { status: record.status === "active" ? "disabled" : "active" });
    await refresh();
    await loadRecords();
  };

  const deleteRecord = async (id: string) => {
    await window.supbot.deleteMemory(id);
    setSelectedRecordIds((ids) => ids.filter((item) => item !== id));
    await refresh();
    await loadRecords();
  };

  const disableSelectedRecords = async () => {
    await Promise.all(selectedRecordIds.map((id) => window.supbot.updateMemory(id, { status: "disabled" })));
    setSelectedRecordIds([]);
    messageApi.success(t("Selected memory disabled."));
    await refresh();
    await loadRecords();
  };

  const deleteSelectedRecords = async () => {
    await Promise.all(selectedRecordIds.map((id) => window.supbot.deleteMemory(id)));
    setSelectedRecordIds([]);
    messageApi.success(t("Selected memory deleted."));
    await refresh();
    await loadRecords();
  };

  const toggleCandidateSelection = (id: string, checked: boolean) => {
    setSelectedCandidateIds((ids) => checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id));
  };

  const toggleRecordSelection = (id: string, checked: boolean) => {
    setSelectedRecordIds((ids) => checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id));
  };

  const exportMemory = async () => {
    const transfer = await window.supbot.exportMemory();
    setTransferText(JSON.stringify(transfer, null, 2));
    messageApi.success(t("Memory exported."));
  };

  const importMemory = async () => {
    if (!transferText.trim()) {
      messageApi.warning(t("Paste memory JSON first."));
      return;
    }
    const parsed = JSON.parse(transferText);
    const result = await window.supbot.importMemory({ data: parsed, mode: "merge" });
    messageApi.success(t("Memory imported: {count} items", {
      count: result.imported.pages + result.imported.facts + result.imported.candidates
    }));
    await refresh();
    await loadRecords();
  };

  const backupMemory = async () => {
    const file = await window.supbot.backupMemory();
    messageApi.success(t("Memory backup saved: {path}", { path: file.path }));
  };

  const restoreMemory = async () => {
    const result = await window.supbot.restoreMemory();
    messageApi.success(t("Memory restored: {count} items", {
      count: result.imported.pages + result.imported.facts + result.imported.candidates
    }));
    setSelectedCandidateIds([]);
    setSelectedRecordIds([]);
    await refresh();
    await loadRecords();
  };

  const replayRecall = async (queryText = replayQuery, recallId?: string) => {
    const text = queryText.trim();
    if (!text) {
      messageApi.warning(t("Enter a recall query first."));
      return;
    }
    setReplayLoading(true);
    try {
      const result = await window.supbot.replayMemoryRecall({
        query: text,
        recallId,
        scope,
        conversationId: activeConversationId || undefined,
        limit: 12,
        budgetChars: 1600
      });
      setReplayResult(result);
      setReplayQuery(text);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setReplayLoading(false);
    }
  };

  const addRecallFeedback = async (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => {
    await window.supbot.addMemoryRecallFeedback({
      memoryId,
      kind,
      query: replayResult?.query || replayQuery,
      recallId: replayResult?.recallId
    });
    messageApi.success(t("Recall feedback saved."));
    if (replayResult) {
      await replayRecall(replayResult.query, replayResult.recallId);
    }
    await refresh();
  };

  return (
    <div className={`memory-panel ${embedded ? "is-embedded" : "activity-list"}`}>
      {contextHolder}
      <div className="memory-summary">
        <div className="activity-head">
          <strong>{t("Local memory")}</strong>
          <Tag>{snapshot.memory.facts.length + snapshot.memory.pages.length} {t("items")}</Tag>
        </div>
        <div className="stat-grid">
          <div className="mini-stat"><span>{t("Pending")}</span><strong>{pendingCandidates.length}</strong></div>
          <div className="mini-stat"><span>{t("Chunks")}</span><strong>{snapshot.memory.chunks.length}</strong></div>
        </div>
        <Segmented
          value={memoryView}
          onChange={(value) => setMemoryView(value as "manage" | "debug")}
          options={[
            { label: t("Manage"), value: "manage" },
            { label: t("Recall debug"), value: "debug" }
          ]}
        />
      </div>

      {memoryView === "debug" ? (
        <MemoryRecallDebug
          activeConversationId={activeConversationId}
          recallHistory={recallHistory}
          replayQuery={replayQuery}
          setReplayQuery={setReplayQuery}
          replayResult={replayResult}
          replayLoading={replayLoading}
          replayRecall={replayRecall}
          addRecallFeedback={addRecallFeedback}
          t={t}
        />
      ) : (
        <>

      {pendingCandidates.length ? (
        <div className="memory-candidate-list">
          <div className="activity-head">
            <div className="section-title"><FileTextOutlined /> {t("Memory candidates")}</div>
            <Space>
              <Button size="small" type="primary" disabled={!selectedCandidateIds.length} onClick={() => void approveSelectedCandidates()}>{t("Approve selected")}</Button>
              <Button size="small" danger disabled={!selectedCandidateIds.length} onClick={() => void denySelectedCandidates()}>{t("Deny selected")}</Button>
            </Space>
          </div>
          {pendingCandidates.map((candidate) => (
            <div className="memory-candidate-card" key={candidate.id}>
              <div className="memory-select-row">
                <Checkbox
                  checked={selectedCandidateIds.includes(candidate.id)}
                  onChange={(event) => toggleCandidateSelection(candidate.id, event.target.checked)}
                />
                <div className="memory-card-body">
                  <div className="activity-head">
                    <strong>{candidate.title}</strong>
                    <Tag color="gold">{t(candidate.kind)}</Tag>
                  </div>
                  <div className="tag-row">
                    <Tag>{t(candidate.scope)}</Tag>
                    {candidate.subagentName ? <Tag>@{candidate.subagentName}</Tag> : null}
                    <Tag>{Math.round(candidate.confidence * 100)}%</Tag>
                  </div>
                  <p>{candidate.content}</p>
                  <Space>
                    <Button size="small" type="primary" onClick={() => void approveCandidate(candidate.id)}>{t("Approve")}</Button>
                    <Button size="small" danger onClick={() => void denyCandidate(candidate.id)}>{t("Deny")}</Button>
                  </Space>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="memory-recall-history">
        <div className="section-title"><ClockCircleOutlined /> {t("Recent recall")}</div>
        {recallHistory.map((item) => (
          <div className="memory-recall-item" key={item.id}>
            <div className="activity-head">
              <strong>{item.query || t("No query text")}</strong>
              <Tag color={item.injected ? "cyan" : "default"}>{item.injected ? t("Injected") : t("Not injected")}</Tag>
            </div>
            <small>{formatDateTime(item.createdAt)} · {item.resultCount} {t("hits")} · {item.usedChars}/{item.budgetChars} chars</small>
            {item.results.slice(0, 3).map((result) => (
              <div className="memory-recall-hit" key={`${item.id}-${result.id}`}>
                <span>{result.title}</span>
                <small>{result.reason} · {result.sourceLabel} · {result.score.toFixed(2)}</small>
              </div>
            ))}
          </div>
        ))}
        {!recallHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No recall history")} /> : null}
      </div>

      <div className="memory-search-row">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={() => void loadRecords()} placeholder={t("Search memory")} allowClear />
        <Select
          value={scope}
          onChange={(value) => setScope(value)}
          options={memoryScopeOptions(t, true)}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRecords()}>{t("Search")}</Button>
      </div>

      <Form
        className="memory-form"
        form={form}
        layout="vertical"
        initialValues={{ type: "fact", scope: "global", kind: "fact", confidence: 0.75 }}
        onFinish={(values) => void saveMemory(values)}
      >
        <div className="memory-form-grid">
          <Form.Item name="type" label={t("Type")} rules={[{ required: true }]}>
            <Segmented options={[{ label: t("Fact"), value: "fact" }, { label: t("Page"), value: "page" }]} />
          </Form.Item>
          <Form.Item name="scope" label={t("Scope")} rules={[{ required: true }]}>
            <Select options={memoryScopeOptions(t, false)} />
          </Form.Item>
        </div>
        {addScope === "subagent" ? (
          <Form.Item name="subagentName" label={t("Subagent")} rules={[{ required: true }]}>
            <Select options={snapshot.subagents.map((subagent) => ({ label: `@${subagent.name}`, value: subagent.name }))} />
          </Form.Item>
        ) : null}
        <Form.Item name="title" label={t("Title")} rules={[{ required: true }]}>
          <Input placeholder={t("Memory title")} />
        </Form.Item>
        <Form.Item name="content" label={t("Content")} rules={[{ required: true }]}>
          <Input.TextArea rows={3} placeholder={t("What should HBClient remember?")} />
        </Form.Item>
        <div className="memory-form-grid">
          <Form.Item name="kind" label={t("Kind")}>
            <Select options={memoryKindOptions(t)} />
          </Form.Item>
          <Form.Item name="confidence" label={t("Confidence")}>
            <InputNumber min={0} max={1} step={0.05} />
          </Form.Item>
        </div>
        <Button htmlType="submit" type="primary" icon={<PlusOutlined />} loading={saving}>{t("Add memory")}</Button>
      </Form>

      <div className="memory-record-list">
        <div className="activity-head">
          <div className="section-title"><FileTextOutlined /> {t("Memory items")}</div>
          <Space>
            <Button size="small" disabled={!selectedRecordIds.length} onClick={() => void disableSelectedRecords()}>{t("Disable selected")}</Button>
            <Popconfirm title={t("Delete selected memory?")} onConfirm={() => void deleteSelectedRecords()}>
              <Button size="small" danger disabled={!selectedRecordIds.length}>{t("Delete selected")}</Button>
            </Popconfirm>
          </Space>
        </div>
        {records.map((record) => (
          <div className={`memory-record status-${record.status}`} key={record.id}>
            <div className="memory-select-row">
              <Checkbox
                checked={selectedRecordIds.includes(record.id)}
                onChange={(event) => toggleRecordSelection(record.id, event.target.checked)}
              />
              <div className="memory-card-body">
                <div className="activity-head">
                  <strong>{record.title}</strong>
                  <Tag color={record.status === "active" ? "cyan" : "default"}>{t(record.status)}</Tag>
                </div>
                <div className="tag-row">
                  <Tag>{t(record.type)}</Tag>
                  <Tag>{t(record.scope)}</Tag>
                  {record.subagentName ? <Tag>@{record.subagentName}</Tag> : null}
                  <Tag>{t("score")}: {record.score.toFixed(2)}</Tag>
                  <Tag>{record.sourceLabel}</Tag>
                </div>
                <div className="memory-reason">{record.reason}</div>
                <p>{record.content}</p>
                <div className="memory-keywords">
                  {record.matchedKeywords.map((keyword) => <Tag color="cyan" key={`${record.id}-match-${keyword}`}>{keyword}</Tag>)}
                  {record.keywords.slice(0, 6).map((keyword) => <Tag key={`${record.id}-${keyword}`}>{keyword}</Tag>)}
                </div>
                <Space>
                  <Button size="small" onClick={() => void toggleRecord(record)}>{record.status === "active" ? t("Disable") : t("Enable")}</Button>
                  <Popconfirm title={t("Delete memory?")} onConfirm={() => void deleteRecord(record.id)}>
                    <Button size="small" danger>{t("Delete")}</Button>
                  </Popconfirm>
                </Space>
              </div>
            </div>
          </div>
        ))}
        {!records.length ? <Empty description={t("No memory items")} /> : null}
      </div>

      <div className="memory-transfer">
        <div className="activity-head">
          <div className="section-title"><SaveOutlined /> {t("Import / export")}</div>
          <Space>
            <Button size="small" onClick={() => void exportMemory()}>{t("Export")}</Button>
            <Button size="small" onClick={() => void importMemory()}>{t("Import")}</Button>
            <Button size="small" onClick={() => void backupMemory()}>{t("Backup")}</Button>
            <Popconfirm title={t("Restore latest memory backup?")} onConfirm={() => void restoreMemory()}>
              <Button size="small">{t("Restore latest")}</Button>
            </Popconfirm>
          </Space>
        </div>
        <Input.TextArea
          className="memory-transfer-box"
          rows={5}
          value={transferText}
          onChange={(event) => setTransferText(event.target.value)}
          placeholder={t("Paste exported memory JSON here")}
        />
      </div>
        </>
      )}
    </div>
  );
}

export function MemoryRecallDebug({
  activeConversationId,
  recallHistory,
  replayQuery,
  setReplayQuery,
  replayResult,
  replayLoading,
  replayRecall,
  addRecallFeedback,
  t
}: {
  activeConversationId: string;
  recallHistory: RuntimeSnapshot["memory"]["recallHistory"];
  replayQuery: string;
  setReplayQuery: (query: string) => void;
  replayResult: MemoryReplayRecallResult | null;
  replayLoading: boolean;
  replayRecall: (queryText?: string, recallId?: string) => Promise<void>;
  addRecallFeedback: (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="memory-debug-panel">
      <div className="memory-search-row">
        <Input
          value={replayQuery}
          onChange={(event) => setReplayQuery(event.target.value)}
          onPressEnter={() => void replayRecall()}
          placeholder={t("Replay recall query")}
          allowClear
        />
        <Button type="primary" loading={replayLoading} onClick={() => void replayRecall()}>{t("Replay")}</Button>
      </div>

      <div className="memory-recall-history">
        <div className="section-title"><ClockCircleOutlined /> {t("Recall history")}</div>
        {recallHistory.map((item) => (
          <div className="memory-recall-item" key={item.id}>
            <div className="activity-head">
              <strong>{item.query || t("No query text")}</strong>
              <Button size="small" onClick={() => void replayRecall(item.query, item.id)}>{t("Replay")}</Button>
            </div>
            <small>{formatDateTime(item.createdAt)} · {item.resultCount} {t("hits")} · {item.usedChars}/{item.budgetChars} chars</small>
            {item.excludedResults?.length ? <Tag color="orange">{item.excludedResults.length} {t("excluded")}</Tag> : null}
          </div>
        ))}
        {!recallHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={activeConversationId ? t("No recall history") : t("No conversation selected")} /> : null}
      </div>

      {replayResult ? (
        <div className="memory-replay-result">
          <div className="activity-head">
            <strong>{t("Replay result")}</strong>
            <Tag>{replayResult.usedChars}/{replayResult.budgetChars} chars</Tag>
          </div>
          {replayResult.comparedTo ? (
            <div className="tag-row">
              <Tag color="green">+{replayResult.comparedTo.addedIds.length}</Tag>
              <Tag color="red">-{replayResult.comparedTo.removedIds.length}</Tag>
            </div>
          ) : null}
          <RecallResultList title={t("Injected")} items={replayResult.results} addRecallFeedback={addRecallFeedback} t={t} />
          <RecallResultList title={t("Excluded by budget")} items={replayResult.excludedResults} addRecallFeedback={addRecallFeedback} t={t} />
          {replayResult.blockPreview ? <pre className="memory-block-preview">{replayResult.blockPreview}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

export function RecallResultList({
  title,
  items,
  addRecallFeedback,
  t
}: {
  title: string;
  items: MemorySearchResult[];
  addRecallFeedback: (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="memory-recall-group">
      <div className="section-title">{title}</div>
      {items.map((item) => (
        <div className="memory-recall-hit is-detailed" key={`${title}-${item.id}`}>
          <div className="activity-head">
            <span>{item.title}</span>
            <Tag>{item.score.toFixed(2)}</Tag>
          </div>
          <small>{item.reason} · {item.sourceLabel}</small>
          <p>{item.content}</p>
          <div className="tag-row">
            {item.matchedKeywords.map((keyword) => <Tag color="cyan" key={`${item.id}-${keyword}`}>{keyword}</Tag>)}
            {item.feedback ? <Tag color="gold">{item.feedback}</Tag> : null}
          </div>
          <Space wrap>
            {(["useful", "irrelevant", "stale", "wrong"] as const).map((kind) => (
              <Button size="small" key={kind} onClick={() => void addRecallFeedback(item.id, kind)}>{t(kind)}</Button>
            ))}
          </Space>
        </div>
      ))}
      {!items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No items")} /> : null}
    </div>
  );
}

export function memoryScopeOptions(t: (key: string) => string, includeAll: boolean) {
  const scopes: Array<{ label: string; value: MemoryScope | "all" }> = [
    ...(includeAll ? [{ label: t("All scopes"), value: "all" as const }] : []),
    { label: t("Global"), value: "global" },
    { label: t("Conversation"), value: "conversation" },
    { label: t("Subagent"), value: "subagent" }
  ];
  return scopes;
}

export function memoryKindOptions(t: (key: string) => string): Array<{ label: string; value: MemoryFactKind }> {
  return [
    { label: t("Fact"), value: "fact" },
    { label: t("Preference"), value: "preference" },
    { label: t("Decision"), value: "decision" },
    { label: t("Task"), value: "task" },
    { label: t("Warning"), value: "warning" }
  ];
}
