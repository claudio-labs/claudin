import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { feature } from 'bun:bundle'
import { memoryFreshnessNote } from 'src/memory/memdir/memoryAge.js'
import type { ToolUseContext } from 'src/Tool.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { addLineNumbers } from 'src/shared/fs/file.js'
import { mapNotebookCellsToToolResult } from 'src/shared/fs/notebook.js'
import { getCanonicalName, getMainLoopModel } from 'src/utils/model/model.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { AUTO_OUTLINE_PIVOT_FOOTER } from 'src/tools/FileReadTool/outlineView.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import type { Output } from 'src/tools/FileReadTool/schemas.js'
import {
  detectSerialReadPattern,
  markFiredAndCheck,
  SERIAL_READ_NUDGE_REMINDER,
} from 'src/tools/FileReadTool/serialReadNudge.js'

/** Format file content with line numbers. */
function formatFileLines(file: {
  content: string
  startLine: number
  numLines: number
}): string {
  if (file.content === '' && file.numLines > 0) {
    // A single empty line (file containing only '\n'). addLineNumbers
    // returns '' for empty content, so derive the bare prefix from it —
    // format a one-space line and trim, which works for both the compact
    // and the padded prefix format.
    return addLineNumbers({ content: ' ', startLine: file.startLine }).trimEnd()
  }
  return addLineNumbers(file)
}

export const CYBER_RISK_MITIGATION_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n'

// Models where cyber risk mitigation should be skipped
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6', 'claude-opus-4-7'])

function shouldIncludeFileReadMitigation(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) {
    return false
  }
  const shortName = getCanonicalName(getMainLoopModel())
  return !MITIGATION_EXEMPT_MODELS.has(shortName)
}

/**
 * Side-channel from call() to mapToolResultToToolResultBlockParam: mtime
 * of auto-memory files, keyed by the `data` object identity. Avoids
 * adding a presentation-only field to the output schema (which flows
 * into SDK types) and avoids sync fs in the mapper. WeakMap auto-GCs
 * when the data object becomes unreachable after rendering.
 */
const memoryFileMtimes = new WeakMap<object, number>()

function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

// Side-channel from call() to mapToolResultToToolResultBlockParam: flag the
// `data` object whose tool_result should carry the serial-read nudge.
// Same pattern as memoryFileMtimes — keyed on data identity, GCs naturally.
const serialReadNudgeFlagged: WeakSet<object> = new WeakSet()

function shouldEmitSerialReadNudge(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) return false
  // feature() from bun:bundle must appear directly in if/ternary; the build
  // preprocessor replaces it with a boolean literal before bundling.
  return feature('SERIAL_READ_NUDGE') ? true : false
}

/**
 * Inspects the recent assistant history on context.messages and, if the
 * serial-Read narration pattern is present and we haven't already fired
 * this turn, marks the data object so the mapper appends the nudge.
 *
 * Only applies to plain `text` reads — that's the path that carries the
 * narration cost in practice. Outline/image/PDF/notebook/file_unchanged
 * results stay clean.
 */
export function maybeFlagSerialReadNudge(
  data: unknown,
  context: ToolUseContext,
): void {
  if (!shouldEmitSerialReadNudge()) return
  if (!data || typeof data !== 'object') return
  // Limit injection to the standard text read result; the nudge talks about
  // "sequential single-file Reads", so attaching it to an outline/image/PDF
  // would be off-message.
  const type = (data as { type?: string }).type
  if (type !== 'text') return
  const messages = context.messages
  if (!Array.isArray(messages)) return
  if (!detectSerialReadPattern(messages)) return
  if (!markFiredAndCheck(messages)) return
  serialReadNudgeFlagged.add(data as object)
}

/**
 * Writes the auto-memory mtime side-channel entry read back by
 * mapReadResultToToolResultBlock. Exported so readDispatch.ts records it on the
 * one WeakMap this module owns, rather than keeping a second copy.
 */
export function markMemoryFileMtime(data: object, mtimeMs: number): void {
  memoryFileMtimes.set(data, mtimeMs)
}

export function mapReadResultToToolResultBlock(
  data: Output,
  toolUseID: string,
): ToolResultBlockParam {
  switch (data.type) {
    case 'image': {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              data: data.file.base64,
              media_type: data.file.type,
            },
          },
        ],
      }
    }
    case 'notebook':
      return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
    case 'pdf':
      // Return PDF metadata only - the actual content is sent as a supplemental DocumentBlockParam
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
      }
    case 'parts':
      // Extracted page images are read and sent as image blocks in mapToolResultToAPIMessage
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
      }
    case 'file_unchanged':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: FILE_UNCHANGED_STUB,
      }
    case 'outline':
      // Pre-rendered skeleton — no cat -n line prefixes, no mitigation
      // reminder. Sent verbatim. AUTO_OUTLINE_ON_ELISION pivots append a
      // one-line footer so the model knows the body was withheld
      // intentionally and how to opt in to the full content.
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.file.autoPivot
          ? data.file.content + AUTO_OUTLINE_PIVOT_FOOTER
          : data.file.content,
      }
    case 'clip_pin_fallback':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.file.message,
      }
    case 'text': {
      let content: string

      // Branch on numLines, not content truthiness: a file containing only
      // '\n' has one (empty) line — content is '' but it is NOT empty.
      if (data.file.numLines > 0) {
        content =
          memoryFileFreshnessPrefix(data) +
          formatFileLines(data.file) +
          (shouldIncludeFileReadMitigation()
            ? CYBER_RISK_MITIGATION_REMINDER
            : '') +
          (serialReadNudgeFlagged.has(data) ? SERIAL_READ_NUDGE_REMINDER : '')
      } else {
        // Determine the appropriate warning message
        content =
          data.file.totalLines === 0
            ? '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
            : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} ${data.file.totalLines === 1 ? 'line' : 'lines'}.</system-reminder>`
      }

      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
      }
    }
  }
}
