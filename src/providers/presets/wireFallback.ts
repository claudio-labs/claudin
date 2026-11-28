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
 * A request that was already in flight on the wire when the pair was rejected
 * fails the same way, and goes back to chat too.
 */
import { classifyOpenAIHttpFailure } from 'src/providers/shims/openaiErrorClassification.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { CompatWireKind } from 'src/providers/presets/compatWires.js'

const FALLBACK_STATUSES: ReadonlySet<number> = new Set([400, 404, 422])
const TRAILING_SLASH_RE = /\/+$/

const succeeded = new Set<string>()
const rejected = new Set<string>()

function keyOf(wire: CompatWireKind, baseUrl: string, model: string): string {
  return `${wire}\n${baseUrl.replace(TRAILING_SLASH_RE, '').toLowerCase()}\n${model.toLowerCase()}`
}

export function noteWireSuccess(wire: CompatWireKind, baseUrl: string, model: string): void {
  succeeded.add(keyOf(wire, baseUrl, model))
}

export function isWireRejected(wire: CompatWireKind, baseUrl: string, model: string): boolean {
  return rejected.has(keyOf(wire, baseUrl, model))
}

/**
 * Whether this failure sends the request back to chat: it records the
 * rejection, so the caller retries over chat now.
 */
export function rejectWireOnFailure(
  wire: CompatWireKind,
  baseUrl: string,
  model: string,
  failure: { status: number; body: string },
): boolean {
  const key = keyOf(wire, baseUrl, model)
  if (succeeded.has(key)) return false
  if (!FALLBACK_STATUSES.has(failure.status)) return false
  if (classifyOpenAIHttpFailure(failure).category === 'context_overflow') return false
  if (rejected.has(key)) return true
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
