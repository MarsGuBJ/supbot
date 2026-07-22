import type { AutopilotRun, AutopilotStage, AutopilotTask, DataSourceSpec } from "@supbot/shared";

interface AutopilotOrchestratorHost {
  randomId(prefix: string): string;
  nowIso(): string;
}

type StageDefinition = {
  stage: AutopilotStage;
  staffAgent: string;
  title: string;
  instruction: string;
};

const dataRunStages: StageDefinition[] = [
  {
    stage: "clarify",
    staffAgent: "collector",
    title: "Clarify data objective",
    instruction:
      "Restate the data objective, expected deliverables, and acceptance checks. If the goal is ambiguous, make the safest useful assumption and continue.",
  },
  {
    stage: "inventory",
    staffAgent: "collector",
    title: "Inventory data sources",
    instruction:
      "Inspect the configured data sources and project folder. Create a concise source inventory with paths, URLs, commands, or MCP tools that will be used.",
  },
  {
    stage: "collect",
    staffAgent: "collector",
    title: "Collect raw data",
    instruction:
      "Collect raw source data into datasets/raw. Preserve source names and write a short collection note that links every raw artifact to its source.",
  },
  {
    stage: "process",
    staffAgent: "processor",
    title: "Clean and process data",
    instruction:
      "Clean, deduplicate, normalize, or transform raw data. Write processed data into datasets/processed and document every transformation.",
  },
  {
    stage: "analyze",
    staffAgent: "analyst",
    title: "Analyze processed data",
    instruction:
      "Analyze processed data and write evidence-backed findings into outputs. Every finding must cite the files or tool results used.",
  },
  {
    stage: "report",
    staffAgent: "analyst",
    title: "Write final report",
    instruction:
      "Write a final report into reports. Include goal, data sources, methods, findings, limitations, and artifact paths.",
  },
  {
    stage: "review",
    staffAgent: "reviewer",
    title: "Review evidence ledger",
    instruction:
      "Review the report against the objective and evidence. Flag unsupported claims, missing artifacts, or incomplete acceptance criteria.",
  },
];

export class AutopilotOrchestrator {
  constructor(private readonly host: AutopilotOrchestratorHost) {}

  createTasks(run: AutopilotRun): AutopilotTask[] {
    const maxAttempts = Math.max(1, run.writePolicy.maxRetries + 1);
    return dataRunStages.slice(0, run.writePolicy.maxTasks).map((definition) => {
      const now = this.host.nowIso();
      const id = this.host.randomId("aptask");
      return {
        id,
        runId: run.id,
        projectId: run.projectId,
        stage: definition.stage,
        staffAgent: definition.staffAgent,
        title: definition.title,
        prompt: this.buildTaskPrompt(run, definition),
        status: "queued",
        attempts: 0,
        maxAttempts,
        artifactIds: [],
        evidence: [],
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  buildTaskPrompt(run: AutopilotRun, definition: StageDefinition): string {
    return [
      `Autopilot data run: ${run.title}`,
      `Project root: ${run.projectRoot}`,
      `Stage: ${definition.stage} - ${definition.title}`,
      "",
      "Goal:",
      run.goal,
      "",
      "Configured data sources:",
      renderDataSources(run.dataSources),
      "",
      "Approved project write folders:",
      run.writePolicy.allowedWriteRoots.map((root) => `- ${root}`).join("\n"),
      "",
      "Stage instruction:",
      definition.instruction,
      "",
      "Rules:",
      "- Write generated data or reports only inside approved project write folders.",
      "- Mention every file you read or write in your final answer.",
      "- Keep the final answer concise and include evidence paths.",
    ].join("\n");
  }
}

function renderDataSources(dataSources: DataSourceSpec[]): string {
  if (!dataSources.length) {
    return "- No explicit sources. Inspect the project folder and ask tools for relevant local context.";
  }
  return dataSources
    .map((source) => {
      const details = [source.path, source.paths?.join(", "), source.url, source.mcpToolName, source.shellCommand]
        .filter(Boolean)
        .join(" | ");
      return `- ${source.label || source.id} (${source.kind})${details ? `: ${details}` : ""}`;
    })
    .join("\n");
}
