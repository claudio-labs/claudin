/**
 * The text the transcript's `/` search looks in. For each message it is what
 * the screen shows of that message, lower-cased: never the model-facing text
 * of a tool result, a system reminder, thinking, an interruption notice or a
 * system-injected prompt, so a hit always points at something visible.
 * docs/tech/rewrite/sessions/historySearch.md (section 4) is the spec.
 */
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Attachment } from 'src/agent/attachments/types.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } from 'src/agent/messages/constants.js'
import type { RenderableMessage } from 'src/shared/types/message.js'

type MessageType = RenderableMessage['type']
type MessageOf<K extends MessageType> = Extract<RenderableMessage, { type: K }>
/** What each kind of message puts in the search text, one entry per line. */
type ContributionTable = { [K in MessageType]: (message: MessageOf<K>) => readonly string[] }

/** The fields of a record that are searched, in the order their lines are written. */
type SearchedFields = {
  readonly strings: readonly string[]
  /** Searched only when every element is a string; each list makes one line. */
  readonly lists: readonly string[]
  readonly listSeparator: string
}

const TOOL_CALL_FIELDS: SearchedFields = {
  strings: ['command', 'pattern', 'file_path', 'path', 'prompt', 'description', 'query', 'url', 'skill'],
  lists: ['args', 'files'],
  listSeparator: ' ',
}

const TOOL_OUTPUT_FIELDS: SearchedFields = {
  strings: ['content', 'output', 'result', 'text', 'message'],
  lists: ['filenames', 'lines', 'results'],
  listSeparator: '\n',
}

/** The transcript draws these as a badge, so their words are not on screen. */
const INTERRUPTION_NOTICES: ReadonlySet<string> = new Set([INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE])

/** A closed reminder, however many lines it spans. An unclosed opening tag does not match. */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const nothingShown = (): readonly string[] => []

const CONTRIBUTIONS: ContributionTable = {
  user: userMessageLines,
  assistant: assistantMessageLines,
  attachment: message => queuedPromptLines(message.attachment),
  system: nothingShown,
  progress: nothingShown,
  grouped_tool_use: nothingShown,
  collapsed_read_search: nothingShown,
}

// The search runs on every keystroke over the whole transcript, so each message
// is worked out once. Messages are treated as immutable: a later change to the
// same object is not seen.
const searchTextCache = new WeakMap<RenderableMessage, string>()

/** The lower-cased text the transcript search matches a query against for one message. */
export function renderableSearchText(msg: RenderableMessage): string {
  return searchTextCache.get(msg) ?? rememberSearchText(msg)
}

function rememberSearchText(msg: RenderableMessage): string {
  const text = linesOf(msg.type, msg).join('\n').replace(SYSTEM_REMINDER_RE, '').toLowerCase()
  searchTextCache.set(msg, text)
  return text
}

/** The arguments a tool call shows, in their own case. */
export function toolUseSearchText(input: unknown): string {
  return isRecord(input) ? searchedLines(input, TOOL_CALL_FIELDS).join('\n') : ''
}

/** The text of a tool's own output (not what the model was sent), in its own case. */
export function toolResultSearchText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!isRecord(output)) return ''
  if (typeof output.stdout === 'string') {
    return typeof output.stderr === 'string' && output.stderr !== '' ? `${output.stdout}\n${output.stderr}` : output.stdout
  }
  if (isRecord(output.file) && typeof output.file.content === 'string') return output.file.content
  return searchedLines(output, TOOL_OUTPUT_FIELDS).join('\n')
}

function linesOf<K extends MessageType>(type: K, message: MessageOf<K>): readonly string[] {
  return CONTRIBUTIONS[type](message)
}

function userMessageLines(message: MessageOf<'user'>): readonly string[] {
  const content: string | readonly ContentBlockParam[] = message.message.content
  if (typeof content === 'string') return INTERRUPTION_NOTICES.has(content) ? [] : [content]
  const lines: string[] = []
  let toolOutputShown = false
  for (const block of content) {
    if (block.type === 'text' && !INTERRUPTION_NOTICES.has(block.text)) lines.push(block.text)
    // The tool's output is drawn once for the message, however many result blocks carry it.
    if (block.type === 'tool_result' && !toolOutputShown) {
      lines.push(toolResultSearchText(message.toolUseResult))
      toolOutputShown = true
    }
  }
  return lines
}

function assistantMessageLines(message: MessageOf<'assistant'>): readonly string[] {
  const content: readonly BetaContentBlock[] = message.message.content
  return content.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool_use') return [toolUseSearchText(block.input)]
    return []
  })
}

/** A prompt the user typed while the agent was busy. Task notifications and injected prompts are not the user's. */
function queuedPromptLines(attachment: Attachment): readonly string[] {
  if (attachment.type !== 'queued_command') return []
  if (attachment.commandMode === 'task-notification' || attachment.isMeta) return []
  const prompt: string | readonly ContentBlockParam[] = attachment.prompt
  if (typeof prompt === 'string') return [prompt]
  return prompt.flatMap(block => (block.type === 'text' ? [block.text] : []))
}

function searchedLines(record: Record<string, unknown>, fields: SearchedFields): string[] {
  const lines: string[] = []
  for (const field of fields.strings) {
    const value = record[field]
    if (typeof value === 'string') lines.push(value)
  }
  for (const field of fields.lists) {
    const value = record[field]
    // An empty list shows nothing, so it adds no line.
    if (isStringList(value) && value.length > 0) lines.push(value.join(fields.listSeparator))
  }
  return lines
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
