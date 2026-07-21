import type { ToolCallRecord } from "@supbot/shared";

export function toolStatusColor(status: ToolCallRecord["status"]): string {
  switch (status) {
    case "pending_permission": return "gold";
    case "running": return "cyan";
    case "completed": return "green";
    case "failed":
    case "denied": return "red";
    default: return "default";
  }
}
