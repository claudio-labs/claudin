// Servers the user disconnected from the footer panel during THIS session.
//
// The `x` key on an MCP row disconnects without writing to settings.json, which
// is the whole point — it should not survive a restart, and it should not edit a
// file the user shares with their team. But the auto-reconnect path in
// `useManageMCPConnections` decides whether to dial again by asking
// `isMcpServerDisabled()`, which reads settings.json from DISK (deliberately:
// the alternative it rejected was a stale AppState). So without a second, purely
// in-memory answer, closing a remote server would immediately start the backoff
// loop and bring it straight back — `x` would look like it did nothing.
//
// Module-level rather than AppState because `onclose` is a transport callback
// firing outside React, and it needs the answer synchronously.

const disconnected = new Set<string>()

/** Called just BEFORE the transport is closed, so `onclose` sees it. */
export function markSessionDisconnected(serverName: string): void {
  disconnected.add(serverName)
}

/** Called by every path that deliberately dials a server again — reconnecting
 * or re-enabling it is the user taking the disconnect back. */
export function clearSessionDisconnected(serverName: string): void {
  disconnected.delete(serverName)
}

export function isSessionDisconnected(serverName: string): boolean {
  return disconnected.has(serverName)
}

/** Test seam. Production never needs this: the set dies with the process. */
export function resetSessionDisconnectsForTests(): void {
  disconnected.clear()
}
