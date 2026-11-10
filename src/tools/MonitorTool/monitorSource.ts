// In its own file (like toolName.ts) so the permission dialog can import it
// without pulling in MonitorTool.ts's task and shell dependencies.

/** What the monitor watches, as the transcript, the classifier and the dialog show it. */
export function monitorSource(input: { command?: string; ws?: { url: string } }): string {
  return input.ws ? `websocket ${input.ws.url}` : (input.command ?? '')
}
