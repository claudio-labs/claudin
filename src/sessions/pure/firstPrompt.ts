// The title the resume picker shows for a session: its first real prompt.
//
// Two readings share one set of rules. The message reading walks parsed
// messages; the chunk reading walks the raw head of a file, keeping only the
// lines that look like user prompts, and flattens every text before judging
// it. Everything after "which texts are candidates" is the same code.

import { extractTag } from 'src/agent/messages/text.js'
import { builtInCommandNames } from 'src/commands/commands.js'
import {
  BASH_INPUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_NAME_TAG,
} from 'src/shared/constants/xml.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'

/**
 * Text that is not a prompt: output wrapped in a lowercase tag (optionally
 * after whitespace), or an interruption marker at the very start. No `g` or
 * `y` flag, so repeated `test` calls agree.
 */
export const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

const NO_PROMPT = 'No prompt'
const TITLE_MAX_LENGTH = 200
const ELLIPSIS = '\u2026'
const LINE_BREAK = /\r\n?|\n/g
const LEADING_SLASH = /^\//

// Raw-text filters of the chunk reading, applied before a line is parsed.
const USER_LINE_MARKERS = ['"type":"user"', '"type": "user"']
const NON_PROMPT_LINE_MARKERS = ['"tool_result"', '"isMeta":true', '"isMeta": true']

type Verdict =
  | { kind: 'prompt'; text: string }
  /** A built-in command, or a custom one without arguments: skipped. */
  | { kind: 'command'; name: string }
  | { kind: 'skip' }

function judgeCommand(text: string, commandTag: string): Verdict {
  const args = extractTag(text, COMMAND_ARGS_TAG)?.trim() ?? ''
  const builtIn = builtInCommandNames().has(commandTag.replace(LEADING_SLASH, ''))
  if (builtIn || args === '') return { kind: 'command', name: commandTag }
  return { kind: 'prompt', text: `${commandTag} ${args}` }
}

function judge(text: string): Verdict {
  const commandTag = extractTag(text, COMMAND_NAME_TAG)
  if (commandTag) return judgeCommand(text, commandTag)
  const bashInput = extractTag(text, BASH_INPUT_TAG)
  if (bashInput) return { kind: 'prompt', text: `! ${bashInput}` }
  if (SKIP_FIRST_PROMPT_PATTERN.test(text)) return { kind: 'skip' }
  return { kind: 'prompt', text }
}

// A text with nothing but whitespace is no prompt, and must not hide the
// prompts after it.
function* verdicts(
  texts: Iterable<string>,
  prepare: (text: string) => string,
): Generator<Verdict> {
  for (const text of texts) {
    const candidate = prepare(text)
    if (candidate.trim() !== '') yield judge(candidate)
  }
}

function flatten(text: string): string {
  return text.replace(LINE_BREAK, ' ').trim()
}

function cutToTitle(text: string): string {
  if (text.length <= TITLE_MAX_LENGTH) return text
  return `${text.slice(0, TITLE_MAX_LENGTH).trim()}${ELLIPSIS}`
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (typeof block !== 'object' || block === null) return false
  const { type, text } = block as { type?: unknown; text?: unknown }
  return type === 'text' && typeof text === 'string'
}

function* contentTexts(content: unknown): Generator<string> {
  if (typeof content === 'string') {
    yield content
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (isTextBlock(block)) yield block.text
  }
}

function* messageTexts(messages: readonly Message[]): Generator<string> {
  for (const m of messages) {
    if (m.type !== 'user' || m.isMeta || m.isCompactSummary) continue
    yield* contentTexts(m.message?.content)
  }
}

type RawUserLine = { type: 'user'; message: unknown; isCompactSummary?: unknown }

function parseUserLine(line: string): RawUserLine | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    // A line cut at the end of the chunk, or damaged: not a candidate.
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as { type?: unknown }
  return record.type === 'user' && 'message' in record ? (record as RawUserLine) : undefined
}

function* chunkTexts(chunk: string): Generator<string> {
  for (const line of chunk.split('\n')) {
    if (!USER_LINE_MARKERS.some(marker => line.includes(marker))) continue
    if (NON_PROMPT_LINE_MARKERS.some(marker => line.includes(marker))) continue
    const entry = parseUserLine(line)
    // A fork of a compacted session opens with the summary: not its title.
    if (!entry || entry.isCompactSummary) continue
    const message = entry.message as { content?: unknown } | null
    yield* contentTexts(message?.content)
  }
}

/** The first meaningful user text, verbatim, or `undefined` when there is none. */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const verdict of verdicts(messageTexts(transcript), text => text)) {
    if (verdict.kind === 'prompt') return verdict.text
  }
  return undefined
}

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const text = getFirstMeaningfulUserMessageTextContent(transcript)
  return text === undefined ? NO_PROMPT : cutToTitle(flatten(text))
}

/**
 * The same title, read from raw JSONL text such as the first 64 KiB of a
 * file. When only commands were typed, the first of them names the session.
 */
export function extractFirstPromptFromChunk(chunk: string): string {
  let firstCommand: string | undefined
  for (const verdict of verdicts(chunkTexts(chunk), flatten)) {
    if (verdict.kind === 'prompt') return cutToTitle(verdict.text)
    if (verdict.kind === 'command') firstCommand ??= verdict.name
  }
  return firstCommand ?? ''
}
