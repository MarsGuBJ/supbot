import type {
  AutopilotPlan,
  AutopilotRun,
  AutopilotStage,
  AutopilotTask,
  AutopilotTaskKind,
  AutopilotValidatorSpec,
  DataSourceSpec
} from "@supbot/shared";

interface AutopilotOrchestratorHost {
  randomId(prefix: string): string;
  nowIso(): string;
}

type StageDefinition = {
  key: string;
  stage: AutopilotStage;
  kind: AutopilotTaskKind;
  staffAgent: string;
  title: string;
  instruction: string;
  risk?: AutopilotTask["risk"];
  allowedTools?: string[];
  validators?: AutopilotValidatorSpec[];
  dependsOn?: string[];
};

const profiles: Record<Exclude<NonNullable<AutopilotRun["resolvedProfile"]>, "auto">, StageDefinition[]> = {
  data: [
    stage("clarify", "clarify", "inspect", "collector", "Clarify data objective", "Restate the objective, deliverables, and acceptance checks. Resolve minor ambiguity with the safest useful assumption."),
    stage("inventory", "inventory", "inspect", "collector", "Inventory data sources", "Inspect configured sources and the project folder. Record the exact files, URLs, commands, or MCP tools that will be used.", ["clarify"]),
    stage("collect", "collect", "collect", "collector", "Collect raw data", "Collect raw source data into datasets/raw and preserve source provenance.", ["inventory"], "medium", ["ReadFile", "WriteFile", "Shell", "mcp.*"]),
    stage("process", "process", "modify", "processor", "Clean and process data", "Clean, deduplicate, normalize, or transform raw data into datasets/processed and document transformations.", ["collect"], "medium"),
    stage("analyze", "analyze", "analyze", "analyst", "Analyze processed data", "Write evidence-backed findings into outputs. Every finding must cite files or tool results.", ["process"]),
    stage("report", "report", "produce", "analyst", "Write final report", "Write a final report into reports with goal, sources, methods, findings, limitations, and evidence paths.", ["analyze"], "low", undefined, [artifactValidator("data-report", "reports")]),
    stage("review", "review", "review", "reviewer", "Review evidence ledger", "Review the report against the objective, acceptance criteria, and evidence. Flag unsupported claims or missing artifacts.", ["report"], "low", ["ReadFile"], [modelValidator("data-review")])
  ],
  coding: [
    stage("clarify", "clarify", "inspect", "builder", "Clarify implementation objective", "Restate the requested behavior, compatibility constraints, and machine-verifiable acceptance checks."),
    stage("inventory", "inventory", "inspect", "builder", "Inspect repository", "Inspect repository instructions, manifests, relevant modules, tests, and current behavior before editing.", ["clarify"], "low", ["ReadFile", "Shell"]),
    stage("implement", "execute", "modify", "builder", "Implement change", "Make the smallest coherent implementation in the isolated worktree and add focused tests.", ["inventory"], "medium", ["ReadFile", "WriteFile", "Shell"]),
    stage("verify", "verify", "verify", "reviewer", "Verify implementation", "Run the repository's focused tests first, then its standard verification command. Diagnose failures and report objective evidence.", ["implement"], "medium", ["ReadFile", "Shell"], [commandValidator("coding-tests", "auto")]),
    stage("review", "review", "review", "reviewer", "Review diff and acceptance criteria", "Review the worktree diff for regressions, unsafe changes, missing tests, and unmet acceptance criteria.", ["verify"], "low", ["ReadFile", "Shell"], [modelValidator("coding-review")])
  ],
  research: [
    stage("clarify", "clarify", "inspect", "research", "Clarify research question", "Define the question, deliverable, freshness requirements, and evidence standard."),
    stage("inventory", "inventory", "inspect", "research", "Inventory available sources", "Identify local sources and approved external tools. Prefer primary sources and record provenance.", ["clarify"]),
    stage("collect", "collect", "collect", "research", "Collect evidence", "Collect relevant evidence, preserving source labels, dates, and limitations.", ["inventory"], "medium", ["ReadFile", "WriteFile", "Shell", "mcp.*"]),
    stage("analyze", "analyze", "analyze", "research", "Synthesize findings", "Compare evidence, resolve conflicts, distinguish fact from inference, and identify remaining uncertainty.", ["collect"]),
    stage("report", "report", "produce", "research", "Produce research report", "Write the requested deliverable into reports with citations and limitations.", ["analyze"], "low", undefined, [artifactValidator("research-report", "reports")]),
    stage("review", "review", "review", "reviewer", "Review evidence coverage", "Check that material claims are supported and the acceptance criteria are satisfied.", ["report"], "low", ["ReadFile"], [modelValidator("research-review")])
  ],
  document: [
    stage("clarify", "clarify", "inspect", "writer", "Clarify document brief", "Define audience, deliverable, required sections, source material, and acceptance checks."),
    stage("inventory", "inventory", "inspect", "writer", "Inspect source material", "Read relevant project material and build a concise evidence outline.", ["clarify"]),
    stage("draft", "execute", "produce", "writer", "Draft document", "Create the requested document under reports or outputs with traceable source references.", ["inventory"], "low", ["ReadFile", "WriteFile"], [artifactValidator("document-output", "reports")]),
    stage("review", "review", "review", "reviewer", "Review document", "Review completeness, internal consistency, factual support, and audience fit; revise if necessary.", ["draft"], "low", ["ReadFile", "WriteFile"], [modelValidator("document-review")])
  ],
  generic: [
    stage("clarify", "clarify", "inspect", "builder", "Clarify objective", "Restate the objective, deliverables, risks, and acceptance checks."),
    stage("inventory", "inventory", "inspect", "builder", "Inspect project context", "Inspect relevant project files, tools, and constraints before choosing an action.", ["clarify"]),
    stage("execute", "execute", "produce", "builder", "Execute plan", "Produce the requested outcome inside approved project boundaries and record evidence.", ["inventory"], "medium"),
    stage("verify", "verify", "verify", "reviewer", "Verify outcome", "Run available deterministic checks and compare the result with every acceptance criterion.", ["execute"], "low", ["ReadFile", "Shell"], [modelValidator("generic-review")])
  ]
};

export class AutopilotOrchestrator {
  constructor(private readonly host: AutopilotOrchestratorHost) {}

  createTasks(run: AutopilotRun): AutopilotTask[] {
    const definitions = profiles[run.resolvedProfile || "data"];
    const maxTasks = Math.min(run.budget?.limits.maxTasks || run.writePolicy.maxTasks, definitions.length);
    const ids = new Map(definitions.slice(0, maxTasks).map((definition) => [definition.key, this.host.randomId("aptask")]));
    return definitions.slice(0, maxTasks).map((definition) => {
      const now = this.host.nowIso();
      const id = ids.get(definition.key)!;
      return {
        id,
        runId: run.id,
        projectId: run.projectId,
        stage: definition.stage,
        kind: definition.kind,
        dependsOn: (definition.dependsOn || []).map((key) => ids.get(key)).filter((value): value is string => Boolean(value)),
        risk: definition.risk || "low",
        allowedTools: definition.allowedTools || defaultTools(definition.kind),
        validators: definition.validators || [],
        staffAgent: definition.staffAgent,
        title: definition.title,
        prompt: this.buildTaskPrompt(run, definition),
        status: "queued",
        attempts: 0,
        maxAttempts: Math.max(1, run.writePolicy.maxRetries + 1),
        artifactIds: [],
        evidence: [],
        actionFingerprints: [],
        createdAt: now,
        updatedAt: now
      };
    });
  }

  createPlan(run: AutopilotRun, tasks: AutopilotTask[]): AutopilotPlan {
    const now = this.host.nowIso();
    return {
      version: (run.plan?.version || 0) + 1,
      profile: run.resolvedProfile || "generic",
      summary: `${run.resolvedProfile || "generic"} loop with ${tasks.length} dependency-ordered tasks`,
      taskIds: tasks.map((task) => task.id),
      createdAt: run.plan?.createdAt || now,
      updatedAt: now
    };
  }

  buildTaskPrompt(run: AutopilotRun, definition: StageDefinition): string {
    return [
      `Autopilot project run: ${run.title}`,
      `Profile: ${run.resolvedProfile || "generic"}`,
      `Project root: ${run.projectRoot}`,
      `Stage: ${definition.stage} - ${definition.title}`,
      "",
      "Objective:",
      run.goalSpec?.objective || run.goal,
      "",
      "Deliverables:",
      renderList(run.goalSpec?.deliverables || []),
      "",
      "Acceptance criteria:",
      renderList(run.goalSpec?.acceptanceCriteria || []),
      "",
      "Configured data sources:",
      renderDataSources(run.dataSources),
      "",
      "Stage instruction:",
      definition.instruction,
      "",
      "Rules:",
      "- Stay inside the active project workspace and approved policy boundaries.",
      "- Use objective tool results as evidence; do not claim success without verification.",
      "- Mention every material file read or changed in the final answer.",
      "- Keep the final answer concise and include evidence paths."
    ].join("\n");
  }
}

function stage(
  key: string,
  stageName: AutopilotStage,
  kind: AutopilotTaskKind,
  staffAgent: string,
  title: string,
  instruction: string,
  dependsOn: string[] = [],
  risk: AutopilotTask["risk"] = "low",
  allowedTools?: string[],
  validators?: AutopilotValidatorSpec[]
): StageDefinition {
  return { key, stage: stageName, kind, staffAgent, title, instruction, dependsOn, risk, allowedTools, validators };
}

function artifactValidator(id: string, path: string): AutopilotValidatorSpec {
  return { id, kind: "artifact_exists", label: `Artifact exists under ${path}`, path, required: true };
}

function commandValidator(id: string, command: string): AutopilotValidatorSpec {
  return { id, kind: "command", label: `Command succeeds: ${command}`, command, required: true };
}

function modelValidator(id: string): AutopilotValidatorSpec {
  return { id, kind: "model_review", label: "Semantic acceptance review", required: true };
}

function defaultTools(kind: AutopilotTaskKind): string[] {
  return kind === "inspect" || kind === "review" ? ["ReadFile", "Shell"] : ["ReadFile", "WriteFile", "Shell", "Agent", "mcp.*"];
}

function renderDataSources(dataSources: DataSourceSpec[]): string {
  if (!dataSources.length) {
    return "- No explicit sources. Inspect the project folder for relevant local context.";
  }
  return dataSources.map((source) => {
    const details = [source.path, source.paths?.join(", "), source.url, source.mcpToolName, source.shellCommand].filter(Boolean).join(" | ");
    return `- ${source.label || source.id} (${source.kind})${details ? `: ${details}` : ""}`;
  }).join("\n");
}

function renderList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- Derive the minimum useful deliverable from the objective.";
}
