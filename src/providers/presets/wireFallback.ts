/**
 * The sticky way back to Chat Completions for a wire compatWires.ts chose.
 *
 * The table only routes a host to a new wire where a recording of that host
 * proves the wire, and no maintainer account reaches most of them. So the
 * first answer is the check: a 400, 404 or 422 to the first request of an
 * endpoint and model on that wire — before any success there, and not a
 * context overflow, which compaction answers — marks the pair rejected. The
 * failing request is sent again over chat by the caller, and
 * `resolveCompatWire` keeps the pair on chat for the rest of the process.
 */
import { classifyOpenAIHttpFailure } from 'src/providers/shims/openaiErrorClassification.js'
import { logForDebugging } from 'src/shared/debug.js'

export type FallbackWire = 'responses' | 'anthropic'

const FALLBACK_STATUSES: ReadonlySet<number> = new Set([400, 404, 422])

const succeeded = new Set<string>()
const rejected = new Set<string>()

function keyOf(wire: FallbackWire, baseUrl: string, model: string): string {
  return `${wire}\n${baseUrl.replace(/\/+$/, '').toLowerCase()}\n${model.toLowerCase()}`
}

export function noteWireSuccess(wire: FallbackWire, baseUrl: string, model: string): void {
  succeeded.add(keyOf(wire, baseUrl, model))
}

export function isWireRejected(wire: FallbackWire, baseUrl: string, model: string): boolean {
  return rejected.has(keyOf(wire, baseUrl, model))
}

/**
 * Whether this failure sends the pair back to chat. True at most once per
 * pair: it records the rejection, so the caller retries over chat now.
 */
export function rejectWireOnFailure(
  wire: FallbackWire,
  baseUrl: string,
  model: string,
  failure: { status: number; body: string },
): boolean {
  const key = keyOf(wire, baseUrl, model)
  if (succeeded.has(key) || rejected.has(key)) return false
  if (!FALLBACK_STATUSES.has(failure.status)) return false
  if (classifyOpenAIHttpFailure(failure).category === 'context_overflow') return false
  rejected.add(key)
  logForDebugging(
    `[wire] ${baseUrl} rejected the ${wire} wire for ${model} (${failure.status}); using Chat Completions for this session`,
    { level: 'warn' },
  )
  return true
}

export function _resetWireFallbackForTesting(): void {
  succeeded.clear()
  rejected.clear()
}
