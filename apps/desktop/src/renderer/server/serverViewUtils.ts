import type { ServstationSessionJob } from "@supbot/shared";

export function servstationJobIsTerminal(job: Pick<ServstationSessionJob, "status">): boolean {
  return ["completed", "failed", "canceled", "cancelled"].includes(job.status);
}
