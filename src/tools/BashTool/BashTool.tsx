import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { copyFile, stat as fsStat, truncate as fsTruncate, link } from 'fs/promises';
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js';
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/tools/constants/toolLimits.js';
import type { SetToolJSXFn, ToolCallProgress, ToolUseContext, ValidationResult } from 'src/tools/Tool.js';
import { buildTool, findToolByName, type ToolDef } from 'src/tools/Tool.js';
import type { AssistantMessage } from 'src/shared/types/message.js';
import { extractClaudeCodeHints } from 'src/platform/claudeCodeHints.js';
import { getCwd } from 'src/shared/fs/cwd.js';
import { detectCodeIndexingFromCommand } from 'src/shared/fs/codeIndexing.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import { ShellError } from 'src/shared/errors.js';
import { truncate } from 'src/shared/text/format.js';
import type { PermissionResult } from 'src/permissions/PermissionResult.js';
import { maybeRecordPluginHint } from 'src/plugins/hintRecommendation.js';
import { exec } from 'src/shared/proc/Shell.js';
import type { ExecResult } from 'src/shared/proc/ShellCommand.js';
import { EndTruncatingAccumulator } from 'src/shared/text/stringUtils.js';
import { isOutputLineTruncated } from 'src/terminal/terminal.js';
import { ensureToolResultsDir, getToolResultPath } from 'src/agent/tools/toolResultStorage.js';
import { getGlobalConfig } from 'src/platform/config/config.js';
import { userFacingName as fileEditUserFacingName } from 'src/tools/FileEditTool/UI.js';
import { trackGitOperations } from 'src/tools/shared/gitOperationTracking.js';
import { getBashRedirectMode, pickBashRedirect } from 'src/tools/BashTool/redirectLanes.js';
import {
  applyBashFilterToStdout,
  exitCodeAfterRewrite,
  exitCodeHiddenByRewrite,
  FILE_READ_PASSTHROUGH_MAX_CHARS,
  overBudgetFileRead,
  planBashFilter,
  type PreExecPlan,
} from 'src/tools/shared/outputFilter/Bash/index.js';
import { applySedEdit } from 'src/tools/BashTool/applySedEdit.js';
import { creditShownFiles, fitWholeFiles, renderNotShownNote, type FittedRead } from 'src/tools/BashTool/creditShownFiles.js';
import { bashToolHasPermission, commandHasAnyCd, matchWildcardPattern, permissionRuleExtractPrefix } from 'src/tools/BashTool/bashPermissions.js';
import { isAutobackgroundingAllowed, isSearchOrReadBashCommand, isSilentBashCommand } from 'src/tools/BashTool/bashCommandClassification.js';
import { inputSchema, isBashOutputFilterDisabled, outputSchema, safeAnnotateStderrWithSandboxFailures, type BashToolInput, type InputSchema, type Out, type OutputSchema } from 'src/tools/BashTool/bashSchemas.js';
import { interpretCommandResult } from 'src/tools/BashTool/commandSemantics.js';
import { getDefaultTimeoutMs, getSimplePrompt } from 'src/tools/BashTool/prompt.js';
import { checkReadOnlyConstraints } from 'src/tools/BashTool/readOnlyValidation.js';
import { parseSedEditCommand } from 'src/tools/BashTool/sedEditParser.js';
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js';
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js';
import { BackgroundHint, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from 'src/tools/BashTool/UI.js';
import { isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from 'src/tools/BashTool/utils.js';
import { mapShellResultToToolResultBlockParam } from 'src/tools/shellToolResultMappers.js';
import { applyBashOutputFilter, planBashFilterForExecution, runShellCommand, shouldFilterOutput } from 'src/tools/BashTool/runShellCommand.js';
const EOL = '\n';
// Progress display constants
// In assistant mode, blocking bash auto-backgrounds after this many ms in the
// main agent. Shared with PowerShellTool via shellToolResultMappers, because the
// backgrounding note quotes the budget.

// Re-export BashProgress from centralized types to break import cycles
export type { BashProgress } from 'src/shared/types/tools.js';
import type { BashProgress } from 'src/shared/types/tools.js';

/**
 * CLAUDIN_BASH_FILE_READ_PASSTHROUGH: a pure read too long for one result —
 * over the 28k the filter shows whole, or spilled to disk by the shell — is
 * cut back to the whole files that fit before the filter runs, and the rest
 * are named (`fitWholeFiles`). The spill goes with it: the result names the
 * files instead of pointing at a saved dump, which the model read back whole
 * in session-cache-ab 20260924-170553 (r1: 56.9k chars, and two Patches
 * refused). Null when this does not apply, and the run goes on as before.
 * `cwd` is the directory the command started in: the files resolve from it
 * through any `cd` the command made, and are named relative to it.
 *
 * Exported for testing; `decide` is the filter's call, injectable because its
 * flag is read at module load.
 */
export async function fitOverBudgetRead(result: ExecResult, plan: PreExecPlan, cwd: string, decide: typeof overBudgetFileRead = overBudgetFileRead): Promise<{
  result: ExecResult;
  fitted: FittedRead;
} | null> {
  if (result.interrupted) return null;
  // Where the filter does not run, neither does its pass-through.
  if (!shouldFilterOutput(getGlobalConfig().bashOutputFilterEnabled, isBashOutputFilterDisabled, result.backgroundTaskId)) return null;
  const stdout = result.stdout || '';
  const reads = decide(stdout, plan, result.outputFilePath !== undefined);
  if (!reads) return null;
  const fitted = await fitWholeFiles(stdout, reads, cwd, FILE_READ_PASSTHROUGH_MAX_CHARS);
  if (!fitted) return null;
  return {
    result: {
      ...result,
      stdout: fitted.shown,
      outputFilePath: undefined,
      outputFileSize: undefined,
      outputTaskId: undefined
    },
    fitted
  };
}

/**
 * Checks if a command contains tools that shouldn't run in sandbox
 * This includes:
 * - Dynamic config-based disabled commands and substrings (tengu_sandbox_disabled_commands)
 * - User-configured commands from settings.json (sandbox.excludedCommands)
 *
 * User-configured commands support the same pattern syntax as permission rules:
 * - Exact matches: "npm run lint"
 * - Prefix patterns: "npm run test:*"
 */

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  searchHint: 'execute shell commands',
  clearableResult: true,
  // 30K chars - tool result persistence threshold
  maxResultSizeChars: 30_000,
  async description({
    description
  }) {
    return description || 'Run shell command';
  },
  async prompt() {
    return getSimplePrompt();
  },
  isConcurrencySafe(input) {
    return this.isReadOnly?.(input) ?? false;
  },
  isReadOnly(input) {
    const compoundCommandHasCd = commandHasAnyCd(input.command);
    const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
    return result.behavior === 'allow';
  },
  toAutoClassifierInput(input) {
    return input.command;
  },
  // Every `if` condition on a Bash hook matches. Hook `if` filtering is "no
  // match → skip hook" (deny-like semantics), and the per-subcommand matcher
  // this used to build needed argv from parseForSecurity, which has answered
  // parse-unavailable in every shipped bundle — so the permissive arm is the
  // only one that has ever run, and it is the fail-safe direction. The method
  // has to stay: matching.ts:132 treats a MISSING matcher as "no match", so
  // removing it would stop every `if`-conditioned Bash hook instead. Restoring
  // real filtering is a behaviour change for hook configs that exist today and
  // belongs in its own decision, not in a dead-code removal.
  async preparePermissionMatcher(_input) {
    return (_pattern: string) => true;
  },
  isSearchOrReadCommand(input) {
    const parsed = inputSchema().safeParse(input);
    if (!parsed.success) return {
      isSearch: false,
      isRead: false,
      isList: false
    };
    return isSearchOrReadBashCommand(parsed.data.command);
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName(input) {
    if (!input) {
      return 'Bash';
    }
    // Render sed in-place edits as file edits
    if (input.command) {
      const sedInfo = parseSedEditCommand(input.command);
      if (sedInfo) {
        return fileEditUserFacingName({
          file_path: sedInfo.filePath,
          old_string: 'x'
        });
      }
    }
    // Env var FIRST: shouldUseSandbox → splitCommand_DEPRECATED → shell-quote's
    // `new RegExp` per call. userFacingName runs per-render for every bash
    // message in history; with ~50 msgs + one slow-to-tokenize command, this
    // exceeds the shimmer tick → transition abort → infinite retry (#21605).
    return isEnvTruthy(process.env.CLAUDIN_BASH_SANDBOX_SHOW_INDICATOR) && shouldUseSandbox(input) ? 'SandboxedBash' : 'Bash';
  },
  getToolUseSummary(input) {
    if (!input?.command) {
      return null;
    }
    const {
      command,
      description
    } = input;
    if (description) {
      return description;
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH);
  },
  getActivityDescription(input) {
    if (!input?.command) {
      return 'Running command';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  async validateInput(input: BashToolInput, context: ToolUseContext): Promise<ValidationResult> {
    // A command with a better home in a dedicated tool is refused here only in
    // refuse mode (`CLAUDIN_BASH_REDIRECT=refuse`). By default it runs, and
    // `advise` below appends the same pointer to its result. Lanes, gates and
    // one-shot memos: redirectLanes.ts.
    if (getBashRedirectMode() === 'refuse') {
      const redirect = pickBashRedirect(input, name => findToolByName(context?.options?.tools ?? [], name) !== undefined, getCwd(), 'refuse');
      if (redirect) {
        return {
          result: false,
          message: redirect.message,
          errorCode: redirect.errorCode
        };
      }
    }
    return {
      result: true
    };
  },
  advise(input: BashToolInput, context: ToolUseContext) {
    if (getBashRedirectMode() !== 'advise') return null;
    const redirect = pickBashRedirect(input, name => findToolByName(context?.options?.tools ?? [], name) !== undefined, getCwd(), 'advise');
    return redirect ? {
      message: redirect.message,
      suggests: redirect.suggests
    } : null;
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  // BashToolResultMessage shows <OutputLine content={stdout}> + stderr.
  // UI never shows persistedOutputPath wrapper, backgroundInfo — those are
  // model-facing (mapToolResult... below).
  extractSearchText({
    stdout,
    stderr
  }) {
    return stderr ? `${stdout}\n${stderr}` : stdout;
  },
  mapToolResultToToolResultBlockParam(data, toolUseID): ToolResultBlockParam {
    // Structured content replaces the whole block, and only Bash produces it —
    // so it stays here rather than in the shared mapper.
    const {
      structuredContent
    } = data;
    if (structuredContent && structuredContent.length > 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: structuredContent
      };
    }

    // Everything below (image block, stdout trim, persisted-output wrapper,
    // stderr + abort marker, background note) is identical across the shell
    // tools — see src/tools/shellToolResultMappers.ts.
    return mapShellResultToToolResultBlockParam(data, toolUseID);
  },
  async call(input: BashToolInput, toolUseContext, _canUseTool?: CanUseToolFn, parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<BashProgress>) {
    // Handle simulated sed edit - apply directly instead of running sed
    // This ensures what the user previewed is exactly what gets written
    if (input._simulatedSedEdit) {
      return applySedEdit(input._simulatedSedEdit, toolUseContext, parentMessage);
    }
    const {
      abortController,
      getAppState,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const stdoutAccumulator = new EndTruncatingAccumulator();
    let stderrForShellReset = '';
    let interpretationResult: ReturnType<typeof interpretCommandResult> | undefined;
    let progressCounter = 0;
    let wasInterrupted = false;
    let result: ExecResult;
    const isMainThread = !toolUseContext.agentId;
    const preventCwdChanges = !isMainThread;
    // Read before anything is spawned: the read credit refuses a file whose
    // mtime is at or after it, since it may have changed after the command
    // printed it (creditShownFiles.ts).
    const commandStartedAt = Date.now();
    // Where the command starts, which is where the paths it names resolve
    // (fileReadShape.ts carries a `cd` in it from here). Once it has run,
    // getCwd() is wherever such a `cd` left the shell — the main thread keeps
    // it (Shell.ts) unless resetCwdIfOutsideProject puts it back.
    const commandStartCwd = getCwd();
    // A pure read cut back to its whole files (fitOverBudgetRead).
    let fitted: FittedRead | undefined;
    // The base's own exit code when the plan stripped a trailing `| tail -N`
    // and the base failed. The verdict is 0, as the pipeline's would have been,
    // but agent/tools/responseChain.ts must not take `bun test | tail` for a
    // pass when it decides whether the calls after it still run.
    let reducedExitCode: number | undefined;
    try {
      // Pre-exec filter plan: when a filter defines a rewrite (git log →
      // git log --oneline, BASE | tail → BASE), the rewritten command is the
      // one we execute, so the marker's original/actual attributes describe
      // what really ran. Rewrites only ever add read-only formatting flags.
      const filterPlan = planBashFilterForExecution(input);
      const execInput =
        filterPlan.effectiveCommand === input.command
          ? input
          : { ...input, command: filterPlan.effectiveCommand };
      // Use the new async generator version of runShellCommand
      const commandGenerator = runShellCommand({
        input: execInput,
        abortController,
        // Use the always-shared task channel so async agents' background
        // bash tasks are actually registered (and killable on agent exit).
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId
      });

      // Consume the generator and capture the return value
      let generatorResult;
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `bash-progress-${progressCounter++}`,
            data: {
              type: 'bash_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes ?? 0,
              taskId: progress.taskId,
              timeoutMs: progress.timeoutMs
            }
          });
        }
      } while (!generatorResult.done);

      // Get the final result from the generator's return value
      result = generatorResult.value;

      // Raw-output consumers run BEFORE the filter so semantic interpretation,
      // git tracking and the index.lock check never see marker-wrapped or
      // condensed text. (stderr is interleaved in stdout — merged fd.)
      const rawStdout = result.stdout || '';
      trackGitOperations(input.command, result.code, rawStdout);
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt';

      // Interpret the command result using semantic rules (on the raw output).
      // The verdict is about the command the MODEL sent: when the plan stripped
      // a trailing `| tail -N`, that pipeline would have exited 0 whatever the
      // base did, so `result.code` is not the status to judge it by. The base's
      // real code is disclosed on the marker instead (exitCodeAfterRewrite).
      const verdictCode = exitCodeAfterRewrite(filterPlan, result.code);
      reducedExitCode = exitCodeHiddenByRewrite(filterPlan, result.code);
      interpretationResult = interpretCommandResult(input.command, verdictCode, rawStdout, '');
      const isError = interpretationResult.isError || verdictCode !== 0;
      const fit = isError ? null : await fitOverBudgetRead(result, filterPlan, commandStartCwd);
      if (fit) {
        result = fit.result;
        fitted = fit.fitted;
      }

      // Filter last, with the semantic verdict folded in: output that either
      // the exit code or the interpreter deems an error skips the pipeline
      // (errors are sacred).
      result = applyBashOutputFilter(result, input.command, filterPlan, isError);

      stdoutAccumulator.append((result.stdout || '').trimEnd() + EOL);
      if (interpretationResult.isError && !isInterrupt) {
        // Only add exit code if it's actually an error
        if (result.code !== 0) {
          stdoutAccumulator.append(`Exit code ${result.code}`);
        }
      }
      if (!preventCwdChanges) {
        const appState = getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // Annotate output with sandbox violations if any (stderr is in stdout).
      const outputWithSbFailures = safeAnnotateStderrWithSandboxFailures(input.command, result.stdout || '');
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretationResult.isError && !isInterrupt) {
        // stderr is merged into stdout (merged fd); outputWithSbFailures
        // already has the full output. Pass '' for stdout to avoid
        // duplication in getErrorParts() and processBashCommand.
        throw new ShellError('', outputWithSbFailures, result.code, result.interrupted);
      }
      wasInterrupted = result.interrupted;
    } finally {
      if (setToolJSX) setToolJSX(null);
    }

    // Get final string from accumulator
    const stdout = stdoutAccumulator.toString();

    // Large output: the file on disk has more than getMaxOutputLength() bytes.
    // stdout already contains the first chunk (from getStdout()). Copy the
    // output file to the tool-results dir so the model can read it via
    // FileRead. If > 64 MB, truncate after copying.
    const MAX_PERSISTED_SIZE = 64 * 1024 * 1024;
    let persistedOutputPath: string | undefined;
    let persistedOutputSize: number | undefined;
    if (result.outputFilePath && result.outputTaskId) {
      try {
        const fileStat = await fsStat(result.outputFilePath);
        persistedOutputSize = fileStat.size;
        await ensureToolResultsDir();
        const dest = getToolResultPath(result.outputTaskId, false);
        if (fileStat.size > MAX_PERSISTED_SIZE) {
          await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE);
        }
        try {
          await link(result.outputFilePath, dest);
        } catch {
          await copyFile(result.outputFilePath, dest);
        }
        persistedOutputPath = dest;
      } catch {
        // File may already be gone — stdout preview is sufficient
      }
    }
    const commandType = input.command.split(' ')[0];

    // Log code indexing tool usage
    const codeIndexingTool = detectCodeIndexingFromCommand(input.command);
    let strippedStdout = stripEmptyLines(stdout);

    // Claude Code hints protocol: CLIs/SDKs gated on CLAUDECODE=1 emit a
    // `<claude-code-hint />` tag to stderr (merged into stdout here). Scan,
    // record for useClaudeCodeHintRecommendation to surface, then strip
    // so the model never sees the tag — a zero-token side channel.
    // Stripping runs unconditionally (subagent output must stay clean too);
    // only the dialog recording is main-thread-only.
    const extracted = extractClaudeCodeHints(strippedStdout, input.command);
    strippedStdout = extracted.stripped;
    if (isMainThread && extracted.hints.length > 0) {
      for (const hint of extracted.hints) maybeRecordPluginHint(hint);
    }
    let isImage = isImageOutput(strippedStdout);

    // Cap image dimensions + size if present (CC-304 — see
    // resizeShellImageOutput). Scope the decoded buffer so it can be reclaimed
    // before we build the output Out object.
    let compressedStdout = strippedStdout;
    if (isImage) {
      const resized = await resizeShellImageOutput(strippedStdout, result.outputFilePath, persistedOutputSize);
      if (resized) {
        compressedStdout = resized;
      } else {
        // Parse failed or file too large (e.g. exceeds MAX_IMAGE_FILE_SIZE).
        // Keep isImage in sync with what we actually send so the UI label stays
        // accurate — mapToolResultToToolResultBlockParam's defensive
        // fallthrough will send text, not an image block.
        isImage = false;
      }
    }
    const notShownNote = fitted ? renderNotShownNote(fitted, FILE_READ_PASSTHROUGH_MAX_CHARS) : null;
    const data: Out = {
      stdout: compressedStdout,
      stderr: stderrForShellReset,
      interrupted: wasInterrupted,
      isImage,
      returnCodeInterpretation: interpretationResult?.message,
      noOutputExpected: isSilentBashCommand(input.command),
      backgroundTaskId: result.backgroundTaskId,
      backgroundedByUser: result.backgroundedByUser,
      assistantAutoBackgrounded: result.assistantAutoBackgrounded,
      dangerouslyDisableSandbox: 'dangerouslyDisableSandbox' in input ? input.dangerouslyDisableSandbox as boolean | undefined : undefined,
      persistedOutputPath,
      persistedOutputSize,
      ...(reducedExitCode !== undefined && {
        reducedExitCode
      }),
      ...(notShownNote !== null && {
        readNote: notShownNote
      })
    };
    // CLAUDIN_BASH_READ_CREDIT: a `cat` counts as a Read of each file it
    // printed whole (creditShownFiles.ts). It runs here and not beside the
    // filter above because `data` is what the model's tool result is built
    // from — empty lines and hints stripped, stderr and the background note
    // beside it — and only here is it known whether the output went to disk
    // instead. Off, it returns before touching anything, and `data` is as it
    // always was.
    const credit = await creditShownFiles({
      ...data,
      command: input.command,
      startedAt: commandStartedAt,
      ...(fitted && {
        notShown: fitted.notShown
      })
    }, toolUseContext.readFileState, commandStartCwd, getAppState().toolPermissionContext);
    // The paths let `/resume` rebuild the credit (queryHelpers.ts); the line
    // is how the model learns of it.
    if (credit.credited.length > 0) data.creditedFiles = [...credit.credited];
    if (credit.note !== null) data.readNote = data.readNote ? `${data.readNote}\n${credit.note}` : credit.note;
    return {
      data
    };
  },
  renderToolUseErrorMessage,
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out, BashProgress>);
