import { join } from 'path'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'

/**
 * Where every running session keeps its PID record: concurrentSessions.ts
 * writes it, peers/registry.ts reads the others'. A leaf module on purpose —
 * tests mock concurrentSessions.ts, and the reader must not go with it.
 */
export function getSessionsDir(): string {
  return join(getClaudinConfigHomeDir(), 'sessions')
}
