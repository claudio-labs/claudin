// In its own file (like toolName.ts) so the permission dialog can import it
// without pulling in MonitorTool.ts's task and shell dependencies.

/** What the monitor watches, as the transcript, the classifier and the dialog show it. */
export function monitorSource(input: {
  command?: string
  ws?: { url: string }
  mcp_event?: { server: string; event: string }
}): string {
  if (input.mcp_event) return `mcp event ${input.mcp_event.server}/${input.mcp_event.event}`
  return input.ws ? `websocket ${input.ws.url}` : (input.command ?? '')
}
