import type { StructuredPatchHunk } from 'diff'
import { useMemo, useRef } from 'react'
import type { ApplyPatchFileResult } from 'src/tools/ApplyPatchTool/applyPatch.js'
import type { FileEditOutput } from 'src/tools/FileEditTool/types.js'
import type { Output as FileWriteOutput } from 'src/tools/FileWriteTool/FileWriteTool.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'

export type TurnFileDiff = {
  filePath: string
  hunks: StructuredPatchHunk[]
  isNewFile: boolean
  linesAdded: number
  linesRemoved: number
}

export type TurnDiff = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<string, TurnFileDiff>
  stats: {
    filesChanged: number
    linesAdded: number
    linesRemoved: number
  }
}

type FileEditResult = FileEditOutput | FileWriteOutput

type TurnDiffCache = {
  completedTurns: TurnDiff[]
  currentTurn: TurnDiff | null
  lastProcessedIndex: number
  lastTurnIndex: number
}

const PREVIEW_MAX_CHARS = 30

function isFileEditResult(result: unknown): result is FileEditResult {
  if (typeof result !== 'object' || result === null) return false
  const shape = result as { filePath?: unknown; structuredPatch?: unknown }
  return typeof shape.filePath === 'string' && Array.isArray(shape.structuredPatch)
}

function isFileWriteOutput(result: FileEditResult): result is FileWriteOutput {
  return 'type' in result && (result.type === 'create' || result.type === 'update')
}

/** Patch returns `{ files: [...] }` instead of a top-level filePath. */
export function isApplyPatchResult(
  result: unknown,
): result is { files: ApplyPatchFileResult[] } {
  if (typeof result !== 'object' || result === null || !('files' in result)) return false
  const { files } = result
  return Array.isArray(files) && files.every(isPatchedFile)
}

function isPatchedFile(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const shape = entry as { absPath?: unknown; structuredPatch?: unknown }
  return typeof shape.absPath === 'string' && Array.isArray(shape.structuredPatch)
}

/** Merge one file's hunks into the current turn (Patch fans out files). */
export function mergeFileDiff(
  turn: TurnDiff,
  filePath: string,
  hunks: StructuredPatchHunk[],
  isNewFile: boolean,
): void {
  const entry = turn.files.get(filePath) ?? {
    filePath,
    hunks: [],
    isNewFile: false,
    linesAdded: 0,
    linesRemoved: 0,
  }
  const { added, removed } = countHunkLines(hunks)
  turn.files.set(filePath, {
    filePath,
    hunks: [...entry.hunks, ...hunks],
    // A file the turn created stays new however often it is edited afterwards.
    isNewFile: entry.isNewFile || isNewFile,
    linesAdded: entry.linesAdded + added,
    linesRemoved: entry.linesRemoved + removed,
  })
  computeTurnStats(turn)
}

function countHunkLines(hunks: StructuredPatchHunk[]): {
  added: number
  removed: number
} {
  const lines = hunks.flatMap(hunk => hunk.lines)
  const marked = (sign: string) => lines.filter(line => line.startsWith(sign)).length
  return { added: marked('+'), removed: marked('-') }
}

function getUserPromptPreview(message: Message): string {
  if (message.type !== 'user') return ''
  const { content } = message.message
  if (typeof content !== 'string') return ''
  return content.length <= PREVIEW_MAX_CHARS ? content : `${content.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

function computeTurnStats(turn: TurnDiff): void {
  const files = [...turn.files.values()]
  const total = (pick: (file: TurnFileDiff) => number) => files.reduce((sum, file) => sum + pick(file), 0)
  turn.stats = {
    filesChanged: files.length,
    linesAdded: total(file => file.linesAdded),
    linesRemoved: total(file => file.linesRemoved),
  }
}

/**
 * Apply one tool result to the current turn, fanning out edits per file.
 * Handles both the FileEdit/FileWrite shape (a top-level filePath) and the
 * Patch shape (`{ files: [...] }`, where a move keys on its destination).
 */
export function applyToolResultToTurn(turn: TurnDiff, result: unknown): void {
  if (isApplyPatchResult(result)) {
    for (const file of result.files) {
      const filedUnder = file.type === 'move' && file.movePath ? file.movePath : file.absPath
      mergeFileDiff(turn, filedUnder, file.structuredPatch, file.type === 'add')
    }
    return
  }
  if (!isFileEditResult(result)) return

  const created = isFileWriteOutput(result) && result.type === 'create'
  if (result.structuredPatch.length > 0) {
    mergeFileDiff(turn, result.filePath, result.structuredPatch, created)
  } else if (created && typeof result.content === 'string') {
    mergeFileDiff(turn, result.filePath, createdFileHunks(result.content), true)
  }
}

/** A created file as one all-added hunk; a final newline ends the last line (finding 4). */
function createdFileHunks(content: string): StructuredPatchHunk[] {
  if (content === '') return []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body.split('\n').map(line => `+${line}`)
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
}

export function useTurnDiffs(messages: Message[]): TurnDiff[] {
  const lastReading = useRef<TranscriptReading | null>(null)
  return useMemo(() => {
    const reading = readTranscript(lastReading.current, messages)
    lastReading.current = reading
    return turnsNewestFirst(reading.cache)
  }, [messages])
}

/** What has been read so far, and the list it was read from. */
type TranscriptReading = {
  cache: TurnDiffCache
  source: readonly Message[]
}

/**
 * Folds the messages the previous reading has not seen into a copy of it. When
 * what was read is no longer the start of the list (a rewind, a compaction),
 * the list is read again from the start (finding 5).
 */
function readTranscript(previous: TranscriptReading | null, messages: readonly Message[]): TranscriptReading {
  const cache =
    previous && startsWithRead(messages, previous) ? resumeCache(previous.cache) : emptyCache()
  for (let index = cache.lastProcessedIndex; index < messages.length; index++) {
    foldMessage(cache, messages[index]!)
  }
  cache.lastProcessedIndex = messages.length
  return { cache, source: messages }
}

function startsWithRead(messages: readonly Message[], previous: TranscriptReading): boolean {
  if (messages === previous.source) return true
  const read = previous.cache.lastProcessedIndex
  if (messages.length < read) return false
  for (let index = 0; index < read; index++) {
    if (messages[index] !== previous.source[index]) return false
  }
  return true
}

function emptyCache(): TurnDiffCache {
  return { completedTurns: [], currentTurn: null, lastProcessedIndex: 0, lastTurnIndex: 0 }
}

/** A copy whose open turn can change without touching turns already handed out. */
function resumeCache(cache: TurnDiffCache): TurnDiffCache {
  const open = cache.currentTurn
  return {
    ...cache,
    completedTurns: [...cache.completedTurns],
    currentTurn: open && { ...open, files: new Map(open.files), stats: { ...open.stats } },
  }
}

function foldMessage(cache: TurnDiffCache, message: Message): void {
  if (message.type !== 'user' || message.isMeta) return
  if (isToolResultMessage(message)) {
    if (cache.currentTurn) applyToolResultToTurn(cache.currentTurn, message.toolUseResult)
    return
  }
  if (cache.currentTurn && cache.currentTurn.files.size > 0) cache.completedTurns.push(cache.currentTurn)
  cache.lastTurnIndex += 1
  cache.currentTurn = {
    turnIndex: cache.lastTurnIndex,
    userPromptPreview: getUserPromptPreview(message),
    timestamp: message.timestamp,
    files: new Map(),
    stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
  }
}

function isToolResultMessage(message: UserMessage): boolean {
  if (message.toolUseResult !== undefined) return true
  const { content } = message.message
  return Array.isArray(content) && content[0]?.type === 'tool_result'
}

function turnsNewestFirst(cache: TurnDiffCache): TurnDiff[] {
  const turns = cache.currentTurn?.files.size ? [...cache.completedTurns, cache.currentTurn] : cache.completedTurns
  return [...turns].reverse()
}
