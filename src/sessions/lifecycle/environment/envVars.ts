/**
 * Variables for the processes this session spawns, not for the CLI itself.
 * Nothing sets them yet (the command that would does not exist), so the map
 * stays empty; the shell providers and /clear already read and clear it.
 */
const childProcessVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return childProcessVars
}

export function clearSessionEnvVars(): void {
  childProcessVars.clear()
}
