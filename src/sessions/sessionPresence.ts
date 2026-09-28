/**
 * What this process is doing in its current session: whether a model turn is
 * running, how many background agents are, and what the session has cost.
 * The session list shows it for the current row here, and other instances
 * read it from the PID record (hooks/useSessionPresence.ts).
 */
import { getTotalCostUSD, isTurnActive } from 'src/platform/bootstrap/state.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

export type SessionPresence = {
  turnActive: boolean
  runningAgents: number
  costUSD: number
}

export function countRunningAgents(tasks: AppState['tasks']): number {
  return Object.values(tasks).filter(
    task => task.type === 'local_agent' && task.status === 'running',
  ).length
}

export function readSessionPresence(tasks: AppState['tasks']): SessionPresence {
  return {
    turnActive: isTurnActive(),
    runningAgents: countRunningAgents(tasks),
    costUSD: getTotalCostUSD(),
  }
}

/** Equal as the list shows it: the cost to the cent. */
export function samePresence(a: SessionPresence, b: SessionPresence): boolean {
  return (
    a.turnActive === b.turnActive &&
    a.runningAgents === b.runningAgents &&
    Math.round(a.costUSD * 100) === Math.round(b.costUSD * 100)
  )
}
