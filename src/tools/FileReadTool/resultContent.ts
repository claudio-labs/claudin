/**
 * Model-facing rendering of a Read result.
 *
 * Two per-result reminders ride on the text arm, both appended once at
 * execution time (`toolExecution.ts` maps the block when the tool returns,
 * never on a later render), so what lands in history is byte-stable:
 *
 * - the cyber-risk mitigation reminder. Skipped for the models in
 *   `MITIGATION_EXEMPT_MODELS` and under `CLAUDIN_DISABLE_TOOL_REMINDERS=1`.
 *   It is sent on an agent's FIRST text read only — the 2026-09 census
 *   counted it 375× in one week, ~75 tokens each, every copy staying in
 *   context for the rest of the session. Promoted to default on 2026-09-09
 *   after `scripts/bench/ab/read-reminder-probe.ts` (Sonnet 5, N=3) showed
 *   3 reads → 1 reminder with the answer unchanged.
 *   `CLAUDIN_DISABLE_READ_REMINDER_ONCE=1` restores the every-read behavior.
 * - the serial-read nudge (`serialReadNudge.ts`).
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { feature } from 'bun:bundle'
import { memoryFreshnessNote } from 'src/memory/memdir/memoryAge.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { addLineNumbers } from 'src/shared/fs/file.js'
import { mapNotebookCellsToToolResult } from 'src/shared/fs/notebook.js'
import { getCanonicalName, getMainLoopModel } from 'src/providers/model/model.js'
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

// Models where cyber risk mitigation should be skipped. Canonical short
// names as returned by getCanonicalName (firstPartyNameToCanonical).
const MITIGATION_EXEMPT_MODELS = new Set([
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-5',
  'claude-fable-5-1',
])

/** Exported for tests — the model gate as a pure function of the short name. */
export function isMitigationExemptModel(shortName: string): boolean {
  return MITIGATION_EXEMPT_MODELS.has(shortName)
}

// The model gate reads the main-loop model through this seam so the test can
// pin a model without touching bootstrap state — several test files
// `mock.module` the model/state modules and those mocks leak across the run
// (testing.md: cross-file mock leaks), which made the override unreliable in CI.
let mitigationModelShortName: () => string = () =>
  getCanonicalName(getMainLoopModel())

export function _setMitigationModelResolverForTesting(
  resolver: (() => string) | undefined,
): void {
  mitigationModelShortName =
    resolver ?? (() => getCanonicalName(getMainLoopModel()))
}

function shouldIncludeFileReadMitigation(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) {
    return false
  }
  return !isMitigationExemptModel(mitigationModelShortName())
}

function readReminderOnceEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDIN_DISABLE_READ_REMINDER_ONCE)
}

// Side-channel from call() to mapToolResultToToolResultBlockParam for the
// once-per-agent mitigation reminder: the agent keys that already received
// it this process, and the `data` object whose tool_result carries it.
// Same identity-keyed pattern as serialReadNudgeFlagged — the decision is
// taken in call() (where the agent id is known) and read back in the
// mapper, which has no context.
const readReminderSeenAgents = new Set<string>()
const readReminderFlagged: WeakSet<object> = new WeakSet()

/**
 * Marks `data` as the result that carries the mitigation reminder when this
 * is the agent's first non-empty text read (unless
 * CLAUDIN_DISABLE_READ_REMINDER_ONCE restores the every-read behavior).
 * Empty files and non-text arms never carry the reminder, so they do not
 * consume the agent's slot.
 */
export function maybeFlagReadReminder(
  data: unknown,
  context: Pick<ToolUseContext, 'agentId'>,
): void {
  if (!readReminderOnceEnabled()) return
  if (!data || typeof data !== 'object') return
  const result = data as { type?: string; file?: { numLines?: number } }
  if (result.type !== 'text') return
  if (!(result.file && (result.file.numLines ?? 0) > 0)) return
  const key = context.agentId ?? 'main'
  if (readReminderSeenAgents.has(key)) return
  readReminderSeenAgents.add(key)
  readReminderFlagged.add(data)
}

function carriesMitigationReminder(data: object): boolean {
  if (!shouldIncludeFileReadMitigation()) return false
  return !readReminderOnceEnabled() || readReminderFlagged.has(data)
}

export function _resetReadReminderStateForTesting(): void {
  readReminderSeenAgents.clear()
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
          (carriesMitigationReminder(data) ? CYBER_RISK_MITIGATION_REMINDER : '') +
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
