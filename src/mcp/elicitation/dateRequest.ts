import type { DateFormat } from 'src/mcp/elicitation/fieldKind.js'

/** What the model must know about "now" to resolve relative dates. */
export type ClockReading = {
  /** The instant, as a UTC ISO string. */
  utc: string
  /** The local offset from UTC, as `±HH:MM`. */
  offset: string
  /** The English name of the local day. */
  weekday: string
}

export type DateRequest = { instructions: string[]; prompt: string }

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const INVALID_REPLY = 'INVALID'

const INSTRUCTIONS = [
  'You turn what a person typed into a date or a date-time in ISO 8601.',
  'Answer with ONLY the ISO 8601 string: no words, no quotes, no explanation.',
  'When the text could mean more than one moment, choose the one in the future.',
  "A time given without a date is on today's date.",
  'A date given without a time gets no time part.',
  `When you cannot read the text with confidence, answer exactly "${INVALID_REPLY}".`,
]

const pad = (n: number) => String(n).padStart(2, '0')

/** `minutesEast` is the zone's distance from UTC, positive east of Greenwich. */
export function formatOffset(minutesEast: number): string {
  const sign = minutesEast < 0 ? '-' : '+'
  const minutes = Math.abs(minutesEast)
  return `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

export function readClock(now: Date): ClockReading {
  return {
    utc: now.toISOString(),
    offset: formatOffset(-now.getTimezoneOffset()),
    weekday: WEEKDAYS[now.getDay()]!,
  }
}

function outputFormat(format: DateFormat, offset: string): string {
  return format === 'date'
    ? 'YYYY-MM-DD (date only, no time)'
    : `YYYY-MM-DDTHH:MM:SS${offset} (full date-time with timezone)`
}

export function buildDateRequest(
  input: string,
  format: DateFormat,
  clock: ClockReading,
): DateRequest {
  const prompt = [
    `Now: ${clock.utc} (UTC)`,
    `Local timezone: ${clock.offset}`,
    `Day of week: ${clock.weekday}`,
    '',
    `User input: "${input}"`,
    '',
    `Output format: ${outputFormat(format, clock.offset)}`,
    `If the input names no date or time you can resolve, answer "${INVALID_REPLY}".`,
  ].join('\n')
  return { instructions: INSTRUCTIONS, prompt }
}
