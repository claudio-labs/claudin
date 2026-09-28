/**
 * Reads `/loop`'s arguments into the loop they ask for. The shapes, tried in
 * this order on the trimmed text:
 *
 *   ''                           self-paced maintenance
 *   '5m', '5 minutes'            fixed maintenance
 *   '5m check the deploy'        fixed, with a prompt (the interval is one token)
 *   'check the deploy every 5m'  fixed, with the clause taken off the prompt
 *   anything else                self-paced, the whole text as its prompt
 *
 * A prompt is kept exactly as typed, inner spacing and newlines included.
 */

export type IntervalUnit = 's' | 'm' | 'h' | 'd'

export type Interval = { readonly count: number; readonly unit: IntervalUnit }

export type LoopRequest =
  | { readonly kind: 'fixed'; readonly interval: Interval; readonly prompt?: string }
  | { readonly kind: 'self-paced'; readonly prompt?: string }

const UNIT_SPELLINGS: ReadonlyArray<readonly [IntervalUnit, readonly string[]]> = [
  ['s', ['s', 'sec', 'secs', 'second', 'seconds']],
  ['m', ['m', 'min', 'mins', 'minute', 'minutes']],
  ['h', ['h', 'hr', 'hrs', 'hour', 'hours']],
  ['d', ['d', 'day', 'days']],
]

const UNIT_BY_SPELLING: ReadonlyMap<string, IntervalUnit> = new Map(
  UNIT_SPELLINGS.flatMap(([unit, spellings]) =>
    spellings.map(spelling => [spelling, unit] as const),
  ),
)

// Nothing but an interval; a space may separate the number from its unit.
const BARE_INTERVAL_RE = /^(\d+)\s*([a-z]+)$/i
// An interval as the first token, then a prompt that keeps its own spacing.
const LEADING_INTERVAL_RE = /^(\d+)([a-z]+)\s+([\s\S]+)$/i
// "every <count> <unit>" at the very end, after a prompt or on its own.
const EVERY_CLAUSE_RE = /^(?:([\s\S]*?)\s+)?every\s+(\d+)\s*([a-z]+)$/i

export function parseLoopRequest(args: string): LoopRequest {
  const text = args.trim()
  if (text === '') return { kind: 'self-paced' }
  return fixedLoop(text) ?? { kind: 'self-paced', prompt: text }
}

/** The interval in its normalized form, a count and a one-letter unit: `7m`. */
export function formatInterval(interval: Interval): string {
  return `${interval.count}${interval.unit}`
}

function fixedLoop(text: string): LoopRequest | undefined {
  const bare = BARE_INTERVAL_RE.exec(text)
  const bareInterval = bare ? toInterval(bare[1], bare[2]) : undefined
  if (bareInterval) return { kind: 'fixed', interval: bareInterval }

  const leading = LEADING_INTERVAL_RE.exec(text)
  const leadingInterval = leading ? toInterval(leading[1], leading[2]) : undefined
  if (leading && leadingInterval) {
    return { kind: 'fixed', interval: leadingInterval, prompt: leading[3] }
  }

  const every = EVERY_CLAUSE_RE.exec(text)
  const everyInterval = every ? toInterval(every[2], every[3]) : undefined
  if (every && everyInterval) {
    // The group is absent when the clause is the whole text: a maintenance loop.
    const prompt: string | undefined = every[1]
    return prompt === undefined
      ? { kind: 'fixed', interval: everyInterval }
      : { kind: 'fixed', interval: everyInterval, prompt }
  }
  return undefined
}

/**
 * A positive whole count in a known unit, or nothing. A count too large to be
 * exact is refused too: it would only print in exponent form.
 */
function toInterval(
  countText: string | undefined,
  unitText: string | undefined,
): Interval | undefined {
  const unit = UNIT_BY_SPELLING.get(unitText?.toLowerCase() ?? '')
  const count = Number(countText)
  if (unit === undefined || !Number.isSafeInteger(count) || count <= 0) {
    return undefined
  }
  return { count, unit }
}
