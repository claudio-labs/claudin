import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { shellErrorPrefix } from 'src/agent/tools/toolErrors.js'
import { adoptOutputFile, pageSavedFile, type SavedOutput } from 'src/agent/tools/toolResultStorage.js'
import { SHELL_RESULT_MAX_CHARS } from 'src/platform/shell/outputLimits.js'
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
 * lifecycle itself. This module formats what the run produced; a run too
 * large for its result is saved and paged by storage (`adoptOutputFile`,
 * `pageSavedFile`), and this module only says how much room the page gets.
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
  /** Set when only part of the output could be kept (`adoptOutputFile`). */
  persistedOutputSavedBytes?: number
  /** The saved output's line count, for its page. */
  persistedOutputLines?: number
  /**
   * A note on a file read, after stdout: the files a read too long to show
   * whole left out, and the ones that count as read (BashTool's
   * `fitOverBudgetRead` and `creditShownFiles`). For the model, never the TUI,
   * which renders stdout.
   */
  readNote?: string | null
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
 * A run whose output passed what it keeps in memory wrote all of it to a task
 * file: storage saves it where its page will point. Called for a failing run
 * too, whose error is paged from the same file. Undefined when nothing
 * spilled, or the file is gone.
 */
export function saveSpilledRun(result: { outputFilePath?: string; outputTaskId?: string }): Promise<SavedOutput | undefined> {
  if (!result.outputFilePath || !result.outputTaskId) return Promise.resolve(undefined)
  return adoptOutputFile(result.outputFilePath, result.outputTaskId)
}

/**
 * What a failing run that spilled carries as its output in its ShellError:
 * the page of its saved output, sized to leave room for exactly what
 * `formatError` puts around it — `others` is the rest of the error's own text
 * (Bash's sandbox note, PowerShell's stderr) — so the error stays under the
 * shells' line and the tool loop never pages it again. Every consumer of a
 * ShellError reads the page and its pointer, not a first chunk.
 */
export function pageFailedShellRun(
  saved: SavedOutput,
  around: { code: number; interrupted: boolean; others: string },
): string {
  const room = shellErrorPrefix(around.code, around.interrupted).length + around.others.length + 1
  return pageSavedFile(saved, SHELL_RESULT_MAX_CHARS - room, '')
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
  const errorMessage = buildShellErrorMessage(normalizedStderr, data.interrupted)
  const backgroundInfo = buildShellBackgroundInfo(data)
  const after = [data.readNote, errorMessage, backgroundInfo].filter(Boolean)

  let processedStdout = trimmed
  if (data.persistedOutputPath) {
    // A run too large for its result saved its output whole: page it, leaving
    // room for the lines after the page.
    processedStdout = pageSavedFile(
      {
        filepath: data.persistedOutputPath,
        originalSize: data.persistedOutputSize,
        savedBytes: data.persistedOutputSavedBytes,
        lines: data.persistedOutputLines,
      },
      SHELL_RESULT_MAX_CHARS - after.reduce((n, part) => n + part!.length + 1, 0),
      normalizedStdout,
    )
  }

  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content: [processedStdout, ...after].filter(Boolean).join('\n'),
    is_error: data.interrupted,
  }
}
