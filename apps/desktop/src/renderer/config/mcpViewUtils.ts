export function mcpStatusColor(state: string): string {
  if (state === "connected") return "green";
  if (state === "connecting") return "blue";
  if (state === "error") return "red";
  return "default";
}

export function mcpToolSourceLabel(toolName: string): string {
  const match = toolName.match(/^mcp\.([^.]+)\.(.+)$/);
  return match ? `MCP ${match[1]} / ${match[2]}` : "";
}
