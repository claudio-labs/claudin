import type { StructuredPatchHunk } from 'diff'
import { useMemo, useRef } from 'react'
import type { ApplyPatchFileResult } from '../tools/ApplyPatchTool/applyPatch.js'
import type { FileEditOutput } from '../tools/FileEditTool/types.js'
import type { Output as FileWriteOutput } from '../tools/FileWriteTool/FileWriteTool.js'
import type { Message } from '../types/message.js'

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

function isFileEditResult(result: unknown): result is FileEditResult {
  if (!result || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  // FileEditTool: has structuredPatch with content
  // FileWriteTool (update): has structuredPatch with content
  // FileWriteTool (create): has type='create' and content (structuredPatch is empty)
  const hasFilePath = typeof r.filePath === 'string'
  const hasStructuredPatch =
    Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0
  const isNewFile = r.type === 'create' && typeof r.content === 'string'
  return hasFilePath && (hasStructuredPatch || isNewFile)
}

function isFileWriteOutput(result: FileEditResult): result is FileWriteOutput {
  return (
    'type' in result && (result.type === 'create' || result.type === 'update')
  )
}

/** apply_patch returns `{ files: [...] }` instead of a top-level filePath. */
export function isApplyPatchResult(
  result: unknown,
): result is { files: ApplyPatchFileResult[] } {
  if (!result || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if (!Array.isArray(r.files)) return false
  return r.files.every(f => {
    if (!f || typeof f !== 'object') return false
    const file = f as Record<string, unknown>
    return (
      typeof file.absPath === 'string' && Array.isArray(file.structuredPatch)
    )
  })
}

/** Merge one file's hunks into the current turn (apply_patch fans out files). */
export function mergeFileDiff(
  turn: TurnDiff,
  filePath: string,
  hunks: StructuredPatchHunk[],
  isNewFile: boolean,
): void {
  let fileEntry = turn.files.get(filePath)
  if (!fileEntry) {
    fileEntry = {
      filePath,
      hunks: [],
      isNewFile,
      linesAdded: 0,
      linesRemoved: 0,
    }
    turn.files.set(filePath, fileEntry)
  }
  fileEntry.hunks.push(...hunks)
  const { added, removed } = countHunkLines(hunks)
  fileEntry.linesAdded += added
  fileEntry.linesRemoved += removed
  if (isNewFile) fileEntry.isNewFile = true
}

function countHunkLines(hunks: StructuredPatchHunk[]): {
  added: number
  removed: number
} {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function getUserPromptPreview(message: Message): string {
  if (message.type !== 'user') return ''
  const content = message.message.content
  const text = typeof content === 'string' ? content : ''
  // Truncate to ~30 chars
  if (text.length <= 30) return text
  return text.slice(0, 29) + '…'
}

function computeTurnStats(turn: TurnDiff): void {
  let totalAdded = 0
  let totalRemoved = 0
  for (const file of turn.files.values()) {
    totalAdded += file.linesAdded
    totalRemoved += file.linesRemoved
  }
  turn.stats = {
    filesChanged: turn.files.size,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
  }
}

/**
 * Apply one tool result to the current turn, fanning out edits per file.
 * Handles both the FileEdit/FileWrite shape (a top-level filePath) and the
 * apply_patch shape (`{ files: [...] }`, where a move keys on its destination).
 */
export function applyToolResultToTurn(turn: TurnDiff, result: unknown): void {
  if (isFileEditResult(result)) {
    const { filePath, structuredPatch } = result
    const isNewFile = 'type' in result && result.type === 'create'

    // Get or create file entry
    let fileEntry = turn.files.get(filePath)
    if (!fileEntry) {
      fileEntry = {
        filePath,
        hunks: [],
        isNewFile,
        linesAdded: 0,
        linesRemoved: 0,
      }
      turn.files.set(filePath, fileEntry)
    }

    // For new files, generate synthetic hunk from content
    if (
      isNewFile &&
      structuredPatch.length === 0 &&
      isFileWriteOutput(result)
    ) {
      const content = result.content
      const lines = content.split('\n')
      const syntheticHunk: StructuredPatchHunk = {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map(l => '+' + l),
      }
      fileEntry.hunks.push(syntheticHunk)
      fileEntry.linesAdded += lines.length
    } else {
      // Append hunks (same file may be edited multiple times in a turn)
      fileEntry.hunks.push(...structuredPatch)

      // Update line counts
      const { added, removed } = countHunkLines(structuredPatch)
      fileEntry.linesAdded += added
      fileEntry.linesRemoved += removed
    }

    // If file was created and then edited, it's still a new file
    if (isNewFile) {
      fileEntry.isNewFile = true
    }
  } else if (isApplyPatchResult(result)) {
    for (const file of result.files) {
      // A move's resulting file lives at the destination path.
      const filePath =
        file.type === 'move' && file.movePath ? file.movePath : file.absPath
      mergeFileDiff(turn, filePath, file.structuredPatch, file.type === 'add')
    }
  }
}

/**
 * Extract turn-based diffs from messages.
 * A turn is defined as a user prompt followed by assistant responses and tool results.
 * Each turn with file edits is included in the result.
 *
 * Uses incremental accumulation - only processes new messages since last render.
 */
export function useTurnDiffs(messages: Message[]): TurnDiff[] {
  const cache = useRef<TurnDiffCache>({
    completedTurns: [],
    currentTurn: null,
    lastProcessedIndex: 0,
    lastTurnIndex: 0,
  })

  return useMemo(() => {
    const c = cache.current

    // Reset if messages shrunk (user rewound conversation)
    if (messages.length < c.lastProcessedIndex) {
      c.completedTurns = []
      c.currentTurn = null
      c.lastProcessedIndex = 0
      c.lastTurnIndex = 0
    }

    // Process only new messages
    for (let i = c.lastProcessedIndex; i < messages.length; i++) {
      const message = messages[i]
      if (!message || message.type !== 'user') continue

      // Check if this is a user prompt (not a tool result)
      const isToolResult =
        message.toolUseResult ||
        (Array.isArray(message.message.content) &&
          message.message.content[0]?.type === 'tool_result')

      if (!isToolResult && !message.isMeta) {
        // Start a new turn on user prompt
        if (c.currentTurn && c.currentTurn.files.size > 0) {
          computeTurnStats(c.currentTurn)
          c.completedTurns.push(c.currentTurn)
        }

        c.lastTurnIndex++
        c.currentTurn = {
          turnIndex: c.lastTurnIndex,
          userPromptPreview: getUserPromptPreview(message),
          timestamp: message.timestamp,
          files: new Map(),
          stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
        }
      } else if (c.currentTurn && message.toolUseResult) {
        // Collect file edits from tool results
        applyToolResultToTurn(c.currentTurn, message.toolUseResult)
      }
    }

    c.lastProcessedIndex = messages.length

    // Build result: completed turns + current turn if it has files
    const result = [...c.completedTurns]
    if (c.currentTurn && c.currentTurn.files.size > 0) {
      // Compute stats for current turn before including
      computeTurnStats(c.currentTurn)
      result.push(c.currentTurn)
    }

    // Return in reverse order (most recent first)
    return result.reverse()
  }, [messages])
}
