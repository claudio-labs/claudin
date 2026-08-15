import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import {
  buildLargeToolResultMessage,
  generatePreview,
  PREVIEW_SIZE_BYTES,
} from 'src/agent/tools/toolResultStorage.js'
import { buildImageToolResult } from 'src/tools/BashTool/utils.js'

/**
 * Shared model-facing result mapper for the shell-family tools.
 *
 * BashTool, PowerShellTool and the Git tool all end a run with the same shape —
 * stdout, stderr, an interrupted flag, an optional persisted-output path and an
 * optional background task id — and all three have to fold that into a single
 * `tool_result` block. Keeping three hand-rolled copies of that fold is how the
 * three drift apart; the observable output is identical, so it lives here.
 *
 * What deliberately stays at the call sites: BashTool's `structuredContent`
 * early return (only Bash produces it) and everything about the backgrounding
 * lifecycle itself. This module only formats what the run already produced.
 */

const EOL = '\n'

/**
 * Assistant-mode blocking budget. A foreground command that outruns it is moved
 * to the background, and the message below tells the model so. Shared because
 * both shells background on the same budget and the wording quotes it.
 */
export const ASSISTANT_BLOCKING_BUDGET_MS = 15_000

/** Leading blank lines carry no information and cost tokens on every result. */
const LEADING_BLANK_LINES_RE = /^(\s*\n)+/

export type ShellToolResultData = {
  interrupted?: boolean
  stdout?: string | null
  stderr?: string | null
  isImage?: boolean
  backgroundTaskId?: string | null
  backgroundedByUser?: boolean
  assistantAutoBackgrounded?: boolean
  persistedOutputPath?: string | null
  persistedOutputSize?: number
}

/**
 * Strip leading blank lines and trailing whitespace. Exported for the persisted
 * -output path, which previews the trimmed text rather than the raw capture.
 */
export function trimShellStdout(stdout: string): string {
  if (!stdout) return ''
  return stdout.replace(LEADING_BLANK_LINES_RE, '').trimEnd()
}

/**
 * The `<error>` suffix an aborted run carries, appended after stderr so the
 * model sees both what the command said and that it never finished.
 */
export function buildShellErrorMessage(
  stderr: string,
  interrupted: boolean | undefined,
): string {
  let errorMessage = stderr.trim()
  if (interrupted) {
    if (stderr) errorMessage += EOL
    errorMessage += '<error>Command was aborted before completion</error>'
  }
  return errorMessage
}

/** Where a backgrounded run went, and why it went there. */
export function buildShellBackgroundInfo({
  backgroundTaskId,
  backgroundedByUser,
  assistantAutoBackgrounded,
}: Pick<
  ShellToolResultData,
  'backgroundTaskId' | 'backgroundedByUser' | 'assistantAutoBackgrounded'
>): string {
  if (!backgroundTaskId) return ''
  const outputPath = getTaskOutputPath(backgroundTaskId)
  if (assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${backgroundTaskId}. It is still running — you will be notified when it completes. Output is being written to: ${outputPath}. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`
  }
  if (backgroundedByUser) {
    return `Command was manually backgrounded by user with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`
  }
  return `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`
}

/**
 * Fold a shell run into the model-facing `tool_result` block.
 *
 * `stdout`/`stderr` are typed optional-and-nullable on purpose: the shell layer
 * interleaves both streams onto one fd, so callers routinely pass `''` for
 * stderr, and a killed process can leave either side undefined.
 */
export function mapShellResultToToolResultBlockParam(
  data: ShellToolResultData,
  toolUseID: string,
): ToolResultBlockParam {
  const normalizedStdout = typeof data.stdout === 'string' ? data.stdout : ''
  const normalizedStderr = typeof data.stderr === 'string' ? data.stderr : ''

  // An image result replaces the whole block; fall through when the payload
  // turns out not to be a data URI after all.
  if (data.isImage) {
    const block = buildImageToolResult(normalizedStdout, toolUseID)
    if (block) return block
  }

  const trimmed = trimShellStdout(normalizedStdout)
  let processedStdout = trimmed
  if (data.persistedOutputPath) {
    const preview = generatePreview(trimmed, PREVIEW_SIZE_BYTES)
    processedStdout = buildLargeToolResultMessage({
      filepath: data.persistedOutputPath,
      originalSize: data.persistedOutputSize ?? 0,
      isJson: false,
      preview: preview.preview,
      hasMore: preview.hasMore,
    })
  }

  const errorMessage = buildShellErrorMessage(normalizedStderr, data.interrupted)
  const backgroundInfo = buildShellBackgroundInfo(data)

  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content: [processedStdout, errorMessage, backgroundInfo]
      .filter(Boolean)
      .join('\n'),
    is_error: data.interrupted,
  }
}
