// Monitor's event stream. While a monitor's command runs, the new lines of its
// output file reach the model as task notifications, about once a second. The
// stream also owns the monitor's deadline (`timeout_ms`) and stops a monitor
// that floods the conversation; both end with a notice of their own, because
// killTask marks the task notified and the generic exit notice never fires.
//
// Everything that touches the clock, the disk or the queue comes in through
// MonitorStreamDeps, so the tests drive it without timers or mock.module.
// The output file is read as bytes: the offset counts what is on disk, and a
// line is decoded only once it is complete.

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from 'src/shared/constants/xml.js'
import { escapeXml } from 'src/shared/data/xml.js'
import { logError } from 'src/shared/log.js'

export const MONITOR_POLL_MS = 1_000
export const MONITOR_EVENT_MAX_LINES = 20
export const MONITOR_EVENT_MAX_BYTES = 2_048
export const MONITOR_FLOOD_EVENTS = 20
export const MONITOR_FLOOD_WINDOW_MS = 60_000
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000
export const MONITOR_READ_MAX_BYTES = 1024 * 1024

const NEWLINE = 0x0a
const LINE_BREAK_RE = /\r?\n/
const TRAILING_BREAK_RE = /\r?\n$/

/** Why the stream stopped its own command. */
export type MonitorEndReason = 'expired' | 'flood'

export type MonitorStreamOptions = {
  taskId: string
  description: string
  toolUseId?: string
  outputPath: string
  timeoutMs: number
}

export type MonitorStreamDeps = {
  /** The output file's bytes from `fromOffset`, at most `maxBytes`. */
  read(fromOffset: number, maxBytes: number): Promise<Buffer>
  enqueue(message: string): void
  /** Kill the command; false when it had already ended. */
  kill(): boolean
  now(): number
  every(ms: number, fn: () => void): () => void
  after(ms: number, fn: () => void): () => void
}

export type MonitorStream = {
  /** Deliver what is left (unless `flush` is false) and stop polling. Idempotent. */
  stop(options: { flush: boolean }): Promise<void>
}

/** `timeout_ms` as the model passed it, defaulted and capped. */
export function clampMonitorTimeout(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS)
}

/**
 * Where `bytes` up to `end` stops being whole UTF-8: before a multi-byte
 * character the cut at `end` would split, else `end`.
 */
function utf8Boundary(bytes: Buffer, end: number): number {
  let lead = end - 1
  while (lead >= 0 && end - lead < 4 && (bytes[lead]! & 0xc0) === 0x80) lead--
  if (lead < 0) return end
  const byte = bytes[lead]!
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
  return lead + length > end ? lead : end
}

/**
 * Split off the complete lines of `bytes`. A trailing partial line stays for
 * the next read unless `flush` is set, or it alone is over the byte cap (a
 * command that never prints a newline would otherwise be re-read forever) —
 * then it is taken up to the last whole character.
 */
export function takeCompleteLines(
  bytes: Buffer,
  flush: boolean,
): { lines: string[]; consumedBytes: number } {
  const end = bytes.lastIndexOf(NEWLINE)
  const consumedBytes = flush
    ? bytes.length
    : end === -1 && bytes.length > MONITOR_EVENT_MAX_BYTES
      ? utf8Boundary(bytes, bytes.length)
      : end + 1
  const body = bytes.subarray(0, consumedBytes).toString('utf8').replace(TRAILING_BREAK_RE, '')
  const lines = body === '' ? [] : body.split(LINE_BREAK_RE)
  return { lines, consumedBytes }
}

function cutToBytes(line: string, room: number): string {
  const bytes = Buffer.from(line)
  return bytes.length > room ? `${bytes.subarray(0, utf8Boundary(bytes, room)).toString('utf8')}…` : line
}

function capLines(lines: string[], outputPath: string): string[] {
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    if (kept.length === MONITOR_EVENT_MAX_LINES) break
    const room = MONITOR_EVENT_MAX_BYTES - bytes
    if (room <= 0) break
    const fitted = cutToBytes(line, room)
    kept.push(fitted)
    bytes += Buffer.byteLength(fitted) + 1
  }
  const more = lines.length - kept.length
  if (more > 0) kept.push(`[${more} more line${more === 1 ? '' : 's'} in ${outputPath}]`)
  return kept
}

function header(options: MonitorStreamOptions, status: string | null, summary: string): string {
  const toolUseIdLine = options.toolUseId ? `\n<${TOOL_USE_ID_TAG}>${options.toolUseId}</${TOOL_USE_ID_TAG}>` : ''
  // No <status> on an event: print.ts reads <status> as the end of the task.
  const statusLine = status ? `\n<${STATUS_TAG}>${status}</${STATUS_TAG}>` : ''
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${options.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${options.outputPath}</${OUTPUT_FILE_TAG}>${statusLine}
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}

/** One event: the lines that arrived since the last one, escaped and capped. */
export function formatMonitorEvent(options: MonitorStreamOptions, lines: string[]): string {
  const body = capLines(lines, options.outputPath).map(escapeXml).join('\n')
  return `${header(options, null, `Monitor "${options.description}" output`)}\n${body}`
}

function formatRan(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`
}

/** The notice for a monitor the stream stopped itself. */
export function formatMonitorStop(
  options: MonitorStreamOptions,
  reason: MonitorEndReason,
  events: number,
  ranMs: number,
): string {
  const counted = `${events} event${events === 1 ? '' : 's'}`
  const summary =
    reason === 'expired'
      ? `Monitor "${options.description}" expired after ${formatRan(ranMs)} with ${counted}; call Monitor again to keep watching`
      : `Monitor "${options.description}" stopped: ${counted} in under a minute; call Monitor again with a tighter filter`
  return header(options, 'killed', summary)
}

export function startMonitorStream(options: MonitorStreamOptions, deps: MonitorStreamDeps): MonitorStream {
  const startedAt = deps.now()
  const eventTimes: number[] = []
  let offset = 0
  let events = 0
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()

  // One link at a time; a failed link is logged and the next one still runs.
  const schedule = (work: () => Promise<void>): void => {
    inFlight = inFlight.then(work).catch(logError)
  }

  const read = async (flush: boolean): Promise<void> => {
    const { lines, consumedBytes } = takeCompleteLines(await deps.read(offset, MONITOR_READ_MAX_BYTES), flush)
    offset += consumedBytes
    if (lines.length === 0) return
    deps.enqueue(formatMonitorEvent(options, lines))
    events++
    const now = deps.now()
    eventTimes.push(now)
    while (eventTimes.length > 0 && now - eventTimes[0]! > MONITOR_FLOOD_WINDOW_MS) eventTimes.shift()
  }

  const cancelPoll = deps.every(MONITOR_POLL_MS, () => {
    schedule(async () => {
      if (stopped) return
      await read(false)
      if (eventTimes.length >= MONITOR_FLOOD_EVENTS) await end('flood', false)
    })
  })
  const cancelDeadline = deps.after(options.timeoutMs, () => schedule(() => end('expired', true)))

  // The one way the stream stops: deliver what is left, then no more polls.
  async function halt(flush: boolean): Promise<void> {
    try {
      if (flush) await read(true)
    } finally {
      stopped = true
      cancelPoll()
      cancelDeadline()
    }
  }

  // The stream stopping its own command. A command that ended on its own in
  // the same instant already had its exit notice, so it gets no second one.
  async function end(reason: MonitorEndReason, flush: boolean): Promise<void> {
    if (stopped) return
    try {
      await halt(flush)
    } finally {
      if (deps.kill()) deps.enqueue(formatMonitorStop(options, reason, events, deps.now() - startedAt))
    }
  }

  return {
    async stop({ flush }) {
      schedule(async () => {
        if (!stopped) await halt(flush)
      })
      await inFlight
    },
  }
}
