import { feature } from 'bun:bundle';
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
import { userFacingName as fileEditUserFacingName } from 'src/tools/FileEditTool/UI.js';
import { trackGitOperations } from 'src/tools/shared/gitOperationTracking.js';
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js';
import { renderRunTestsRedirect, shouldRedirectToRunTests } from 'src/tools/RunTestsTool/redirect.js';
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js';
import { renderTypecheckRedirect, shouldRedirectToTypecheck } from 'src/tools/TypecheckTool/redirect.js';
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js';
import { renderBuildRedirect, shouldRedirectToBuild } from 'src/tools/BuildTool/redirect.js';
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js';
import { renderGitRedirect, shouldRedirectToGit } from 'src/tools/GitTool/redirect.js';
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js';
import { detectSleepPoll, renderWaitForRedirect, shouldRedirectSleepPoll } from 'src/tools/WaitForTool/redirect.js';
import {
  applyBashFilterToStdout,
  exitCodeAfterRewrite,
  planBashFilter,
  type PreExecPlan,
} from 'src/tools/shared/outputFilter/Bash/index.js';
import { applySedEdit } from 'src/tools/BashTool/applySedEdit.js';
import { bashToolHasPermission, commandHasAnyCd, matchWildcardPattern, permissionRuleExtractPrefix } from 'src/tools/BashTool/bashPermissions.js';
import { detectBlockedSleepPattern, isAutobackgroundingAllowed, isSearchOrReadBashCommand, isSilentBashCommand } from 'src/tools/BashTool/bashCommandClassification.js';
import { inputSchema, isBackgroundTasksDisabled, isBashOutputFilterDisabled, outputSchema, safeAnnotateStderrWithSandboxFailures, type BashToolInput, type InputSchema, type Out, type OutputSchema } from 'src/tools/BashTool/bashSchemas.js';
import { interpretCommandResult } from 'src/tools/BashTool/commandSemantics.js';
import { getDefaultTimeoutMs, getSimplePrompt } from 'src/tools/BashTool/prompt.js';
import { checkReadOnlyConstraints } from 'src/tools/BashTool/readOnlyValidation.js';
import { parseSedEditCommand } from 'src/tools/BashTool/sedEditParser.js';
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js';
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js';
import { renderToolRedirect, shouldRedirectToTools } from 'src/tools/BashTool/toolRedirect.js';
import { BackgroundHint, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from 'src/tools/BashTool/UI.js';
import { isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from 'src/tools/BashTool/utils.js';
import { mapShellResultToToolResultBlockParam } from 'src/tools/shellToolResultMappers.js';
import { applyBashOutputFilter, planBashFilterForExecution, runShellCommand } from 'src/tools/BashTool/runShellCommand.js';
const EOL = '\n';
// Progress display constants
// In assistant mode, blocking bash auto-backgrounds after this many ms in the
// main agent. Shared with PowerShellTool via shellToolResultMappers, because the
// backgrounding note quotes the budget.

// Re-export BashProgress from centralized types to break import cycles
export type { BashProgress } from 'src/shared/types/tools.js';
import type { BashProgress } from 'src/shared/types/tools.js';

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
  strict: true,
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
    // A `sleep N` segment followed by a check is a poll loop, and WaitFor does
    // the polling in one call. Gated OFF until the adoption A/B passes
    // (`CLAUDIN_ENABLE_WAITFOR_REDIRECT=1`), on the tool being in THIS agent's
    // toolset, and never for a backgrounded run. One-shot per command; the
    // fall-through keeps the leading-sleep refusal below byte-identical when
    // the lane is off. See WaitForTool/redirect.ts.
    if (!input.run_in_background && isEnvTruthy(process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT) && findToolByName(context?.options?.tools ?? [], WAITFOR_TOOL_NAME) !== undefined) {
      const poll = detectSleepPoll(input.command);
      if (poll !== null && shouldRedirectSleepPoll(input.command)) {
        return {
          result: false,
          message: renderWaitForRedirect(poll),
          errorCode: 16
        };
      }
    }
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command);
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10
        };
      }
    }
    // A bare test run has a better home: RunTests runs the same command and
    // answers with failures first. Gated on the tool actually being in THIS
    // agent's toolset — refusing Bash without an alternative would be a dead
    // end — and never for a backgrounded run, which RunTests can't do.
    // The refusal is one-shot per command; see RunTestsTool/redirect.ts.
    if (!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_RUNTESTS_REDIRECT) && findToolByName(context?.options?.tools ?? [], RUN_TESTS_TOOL_NAME) !== undefined && shouldRedirectToRunTests(input.command)) {
      return {
        result: false,
        message: renderRunTestsRedirect(input.command),
        errorCode: 11
      };
    }
    // The same lever one step earlier in the loop: a bare type-check has a
    // better home in Typecheck, which reports only the diagnostics missing from
    // the project's recorded backlog. Gated identically — the tool must be in
    // THIS agent's toolset, never for a backgrounded run — and narrowed to the
    // pure checkers, so `go build`/`dotnet build`/`mvn` still run here.
    // The refusal is one-shot per command; see TypecheckTool/redirect.ts.
    if (!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_TYPECHECK_REDIRECT) && findToolByName(context?.options?.tools ?? [], TYPECHECK_TOOL_NAME) !== undefined && shouldRedirectToTypecheck(input.command)) {
      return {
        result: false,
        message: renderTypecheckRedirect(input.command),
        errorCode: 13
      };
    }
    // And the artifact-producing half of the same idea. Narrowed to the
    // toolchains that print hundreds of progress lines — `npm run build` is
    // deliberately absent, since a JS build's output is already short — and
    // never for a command that also installs, publishes or runs something.
    // The refusal is one-shot per command; see BuildTool/redirect.ts.
    if (!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_BUILD_REDIRECT) && findToolByName(context?.options?.tools ?? [], BUILD_TOOL_NAME) !== undefined && shouldRedirectToBuild(input.command)) {
      return {
        result: false,
        message: renderBuildRedirect(input.command),
        errorCode: 15
      };
    }
    // Same lever again, aimed at the repository reads. Only the READ shapes are
    // refused — a mutation runs fine through Git but refusing it here would put
    // a dialog in front of a command that already had permission, for no token
    // payoff. Gated identically: the tool must be in THIS agent's toolset,
    // never for a backgrounded run. The refusal is one-shot per command; see
    // GitTool/redirect.ts.
    if (!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_GIT_REDIRECT) && findToolByName(context?.options?.tools ?? [], GIT_TOOL_NAME) !== undefined && shouldRedirectToGit(input.command)) {
      return {
        result: false,
        message: renderGitRedirect(input.command),
        errorCode: 14
      };
    }
    // Same lever, aimed at the other half of this tool's own "avoid running
    // find/grep/cat/head/sed" advice: a command that only reads or searches
    // files has a better home in Read/Grep/Glob, and the refusal hands back the
    // exact calls to make instead. All-or-nothing across a compound command,
    // one-shot per command, and gated on every target tool being in THIS
    // agent's toolset; see toolRedirect.ts.
    if (!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REDIRECT)) {
      const toolRedirect = shouldRedirectToTools(input.command, getCwd(), name => findToolByName(context?.options?.tools ?? [], name) !== undefined);
      if (toolRedirect) {
        return {
          result: false,
          message: renderToolRedirect(toolRedirect),
          errorCode: 12
        };
      }
    }
    return {
      result: true
    };
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
      interpretationResult = interpretCommandResult(input.command, verdictCode, rawStdout, '');


      // Filter last, with the semantic verdict folded in: output that either
      // the exit code or the interpreter deems an error skips the pipeline
      // (errors are sacred).
      result = applyBashOutputFilter(result, input.command, filterPlan, interpretationResult.isError || verdictCode !== 0);

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
      persistedOutputSize
    };
    return {
      data
    };
  },
  renderToolUseErrorMessage,
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out, BashProgress>);
