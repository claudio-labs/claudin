import { createSignal } from 'src/shared/signal.js'

/**
 * "The account this process authenticates as has changed" — login, logout, or
 * a token install. Emitted from the one funnel both paths already share,
 * `clearAuthRelatedCaches()` in src/platform/headless/handlers/auth.ts.
 *
 * It exists because caches keyed on the account cannot invalidate themselves:
 * the claude.ai MCP connector list is fetched with the account token
 * (src/mcp/claudeai.ts), so a login mid-session has to re-run that fetch or the
 * user sees the pre-login server list until they restart.
 *
 * Shaped for `useSyncExternalStore(onAuthChange, getAuthVersion)` — the version
 * is the snapshot, so a React effect can take it as a dependency. The AppState
 * field that used to carry this number had no writer at all, which is why the
 * reconnect never happened.
 */
const authChanged = createSignal()

let version = 0

/** Subscribe to auth changes. Returns an unsubscribe function. */
export const onAuthChange = authChanged.subscribe

/** Monotonic counter, bumped once per auth change. */
export function getAuthVersion(): number {
  return version
}

export function emitAuthChanged(): void {
  version++
  authChanged.emit()
}
