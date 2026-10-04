/** The latest auto-mode denials, newest first, for the permissions UI. */
import { feature } from 'bun:bundle'

export type AutoModeDenial = {
  toolName: string
  display: string
  reason: string
  timestamp: number
}

const KEPT_DENIALS = 20

/** Replaced on every record, never mutated, so a list already handed out stays as it was. */
let recent: readonly AutoModeDenial[] = []

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  recent = [denial, ...recent].slice(0, KEPT_DENIALS)
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return recent
}
