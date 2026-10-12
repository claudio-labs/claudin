/**
 * Colors the log-shaped parts of command output with the active theme: level
 * words (ERROR, WARN, INFO, DEBUG …), timestamps, and the `api-1  | ` prefix
 * `docker compose logs` puts on every line.
 *
 * TUI only. The string the model receives is never touched, so this costs
 * nothing in tokens or cache. Only the token is painted, never the message
 * beside it, and the line count never changes, so truncation and fixed-height
 * boxes stay exact.
 *
 * Painting goes through `colorize` rather than `themeColorToAnsi`: the latter
 * only understands `rgb(…)` and turns every `ansi:*` value magenta, which
 * would break `dark-ansi`, `light-ansi` and `terminal`.
 *
 * Killswitch: `CLAUDIN_LOG_HIGHLIGHT=0`.
 */
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { colorize } from 'src/terminal/ink/colorize.js'
import type { Theme } from 'src/terminal/theme/themes/types.js'

type ThemeKey = keyof Theme

type Span = { start: number; end: number; color: ThemeKey }

/** Past this, highlighting an expanded view costs more than it shows. */
const MAX_HIGHLIGHT_CHARS = 200_000

const LEVEL_COLORS: Readonly<Record<string, ThemeKey>> = {
  fatal: 'error',
  critical: 'error',
  panic: 'error',
  severe: 'error',
  error: 'error',
  err: 'error',
  warning: 'warning',
  warn: 'warning',
  notice: 'suggestion',
  info: 'suggestion',
  debug: 'inactive',
  trace: 'inactive',
}

/** Red is left out: a service name painted red reads as an error. */
const SERVICE_COLORS: readonly ThemeKey[] = [
  'cyan_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY',
  'yellow_FOR_SUBAGENTS_ONLY',
  'blue_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY',
]

// A line that already carries an escape was colored by its own program.
const ESC = '\x1b'

// `api-1  | …` (compose v2) and `api_1  | …` (v1). The replica suffix is
// required so an ordinary `name | value` table row is left alone.
const COMPOSE_PREFIX_RE = /^([A-Za-z0-9][\w.-]*[-_]\d+)(\s+\|(?: |$))/

// Uppercase only, so `throw new Error(…)` and prose about "an error" stay plain.
const LEVEL_WORD_RE =
  /\b(?:FATAL|CRITICAL|PANIC|SEVERE|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE)\b/g
const KEY_VALUE_LEVEL_RE = /\b(?:level|lvl|severity)=("?)([A-Za-z]+)\1/dgi
const JSON_LEVEL_RE = /"(?:level|lvl|severity)"\s*:\s*"([A-Za-z]+)"/dgi
const BRACKET_LEVEL_RE = /\[([A-Za-z]+)\]/dg
// rustc/gcc `error: …`, `error[E0308]: …`, `warning: …` open the line.
const COMPILER_LINE_RE = /^(?:error|warning)(?=(?:\[[A-Z]?\d+\])?:)/
// tsc `src/a.ts(1,2): error TS2345: …`.
const TSC_LEVEL_RE = /\b(?:error|warning)(?= TS\d+:)/g

const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const LEADING_CLOCK_RE = /^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/
const BRACKET_CLOCK_RE = /(?<=\[)\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?=\])/g

/**
 * `text` with its log tokens wrapped in the theme's colors. Returns `text`
 * unchanged when the killswitch is set or the text is too large.
 */
export function highlightLogText(text: string, theme: Theme): string {
  if (!text || text.length > MAX_HIGHLIGHT_CHARS) return text
  if (isEnvDefinedFalsy(process.env.CLAUDIN_LOG_HIGHLIGHT)) return text
  const services = new Map<string, ThemeKey>()
  return text
    .split('\n')
    .map(line => highlightLine(line, theme, services))
    .join('\n')
}

function highlightLine(line: string, theme: Theme, services: Map<string, ThemeKey>): string {
  if (!line || line.includes(ESC)) return line
  const prefix = COMPOSE_PREFIX_RE.exec(line)
  if (!prefix) return paint(line, findSpans(line), theme)
  const service = prefix[1]!
  const separator = prefix[2]!
  const rest = line.slice(prefix[0].length)
  return (
    colorize(service, theme[serviceColor(service, services)], 'foreground') +
    separator +
    paint(rest, findSpans(rest), theme)
  )
}

function findSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const m of text.matchAll(ISO_TIMESTAMP_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, color: 'inactive' })
  }
  const clock = LEADING_CLOCK_RE.exec(text)
  if (clock) spans.push({ start: 0, end: clock[0].length, color: 'inactive' })
  for (const m of text.matchAll(BRACKET_CLOCK_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, color: 'inactive' })
  }
  for (const m of text.matchAll(LEVEL_WORD_RE)) {
    pushLevel(spans, m[0], m.index)
  }
  const compiler = COMPILER_LINE_RE.exec(text)
  if (compiler) pushLevel(spans, compiler[0], 0)
  for (const m of text.matchAll(TSC_LEVEL_RE)) {
    pushLevel(spans, m[0], m.index)
  }
  for (const re of [KEY_VALUE_LEVEL_RE, JSON_LEVEL_RE, BRACKET_LEVEL_RE]) {
    for (const m of text.matchAll(re)) {
      // The level is always the last capture group.
      const group = m.length - 1
      const range = m.indices?.[group]
      if (range) pushLevel(spans, m[group]!, range[0])
    }
  }
  return spans
}

function pushLevel(spans: Span[], word: string, start: number): void {
  const color = LEVEL_COLORS[word.toLowerCase()]
  if (color) spans.push({ start, end: start + word.length, color })
}

/** Paints the spans left to right; one that overlaps an earlier one is dropped. */
function paint(text: string, spans: Span[], theme: Theme): string {
  if (spans.length === 0) return text
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue
    out +=
      text.slice(cursor, span.start) +
      colorize(text.slice(span.start, span.end), theme[span.color], 'foreground')
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/**
 * A service's color comes from a hash of its name, so it is the same run after
 * run. When another service in the same text already holds that color, the
 * next free one is taken instead: two services that collide (`api-1` and
 * `worker-1` do) must still read apart, which is the point of coloring them.
 */
function serviceColor(service: string, services: Map<string, ThemeKey>): ThemeKey {
  const known = services.get(service)
  if (known) return known
  let hash = 0
  for (let i = 0; i < service.length; i++) {
    hash = (hash * 31 + service.charCodeAt(i)) >>> 0
  }
  const used = new Set(services.values())
  let index = hash % SERVICE_COLORS.length
  for (let tries = 0; tries < SERVICE_COLORS.length && used.has(SERVICE_COLORS[index]!); tries++) {
    index = (index + 1) % SERVICE_COLORS.length
  }
  const color = SERVICE_COLORS[index]!
  services.set(service, color)
  return color
}
