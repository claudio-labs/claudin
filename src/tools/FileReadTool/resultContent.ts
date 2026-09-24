/**
 * Model-facing rendering of a Read result.
 *
 * One per-result reminder rides on the text arm, appended once at execution
 * time (`toolExecution.ts` maps the block when the tool returns, never on a
 * later render), so what lands in history is byte-stable: the cyber-risk
 * mitigation reminder. It is skipped for the models in
 * `MITIGATION_EXEMPT_MODELS` and under `CLAUDIN_DISABLE_TOOL_REMINDERS=1`, and
 * is sent on an agent's FIRST text read only — the 2026-09 census counted it
 * 375× in one week, ~75 tokens each, every copy staying in context for the
 * rest of the session. Promoted to default on 2026-09-09 after a probe
 * (Sonnet 5, N=3) showed 3 reads → 1 reminder with the answer unchanged; the
 * every-read arm it was measured against has since been removed.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { memoryFreshnessNote } from 'src/memory/memdir/memoryAge.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { addLineNumbers } from 'src/shared/fs/file.js'
import { mapNotebookCellsToToolResult } from 'src/tools/shared/notebook.js'
import { getCanonicalName, getMainLoopModel } from 'src/providers/model/model.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { AUTO_OUTLINE_PIVOT_FOOTER } from 'src/tools/FileReadTool/outlineView.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import type { Output } from 'src/tools/FileReadTool/schemas.js'

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
  'claude-opus-5-5',
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

// Side-channel from call() to mapToolResultToToolResultBlockParam for the
// once-per-agent mitigation reminder: the agent keys that already received
// it this process, and the `data` object whose tool_result carries it.
// Identity-keyed on the result object: the decision is taken in call()
// (where the agent id is known) and read back in the mapper, which has no
// context.
const readReminderSeenAgents = new Set<string>()
const readReminderFlagged: WeakSet<object> = new WeakSet()

/**
 * Marks `data` as the result that carries the mitigation reminder when this
 * is the agent's first non-empty text read. Empty files and non-text arms
 * never carry the reminder, so they do not consume the agent's slot.
 */
export function maybeFlagReadReminder(
  data: unknown,
  context: Pick<ToolUseContext, 'agentId'>,
): void {
  if (!data || typeof data !== 'object') return
  const result = data as { type?: string; file?: { numLines?: number } }
  if (result.type !== 'text') return
  if (!(result.file && (result.file.numLines ?? 0) > 0)) return
  const key = context.agentId ?? 'main'
  if (readReminderSeenAgents.has(key)) return
  readReminderSeenAgents.add(key)
  readReminderFlagged.add(data)
}

/**
 * Undo maybeFlagReadReminder for a result that will never be rendered: the
 * batch Read reads a file, then leaves it out when it does not fit the budget
 * (batchRead.ts), and that file must not spend the agent's one reminder.
 */
export function releaseReadReminder(
  data: unknown,
  context: Pick<ToolUseContext, 'agentId'>,
): void {
  if (!data || typeof data !== 'object' || !readReminderFlagged.has(data)) {
    return
  }
  readReminderFlagged.delete(data)
  readReminderSeenAgents.delete(context.agentId ?? 'main')
}

function carriesMitigationReminder(data: object): boolean {
  if (!shouldIncludeFileReadMitigation()) return false
  return readReminderFlagged.has(data)
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
    case 'batch':
      // Rendered in call(), per file, through this same function: the budget
      // is measured on exactly these bytes (batchRead.ts).
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.content,
      }
    case 'text': {
      let content: string

      // Branch on numLines, not content truthiness: a file containing only
      // '\n' has one (empty) line — content is '' but it is NOT empty.
      if (data.file.numLines > 0) {
        content =
          memoryFileFreshnessPrefix(data) +
          formatFileLines(data.file) +
          (carriesMitigationReminder(data) ? CYBER_RISK_MITIGATION_REMINDER : '')
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

/**
 * The text a Read result renders to now, for a holder of the result rather
 * than of its block: the @-mention attachment (FileAttachment.rendered),
 * which is rendered on every request and again by a resumed process. The
 * Read tool's own result needs none of this — its block is mapped once, at
 * execution (see the header).
 *
 * Only the text arm reads state the result does not carry: the mitigation
 * reminder and the memory-age note ride side channels keyed on the object's
 * identity, which a transcript round trip loses, and the model gate and the
 * line-number format are read live. The other arms render from their payload
 * alone and return undefined.
 */
export function snapshotReadResultText(data: Output): string | undefined {
  if (data.type !== 'text') return undefined
  const { content } = mapReadResultToToolResultBlock(data, '1')
  return typeof content === 'string' ? content : undefined
}
