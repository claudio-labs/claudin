// Pull the errors out of `docker logs` instead of handing back a blind tail.
//
// A tail of N lines is the wrong shape for container logs twice over: it cuts
// stack traces in half, and on a chatty service it returns N lines of health
// pings while the exception scrolled past an hour ago. This walks the log and
// returns whole error BLOCKS, so a Python traceback or a Go panic arrives with
// every frame attached.
//
// Pure: no I/O, no subprocess.

import stripAnsi from 'strip-ansi'
import type { ContainerState } from 'src/containers/types.js'

export type LogBlockKind =
  | 'python-traceback'
  | 'go-panic'
  | 'java-exception'
  | 'node-stack'
  | 'json-record'
  | 'error-line'

export type LogBlock = {
  kind: LogBlockKind
  /** The block's lines, verbatim and ANSI-stripped. Never re-joined or
   * collapsed — a multi-line JSON record keeps its shape. */
  lines: string[]
  /** 0-based index of the first line within the input. */
  startLine: number
}

export type LogExtraction =
  | {
      kind: 'errors'
      blocks: LogBlock[]
      /** Whole blocks left out by the cap. Never a partial block. */
      droppedBlocks: number
      totalLines: number
    }
  | { kind: 'no-errors'; totalLines: number }
  /** Nothing was written. `died-before-writing` when the container is already
   * gone, which is a different answer from a live container that is quiet. */
  | { kind: 'empty'; reason: 'died-before-writing' | 'never-wrote' }
  /** `docker logs` cannot read this container's logs at all — journald,
   * awslogs and friends. Reporting this as "no errors" would be a lie. */
  | { kind: 'driver-unreadable'; message: string }

export type ExtractOptions = {
  /** Whole blocks beyond this are dropped and counted. */
  maxBlocks?: number
  /** Used only to explain an empty log. */
  containerState?: ContainerState
}

const DEFAULT_MAX_BLOCKS = 10
/** A goroutine dump can run to thousands of lines; past this a block is cut
 * with an explicit marker rather than allowed to swallow the whole result. */
const MAX_BLOCK_LINES = 60

const DRIVER_UNREADABLE_RE =
  /configured logging driver does not support reading|Error response from daemon: .*logs are not available/i

/** `2026-08-29T20:31:11.882101441Z ` — docker's own --timestamps prefix. */
const DOCKER_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/

const PYTHON_HEADER_RE = /Traceback \(most recent call last\):/
const PYTHON_CHAIN_RE =
  /^(?:During handling of the above exception|The above exception was the direct cause)/
const GO_HEADER_RE = /^(?:panic:|fatal error:)/
const GO_CONTINUATION_RE =
  /^(?:goroutine \d+|\[signal |created by |exit status \d+|[\w.*()/\[\]-]+\(.*\)$)/
const JAVA_HEADER_RE =
  /^Exception in thread |^(?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::|$)/
const JAVA_CONTINUATION_RE = /^(?:at |Caused by:|Suppressed:|\.\.\. \d+ more)/
const NODE_HEADER_RE = /^(?:[A-Z][\w]*)?Error(?: \[[\w]+\])?: /
const NODE_FRAME_RE = /^at /

/** Plain single-line errors worth surfacing on their own. */
const ERROR_LINE_RE = /\b(?:ERROR|FATAL|CRITICAL|SEVERE)\b|^E:\s|^error:\s/i
/** A JSON record only counts as an error when it says so. */
const JSON_ERROR_RE = /"(?:level|severity|lvl)"\s*:\s*"(?:error|fatal|critical)"/i

/** Strip the docker timestamp so indentation-based rules see real indentation. */
function payloadOf(line: string): string {
  return line.replace(DOCKER_TIMESTAMP_RE, '')
}

function isIndented(payload: string): boolean {
  return /^\s/.test(payload) && payload.trim().length > 0
}

/**
 * A Python traceback runs from its header, through the indented frames (and any
 * chained-exception markers), to the first line at column zero — which is the
 * exception itself and belongs to the block.
 */
function takePythonTraceback(payloads: string[], start: number): number {
  let i = start + 1
  while (i < payloads.length) {
    const p = payloads[i] ?? ''
    if (isIndented(p) || p.trim() === '') {
      i++
      continue
    }
    if (PYTHON_CHAIN_RE.test(p) || PYTHON_HEADER_RE.test(p)) {
      i++
      continue
    }
    // The exception line: part of the block, and the end of it.
    return i + 1
  }
  return i
}

function takeGoPanic(payloads: string[], start: number): number {
  let i = start + 1
  while (i < payloads.length) {
    const p = payloads[i] ?? ''
    if (p.trim() === '' || isIndented(p) || GO_CONTINUATION_RE.test(p)) {
      i++
      continue
    }
    break
  }
  // Trailing blank lines belong to whatever comes next, not to the panic.
  while (i > start + 1 && (payloads[i - 1] ?? '').trim() === '') i--
  return i
}

function takeJavaException(payloads: string[], start: number): number {
  let i = start + 1
  while (i < payloads.length) {
    const p = (payloads[i] ?? '').replace(/^\t/, '').trimStart()
    if (JAVA_CONTINUATION_RE.test(p)) {
      i++
      continue
    }
    break
  }
  return i
}

/**
 * Node prints `    at …` frames and, for an error carrying properties, opens a
 * `{` on the last frame and closes it on its own line. Both belong to the block.
 */
function takeNodeStack(payloads: string[], start: number): number {
  let i = start + 1
  let openBrace = (payloads[start] ?? '').trimEnd().endsWith('{')
  while (i < payloads.length) {
    const raw = payloads[i] ?? ''
    const p = raw.trimStart()
    if (openBrace) {
      i++
      if (p === '}' || p === '},') openBrace = false
      continue
    }
    if (NODE_FRAME_RE.test(p)) {
      i++
      if (raw.trimEnd().endsWith('{')) openBrace = true
      continue
    }
    break
  }
  return i
}

/**
 * A JSON record may span lines. Consume until braces balance, bounded, and
 * return the end index plus the joined text so the caller can decide whether it
 * is an error record. The LINES are kept separate — a pretty-printed record is
 * never squashed onto one line.
 *
 * Two things keep a line that merely STARTS with `{` from swallowing the
 * window: braces inside a string do not count, and a record that never
 * balances consumes only its first line. Without either, a log line like
 * `{"msg":"got { here"` ate the next 59 lines and every real error in them.
 */
function takeJsonRecord(
  payloads: string[],
  start: number,
): { end: number; text: string } {
  let depth = 0
  let i = start
  const parts: string[] = []
  while (i < payloads.length && i - start < MAX_BLOCK_LINES) {
    const p = payloads[i] ?? ''
    parts.push(p)
    // Reset per line: valid JSON never carries a raw newline inside a string,
    // so an unterminated quote is a broken line rather than a continuation —
    // and carrying the state on would poison every line after it.
    let inString = false
    let escaped = false
    for (const ch of p) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    i++
    if (depth <= 0) break
  }
  if (depth > 0) {
    // Never balanced: this is prose that happens to open a brace, not a
    // record. Give back the one line so the scan continues on the next.
    return { end: start + 1, text: parts[0] ?? '' }
  }
  return { end: i, text: parts.join('\n') }
}

function cap(lines: string[]): string[] {
  if (lines.length <= MAX_BLOCK_LINES) return lines
  return [
    ...lines.slice(0, MAX_BLOCK_LINES),
    `… ${lines.length - MAX_BLOCK_LINES} more lines in this block`,
  ]
}

/**
 * Extract error blocks from raw `docker logs` output.
 *
 * Cap policy: the per-block line limit is applied INSIDE a block with an
 * explicit marker, and the block limit drops WHOLE trailing blocks and reports
 * the count. A trace is never silently cut mid-frame — a half trace reads as a
 * different bug than the one that happened, which is worse than a missing one.
 */
export function extractLogErrors(
  raw: string,
  { maxBlocks = DEFAULT_MAX_BLOCKS, containerState }: ExtractOptions = {},
): LogExtraction {
  const clean = stripAnsi(raw)

  if (DRIVER_UNREADABLE_RE.test(clean)) {
    return {
      kind: 'driver-unreadable',
      message:
        'this container uses a logging driver `docker logs` cannot read (journald, awslogs, …)',
    }
  }

  if (!clean.trim()) {
    const died = containerState === 'exited' || containerState === 'dead'
    return {
      kind: 'empty',
      reason: died ? 'died-before-writing' : 'never-wrote',
    }
  }

  const lines = clean.replace(/\n$/, '').split('\n')
  const payloads = lines.map(payloadOf)
  const found: LogBlock[] = []

  let i = 0
  while (i < lines.length) {
    const p = payloads[i] ?? ''
    const trimmed = p.trimStart()

    if (PYTHON_HEADER_RE.test(p)) {
      const end = takePythonTraceback(payloads, i)
      found.push({
        kind: 'python-traceback',
        lines: cap(lines.slice(i, end)),
        startLine: i,
      })
      i = end
      continue
    }
    if (GO_HEADER_RE.test(trimmed)) {
      const end = takeGoPanic(payloads, i)
      found.push({
        kind: 'go-panic',
        lines: cap(lines.slice(i, end)),
        startLine: i,
      })
      i = end
      continue
    }
    if (JAVA_HEADER_RE.test(trimmed)) {
      const end = takeJavaException(payloads, i)
      found.push({
        kind: 'java-exception',
        lines: cap(lines.slice(i, end)),
        startLine: i,
      })
      i = end
      continue
    }
    if (NODE_HEADER_RE.test(trimmed)) {
      const end = takeNodeStack(payloads, i)
      found.push({
        kind: 'node-stack',
        lines: cap(lines.slice(i, end)),
        startLine: i,
      })
      i = end
      continue
    }
    if (trimmed.startsWith('{')) {
      const { end, text } = takeJsonRecord(payloads, i)
      if (JSON_ERROR_RE.test(text)) {
        found.push({
          kind: 'json-record',
          lines: cap(lines.slice(i, end)),
          startLine: i,
        })
      }
      i = end
      continue
    }
    if (ERROR_LINE_RE.test(p)) {
      found.push({ kind: 'error-line', lines: [lines[i] ?? ''], startLine: i })
      i++
      continue
    }
    i++
  }

  if (found.length === 0) {
    return { kind: 'no-errors', totalLines: lines.length }
  }

  return {
    kind: 'errors',
    blocks: found.slice(0, maxBlocks),
    droppedBlocks: Math.max(0, found.length - maxBlocks),
    totalLines: lines.length,
  }
}
