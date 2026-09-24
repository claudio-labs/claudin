import { getCanonicalName } from 'src/providers/model/model.js'

/**
 * Which `thinking.display` a request carries. Billing is the same for every
 * value — the API docs: omitting "reduces latency, not cost" — so this decides
 * only what comes back:
 *
 * - "updates" (interactive): reasoning stays empty, and the progress updates
 *   that Opus 5.5 / Fable 5.1 write between tool calls come back as text,
 *   which the TUI renders. It needs its beta, and a 400 on it turns it off
 *   for the process (adoptedBetas.ts), falling back to "omitted".
 * - "omitted" (headless): nothing to show, and the earliest first text token.
 * - "summarized": the user asked for summaries (showThinkingSummaries).
 *
 * Only on the real first-party endpoint, and only for the models whose server
 * default is already "omitted". Elsewhere the field stays out, so an Opus 4.6
 * or Sonnet 4.6 session keeps the summaries it gets by default. Those models
 * write no progress updates, so "updates" would only take something away.
 *
 * One value per session, whatever the query source: a fork reuses the main
 * thread's cached prefix and must not see a different thinking config.
 * CLAUDIN_THINKING_DISPLAY forces a value; the session A/B uses it to run
 * headless with "updates".
 */
export type ThinkingDisplay = 'summarized' | 'omitted' | 'updates'

export type ThinkingDisplayFacts = {
  realFirstParty: boolean
  /** The server default for this model is "omitted" (see below). */
  defaultsToOmitted: boolean
  interactive: boolean
  showThinkingSummaries: boolean
  /** CLAUDIN_THINKING_DISPLAY. */
  override: string | undefined
  /** isAdoptedBetaEnabled('thinkingDisplayUpdates'): killswitch and 400 latch. */
  updatesAvailable: boolean
}

const DISPLAY_VALUES: ReadonlySet<string> = new Set([
  'summarized',
  'omitted',
  'updates',
])

export function selectThinkingDisplay(
  f: ThinkingDisplayFacts,
): ThinkingDisplay | undefined {
  if (!f.realFirstParty) return undefined
  const forced = f.override?.trim().toLowerCase()
  if (forced && DISPLAY_VALUES.has(forced)) {
    if (forced === 'updates' && !f.updatesAvailable) return 'omitted'
    return forced as ThinkingDisplay
  }
  if (f.showThinkingSummaries) return 'summarized'
  if (!f.defaultsToOmitted) return undefined
  return f.interactive && f.updatesAvailable ? 'updates' : 'omitted'
}

/**
 * Whether a thinking block is a progress update — the sentence Opus 5.5 /
 * Fable 5.1 write for the user before a tool call — rather than reasoning.
 *
 * The API documents one rule, "under display updates, a thinking block with
 * text is a progress update". That needs the display each message was sent
 * with, and it breaks on resume and under "summarized". The signature carries
 * the answer itself, and this reads it the way Claude Code 2.1.280 does: the
 * base64 is a protobuf whose field 2 → 1 → 8 is the block kind, "narration" or
 * "thinking". Checked on a real Fable 5.1 response, which had one of each.
 *
 * The format is undocumented, so any surprise reads as "not an update", and
 * the block keeps the ordinary thinking render.
 */
export function isProgressUpdateBlock(block: {
  type?: string
  thinking?: string
  signature?: string
}): boolean {
  if (block.type !== 'thinking') return false
  if (!block.thinking?.trim() || !block.signature) return false
  const cached = kindBySignature.get(block.signature)
  if (cached !== undefined) return cached === NARRATION
  let kind = ''
  try {
    kind = blockKindFromSignature(block.signature)
  } catch {
    kind = ''
  }
  if (kindBySignature.size >= KIND_CACHE_MAX) kindBySignature.clear()
  kindBySignature.set(block.signature, kind)
  return kind === NARRATION
}

const NARRATION = 'narration'
// Field path to the block kind inside the signature protobuf.
const KIND_PATH = [2, 1, 8] as const
// Renders re-ask for the same blocks; a signature is decoded once. Bounded so a
// long session cannot grow it without limit.
const KIND_CACHE_MAX = 512
const kindBySignature = new Map<string, string>()

function blockKindFromSignature(signature: string): string {
  let bytes: Uint8Array = Buffer.from(signature, 'base64')
  for (const field of KIND_PATH) {
    const next = lengthDelimitedField(bytes, field)
    if (!next) return ''
    bytes = next
  }
  return new TextDecoder().decode(bytes)
}

/** The first length-delimited occurrence of `field` in a protobuf message. */
function lengthDelimitedField(buf: Uint8Array, field: number): Uint8Array | null {
  let pos = 0
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos)
    pos = afterKey
    const wireType = key % 8
    const fieldNo = Math.floor(key / 8)
    if (fieldNo === 0) return null
    switch (wireType) {
      case 0:
        pos = readVarint(buf, pos)[1]
        break
      case 1:
        pos += 8
        break
      case 2: {
        const [len, afterLen] = readVarint(buf, pos)
        if (afterLen + len > buf.length) return null
        if (fieldNo === field) return buf.subarray(afterLen, afterLen + len)
        pos = afterLen + len
        break
      }
      case 5:
        pos += 4
        break
      default:
        return null
    }
  }
  return null
}

function readVarint(buf: Uint8Array, start: number): [number, number] {
  let value = 0
  let scale = 1
  for (let pos = start; pos < buf.length && pos < start + 10; pos++) {
    const byte = buf[pos]!
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return [value, pos + 1]
    scale *= 128
  }
  throw new Error('truncated varint')
}

/**
 * The models the API documents with `"omitted"` as their default display: the
 * Claude 5 family (Opus, Sonnet, Fable), every Mythos including the preview,
 * and Opus 4.7 / 4.8. Everything older defaults to "summarized".
 */
export function modelDefaultsToOmittedThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-fable-5') ||
    canonical.includes('claude-mythos') ||
    canonical.includes('claude-opus-4-7') ||
    canonical.includes('claude-opus-4-8')
  )
}
