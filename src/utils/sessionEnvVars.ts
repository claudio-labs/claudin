/**
 * Session-scoped environment variables set via /env.
 * Applied only to spawned child processes (via bash provider env overrides),
 * not to the REPL process itself.
 */
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}


export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
