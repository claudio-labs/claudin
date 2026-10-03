/**
 * What the session list shows for one transcript, decided from its first and
 * last 64 KiB alone. Pure: the reader that fills the windows, and the raw
 * prefix reader passed in, are in `liteMetadata.ts`.
 *
 * Every line is classified by its top-level `type` before a field is read
 * from it, so a member of the same name inside a tool input or result is
 * never taken for session metadata.
 */
import { extractFirstPromptFromChunk } from 'src/sessions/pure/firstPrompt.js'
import { extractTailStats } from 'src/sessions/indexing/sessionStats.js'
import { type WindowEntry, windowEntries } from 'src/sessions/indexing/liteRead/windowEntries.js'

export type ListedFields = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  contextTokens?: number
  costUSD?: number
}

export type TranscriptWindows = {
  head: string
  tail: string
  /** True when the tail does not start at the start of the file. */
  tailStartsMidLine: boolean
}

export type ListedFieldsDeps = {
  /** The start of the first string member `key` of raw text, up to `maxLen` characters; `''` when absent. */
  stringPrefix(text: string, key: string, maxLen: number): string
}

/** Shown when a session has neither a prompt nor a title to list it by. */
const UNTITLED_SESSION = '(session)'
/** How much of a raw prompt titles a session when no line can be parsed. */
const RAW_TITLE_MAX_CHARS = 200

/** Lines of the conversation itself; the other types are metadata entries. */
const MESSAGE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])

type Picker<T> = (entry: WindowEntry) => T | undefined

function first<T>(entries: readonly WindowEntry[], pick: Picker<T>): T | undefined {
  for (const entry of entries) {
    const value = pick(entry)
    if (value !== undefined) return value
  }
  return undefined
}

function last<T>(entries: readonly WindowEntry[], pick: Picker<T>): T | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const value = pick(entries[i]!)
    if (value !== undefined) return value
  }
  return undefined
}

function stringMember(entry: WindowEntry, key: string): string | undefined {
  const value = entry[key]
  return typeof value === 'string' ? value : undefined
}

/** A string member of the metadata entries of one type. */
function entryField(type: string, key: string): Picker<string> {
  return entry => (entry.type === type ? stringMember(entry, key) : undefined)
}

/** A string member at the top level of a conversation line. */
function messageField(key: string): Picker<string> {
  return entry => (isMessageLine(entry) ? stringMember(entry, key) : undefined)
}

function isMessageLine(entry: WindowEntry): boolean {
  return typeof entry.type === 'string' && MESSAGE_TYPES.has(entry.type)
}

/** A PR number as the writer stores it, a number or a numeric string; only positive ones count. */
function positivePrNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function lastPrNumber(tail: readonly WindowEntry[]): number | undefined {
  const entry = last(tail, e => (e.type === 'pr-link' && 'prNumber' in e ? e : undefined))
  return entry ? positivePrNumber(entry.prNumber) : undefined
}

/** The prompt the list names a session by; finding 6 keeps the last prompt first. */
function listedPrompt(head: string, tail: readonly WindowEntry[], deps: ListedFieldsDeps): string {
  return (
    last(tail, entryField('last-prompt', 'lastPrompt')) ||
    extractFirstPromptFromChunk(head) ||
    deps.stringPrefix(head, 'content', RAW_TITLE_MAX_CHARS) ||
    deps.stringPrefix(head, 'text', RAW_TITLE_MAX_CHARS)
  )
}

/** A user title anywhere beats an AI title anywhere; within each kind, the tail beats the head. */
function listedTitle(head: readonly WindowEntry[], tail: readonly WindowEntry[]): string | undefined {
  const userTitle = entryField('custom-title', 'customTitle')
  const aiTitle = entryField('ai-title', 'aiTitle')
  return last(tail, userTitle) || last(head, userTitle) || last(tail, aiTitle) || last(head, aiTitle) || undefined
}

/** The last value in the tail, else the first in the head. */
function latestKnown(head: readonly WindowEntry[], tail: readonly WindowEntry[], pick: Picker<string>): string | undefined {
  return last(tail, pick) ?? first(head, pick)
}

export function readListedFields(
  { head, tail, tailStartsMidLine }: TranscriptWindows,
  deps: ListedFieldsDeps,
): ListedFields {
  const headEntries = windowEntries(head, false)
  const tailEntries = windowEntries(tail, tailStartsMidLine)
  const customTitle = listedTitle(headEntries, tailEntries)
  const prompt = listedPrompt(head, tailEntries, deps)
  const stats = extractTailStats(tail)
  return {
    firstPrompt: (prompt || customTitle) ? prompt : UNTITLED_SESSION,
    customTitle,
    tag: last(tailEntries, entryField('tag', 'tag')) || undefined,
    gitBranch: latestKnown(headEntries, tailEntries, messageField('gitBranch')),
    projectPath: first(headEntries, messageField('cwd')),
    teamName: first(headEntries, messageField('teamName')),
    agentSetting: latestKnown(headEntries, tailEntries, entryField('agent-setting', 'agentSetting')),
    isSidechain: headEntries.some(entry => isMessageLine(entry) && entry.isSidechain === true),
    prNumber: lastPrNumber(tailEntries),
    prUrl: last(tailEntries, entryField('pr-link', 'prUrl')),
    prRepository: last(tailEntries, entryField('pr-link', 'prRepository')),
    summary: stats.summary,
    costUSD: stats.costUSD,
    contextTokens: stats.contextTokens,
  }
}
