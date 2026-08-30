// Which containers this session brought up.
//
// Only used to word the stop confirmation: stopping a container Claudin started
// deserves a different sentence than stopping one that predates the session.
// Deliberately a plain module-level set — it is per-process, per-session state
// with no persistence, and putting it in AppState would make every `up` a
// render.

const startedByUs = new Set<string>()

export function markContainersStartedByUs(ids: readonly string[]): void {
  for (const id of ids) startedByUs.add(id)
}

export function getContainersStartedByUs(): ReadonlySet<string> {
  return startedByUs
}

export function __resetStartedByUsForTests(): void {
  startedByUs.clear()
}
