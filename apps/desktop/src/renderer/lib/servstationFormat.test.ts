import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ServstationConversation, ServstationSessionJob } from "@supbot/shared";
import {
  extractServstationGeneratedFiles,
  servstationMessagesFromJobs,
  servstationMessagesFromTranscript,
} from "./servstationFormat";

function completedJob(result: unknown): ServstationSessionJob {
  return {
    id: "job-1",
    agentInstanceId: "agent-1",
    requestId: "request-1",
    clientId: "client-1",
    jobType: "interactive",
    conversationId: "conversation-1",
    status: "completed",
    queuePosition: 0,
    payload: { prompt: "Create the report" },
    result,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("Servstation generated files", () => {
  it("normalizes aliases, strings, paths, sizes, and duplicate ids", () => {
    expect(
      extractServstationGeneratedFiles({
        generatedFiles: [
          {
            file_id: "file-report",
            relative_path: "reports/final report.pdf",
            file_name: "final report.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
            sha256sum: "abc123",
          },
          "exports/data.csv",
          { id: "file-report", name: "duplicate.pdf" },
          { name: "missing-id.pdf" },
        ],
      }),
    ).toEqual([
      {
        fileId: "file-report",
        fileName: "final report.pdf",
        relativePath: "reports/final report.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        sha256: "abc123",
      },
      {
        fileId: "exports/data.csv",
        fileName: "data.csv",
        relativePath: "exports/data.csv",
        contentType: "application/octet-stream",
        sizeBytes: 0,
      },
    ]);
  });

  it("filters common scripts case-insensitively while keeping notebooks and documents", () => {
    const files = extractServstationGeneratedFiles({
      files: ["scripts/build.PY", "scripts/deploy.ps1", "scripts/process.lua", "analysis.ipynb", "report.docx"],
    });

    expect(files?.map((file) => file.fileName)).toEqual(["analysis.ipynb", "report.docx"]);
  });

  it("accepts the generated_files result alias", () => {
    expect(
      extractServstationGeneratedFiles({
        generated_files: [{ file_id: "file-1", file_name: "report.pdf" }],
      })?.[0]?.fileName,
    ).toBe("report.pdf");
  });

  it("attaches completed job files to generated and historical agent messages", () => {
    const job = completedJob({ assistantText: "Done", files: [{ fileId: "file-1", fileName: "report.pdf" }] });
    expect(servstationMessagesFromJobs([job])[1].generatedFiles?.[0]?.fileName).toBe("report.pdf");

    const transcript: NonNullable<ServstationConversation["messages"]> = [
      {
        id: "message-1",
        role: "agent",
        text: "Historical result",
        status: "completed",
        jobId: job.id,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ];
    expect(servstationMessagesFromTranscript(transcript, [job])[0].generatedFiles?.[0]?.fileId).toBe("file-1");
  });

  it("does not expose files from unfinished jobs", () => {
    const job = { ...completedJob({ files: ["report.pdf"] }), status: "running" };
    expect(servstationMessagesFromJobs([job])[1].generatedFiles).toBeUndefined();
  });

  it("wires result links to the authenticated desktop download bridge", () => {
    const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

    expect(source).toContain("window.supbot.fetchServstationJobFile(jobId, file.fileId)");
    expect(source).toContain('className="server-agent-result-files"');
    expect(source).toContain("data-testid={`server-agent-result-file-${item.jobId}-${file.fileId}`}");
    expect(source).toContain("downloadServstationJobFile(content, file.fileName)");
  });
});
