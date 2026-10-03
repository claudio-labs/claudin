/**
 * `claudin --resume --from-pr [value]`: which listed sessions the picker keeps.
 */
import type { LogOption } from 'src/shared/types/logs.js'

export type PrFilter = boolean | number | string | undefined

const WHOLE_NUMBER = /^\s*(\d+)\s*$/
const GITHUB_PULL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/

/** The PR a piece of text names: a positive integer, or a GitHub pull-request URL. Null when it names none. */
export function parsePrIdentifier(text: string): number | null {
  const digits = WHOLE_NUMBER.exec(text)?.[1] ?? GITHUB_PULL.exec(text)?.[1]
  if (digits === undefined) return null
  const pr = Number(digits)
  return pr > 0 ? pr : null
}

/** What a session must be linked to: any PR, one PR, or nothing (no filtering). */
function wantedPr(filter: PrFilter): 'any' | number | null {
  if (filter === true) return 'any'
  if (typeof filter === 'number') return filter
  if (typeof filter === 'string') return parsePrIdentifier(filter)
  return null
}

export function filterLogsByPr(logs: readonly LogOption[], filter: PrFilter): readonly LogOption[] {
  const wanted = wantedPr(filter)
  if (wanted === null) return logs
  if (wanted === 'any') return logs.filter(log => log.prNumber !== undefined)
  return logs.filter(log => log.prNumber === wanted)
}
