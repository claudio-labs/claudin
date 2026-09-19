// The foreground/background lifecycle of a single bash run, plus the output
// filter hook that wraps it.
//
// Split out of BashTool.tsx, which keeps the buildTool object: this is the half
// that owns the subprocess, and it is the half with a test file of its own
// (runShellCommand.test.ts). `.tsx` because the backgrounding path renders
// <BackgroundHint />.

import type { AppState } from 'src/terminal/state/AppState.js';
import { logError } from 'src/shared/log.js';
import type { SetToolJSXFn, ToolCallProgress, ToolUseContext, ValidationResult } from 'src/tools/Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from 'src/shared/types/ids.js';
import { exec } from 'src/shared/proc/Shell.js';
import type { ExecResult } from 'src/shared/proc/ShellCommand.js';
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js';
import {
  applyBashFilterToStdout,
  exitCodeAfterRewrite,
  planBashFilter,
  type PreExecPlan,
} from 'src/tools/shared/outputFilter/Bash/index.js';
import { getGlobalConfig } from 'src/platform/config/config.js';
import { recordBytesSaved } from 'src/agent/context/tokensSaved.js';
import { detectBlockedSleepPattern, isAutobackgroundingAllowed, isSearchOrReadBashCommand, isSilentBashCommand } from 'src/tools/BashTool/bashCommandClassification.js';
import { inputSchema, isBackgroundTasksDisabled, isBashOutputFilterDisabled, outputSchema, safeAnnotateStderrWithSandboxFailures, type BashToolInput, type InputSchema, type Out, type OutputSchema } from 'src/tools/BashTool/bashSchemas.js';
import { getDefaultTimeoutMs, getSimplePrompt } from 'src/tools/BashTool/prompt.js';
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js';
import { BackgroundHint, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from 'src/tools/BashTool/UI.js';
const PROGRESS_THRESHOLD_MS = 2000; // Show progress after 2 seconds

// ---------------------------------------------------------------------------
// Bash output filter helper — Phase 3 integration
// Exported for testing; not part of the agent-facing API.
// ---------------------------------------------------------------------------

/**
 * Guards (passthrough conditions — mutates result.stdout in place):
 *  - `bashOutputFilterEnabled === false`  → default on; disable via /config
 *  - `isBashOutputFilterDisabled`        → kill switch (env var, module-level)
 *  - `result.backgroundTaskId` defined   → output goes to disk, not to the model
 *
 * Note — no `structuredContent` guard needed: `ExecResult` (from ShellCommand.ts)
 * does not carry that field. `structuredContent` lives on the Zod input schema and
 * is consumed by `mapToolResult` (the serialization layer) before this function is
 * ever reached; when `mapToolResult` detects structured content it short-circuits
 * and `result.stdout` is never forwarded to the model regardless.
 *
 * Note — rewrites (`rewriteCommand`, reducer-pipe stripping) are planned
 * pre-execution by `planBashFilterForExecution` and the rewritten command is
 * what `call()` actually executes; the plan then flows into this function so
 * the markers describe the command that really ran. When no plan is supplied
 * (legacy callers, tests) we re-plan with rewrites off — a rewrite marker must
 * never claim a command that was not executed.
 */
// Exported for testing; shouldFilterOutput is extracted as a pure function so the
// kill-switch path can be tested without a subprocess (module-level const is not
// re-evaluable at runtime).
export function shouldFilterOutput(
  bashOutputFilterEnabled: boolean | undefined,
  killSwitchActive: boolean,
  backgroundTaskId: string | undefined,
): boolean {
  return bashOutputFilterEnabled !== false && !killSwitchActive && !backgroundTaskId
}

/** Builds the pre-exec filter plan for a Bash invocation. Command rewrites are
 * only allowed when filtering is active, the rewrite flag is on, and the run is
 * foreground — background output goes to disk where the user may inspect it, so
 * we keep the command they asked for. With rewrites off the returned plan keeps
 * `effectiveCommand === input.command` and `rewrite: null`. */
export function planBashFilterForExecution(input: BashToolInput): PreExecPlan {
  const { bashOutputFilterEnabled, bashOutputFilterRewriteEnabled } = getGlobalConfig()
  const filteringActive = bashOutputFilterEnabled !== false && !isBashOutputFilterDisabled
  const allowRewrite =
    filteringActive && bashOutputFilterRewriteEnabled !== false && !input.run_in_background
  return planBashFilter(input.command, { allowRewrite })
}

export function applyBashOutputFilter(
  result: ExecResult,
  command: string,
  plan?: PreExecPlan,
  isError?: boolean,
): ExecResult {
  const { bashOutputFilterEnabled } = getGlobalConfig()
  if (!shouldFilterOutput(bashOutputFilterEnabled, isBashOutputFilterDisabled, result.backgroundTaskId)) {
    // Backgrounded mid-run: output goes to disk unfiltered, but a rewrite
    // already changed what is running — disclose it, or the model will read
    // the task file assuming the original command produced it. (Config-off /
    // kill-switch paths never carry a rewrite: planBashFilterForExecution
    // plans those with allowRewrite: false.)
    if (result.backgroundTaskId && plan?.rewrite) {
      const note = `Note: the bash output filter rewrote this command before execution; the background task is running: ${plan.rewrite.to}`
      const sep = result.stdout && !result.stdout.endsWith('\n') ? '\n' : ''
      result.stdout = `${result.stdout ?? ''}${sep}${note}`
    }
    return result
  }

  try {
    // No plan → the caller did not execute a rewritten command; re-plan with
    // rewrites off so the markers never claim a rewrite that didn't happen.
    const filterPlan = plan ?? planBashFilter(command, { allowRewrite: false })
    const rawBytes = (result.stdout ?? '').length
    result.stdout = applyBashFilterToStdout(
      result.stdout,
      isError ?? result.code !== 0,
      filterPlan,
      result.code,
    )
    recordBytesSaved(rawBytes, (result.stdout ?? '').length)
  } catch (e) {
    // Fail-open: extra defensive layer — planBashFilter and applyBashFilterToStdout
    // both wrap internally with safeApply, so this catch is currently unreachable.
    // Kept as a belt-and-suspenders guard: if either function ever removes its
    // internal safeApply, this boundary still prevents a crash from reaching the user.
    logError(new Error('bash output filter failed, returning raw stdout', { cause: e }))
  }
  return result
}

// Exported for tests in runShellCommand.test.ts; not part of the agent-facing
// API. Encapsulates the foreground/background lifecycle of a single bash run.
export async function* runShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId
}: {
  input: BashToolInput;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
}): AsyncGenerator<{
  type: 'progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
  totalBytes?: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background
  } = input;
  const timeoutMs = timeout || getDefaultTimeoutMs();
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  // Assistant mode (build flag KAIROS) auto-backgrounded long blocking
  // commands; that flag is off in this build, so nothing sets this.
  const assistantAutoBackgrounded = false;
  let interruptBackgroundingStarted = false;
  // Single gate over startBackgrounding — covers timeout, interrupt, kairos,
  // and any future caller. Without this, a fast timeout (e.g.
  // `timeout: 100`) firing during the initial 2s wait can spawn one bg task
  // while the polling loop's interrupt branch concurrently spawns a second:
  // both `.then`s call setAppState→registerTask with the same
  // shellCommand.taskOutput.taskId, the second silently overwrites the
  // first, leaking its registerCleanup callback and emitting a duplicate
  // SDK task_started event. The race is microtask-ordering-narrow today
  // but trivially closeable.
  let backgroundingInitiated = false;

  // Progress signal: resolved by onProgress callback from the shared poller,
  // waking the generator to yield a progress update.
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }
  // Wake whatever progressSignal is currently in flight, if any. Centralized
  // because (a) the same null-check + clear-then-call dance is needed in 4+
  // places, and (b) TS's loop-body control-flow narrowing trips on the
  // inline pattern (TS2349 "Type 'never' has no call signatures") even
  // though the closure-scoped versions compile fine.
  function wakeProgressSignal(): void {
    const resolve = resolveProgress;
    if (resolve === null) return;
    resolveProgress = null;
    resolve();
  }

  // Determine if auto-backgrounding should be enabled
  // Only enable for commands that are allowed to be auto-backgrounded
  // and when background tasks are not disabled
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const shellCommand = await exec(command, abortController.signal, 'bash', {
    timeout: timeoutMs,
    onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
      lastProgressOutput = lastLines;
      fullOutput = allLines;
      lastTotalLines = totalLines;
      lastTotalBytes = isIncomplete ? totalBytes : 0;
      // Wake the generator so it yields the new progress data
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
    },
    preventCwdChanges,
    shouldUseSandbox: shouldUseSandbox(input),
    shouldAutoBackground
  });

  // Start the command execution
  const resultPromise = shellCommand.result;

  // Helper to spawn a background task and return its ID
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask({
      command,
      description: description || command,
      shellCommand,
      toolUseId,
      agentId
    }, {
      abortController,
      getAppState: () => {
        // We don't have direct access to getAppState here, but spawn doesn't
        // actually use it during the spawn process
        throw new Error('getAppState not available in runShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  // Helper to start backgrounding. Callers used to pass the event name they
  // were backgrounding under; there is no sink to name, so they no longer do.
  function startBackgrounding(backgroundFn?: (shellId: string) => void): void {
    // Single-flight: any prior caller (timeout / interrupt / kairos /
    // explicit) already kicked off backgrounding. The flag is set here, at
    // entry, so concurrent callers see it set even before either spawn path
    // commits — closing the timeout+interrupt double-spawn race.
    if (backgroundingInitiated) {
      return;
    }

    // If a foreground task is already registered (via registerForeground in the
    // progress loop), background it in-place instead of re-spawning. Re-spawning
    // would overwrite tasks[taskId], emit a duplicate task_started SDK event,
    // and leak the first cleanup callback.
    if (foregroundTaskId) {
      if (!backgroundExistingForegroundTask(foregroundTaskId, shellCommand, description || command, setAppState, toolUseId)) {
        // Failed (status no longer 'running' — process exited). Leave the
        // flag clear so the loop's natural completion path can take over.
        return;
      }
      backgroundingInitiated = true;
      backgroundShellId = foregroundTaskId;
      backgroundFn?.(foregroundTaskId);
      return;
    }

    // No foreground task registered — spawn a new background task.
    // Set the flag synchronously: the .then below is queued on the
    // microtask queue and another caller (e.g. interrupt branch) could
    // execute before it resolves.
    backgroundingInitiated = true;
    spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;
      // Wake the generator's Promise.race so it sees backgroundShellId.
      // Without this, if the poller has stopped ticking for this task
      // (no output + shared-poller race with sibling stopPolling calls)
      // and the process is hung on I/O, the race never resolves and the
      // generator deadlocks despite being backgrounded.
      wakeProgressSignal();
      if (backgroundFn) {
        backgroundFn(shellId);
      }
    }).catch(err => {
      // spawnBackgroundTask is essentially-sync (its async ops are
      // setAppState + module-level registration), so a real failure here
      // means something pathological. Don't swallow:
      //   1) Log the error (logError is the codebase convention).
      //   2) Kill the underlying shell. With ShellCommand.#abortHandler
      //      NO-OPing on `'interrupt'`, an unkilled spawn-failure path
      //      leaves the process running and the loop spinning on
      //      progressSignal forever — kill makes resultPromise resolve
      //      with SIGKILL, breaking the loop on the next iteration.
      //   3) Wake any in-flight progressSignal.
      logError(err);
      shellCommand.kill();
      wakeProgressSignal();
    });
  }

  // Set up auto-backgrounding on timeout if enabled
  // Only background commands that are allowed to be auto-backgrounded (not sleep, etc.)
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding(backgroundFn);
    });
  }

  // Handle Claude asking to run it in the background explicitly
  // When explicitly requested via run_in_background, always honor the request
  // regardless of the command type (isAutobackgroundingAllowed only applies to automatic backgrounding)
  // Skip if background tasks are disabled - run in foreground instead
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId
    };
  }

  // Wait for the initial threshold before showing progress
  const startTime = Date.now();
  let foregroundTaskId: string | undefined = undefined;
  {
    // Race the result + a 2s timer + an abort observer. The abort observer
    // means an `'interrupt'` arriving during the 2s threshold drops out of
    // the race immediately instead of sitting blocked until the timer fires
    // (~2s wasted before the polling loop's interrupt branch could even run).
    // ShellCommand.#abortHandler NO-OPs on `'interrupt'`, so resultPromise
    // never resolves on its own from this signal.
    const initialAbortPromise = new Promise<null>(resolve => {
      if (abortController.signal.aborted) {
        resolve(null);
        return;
      }
      abortController.signal.addEventListener(
        'abort',
        () => resolve(null),
        { once: true }
      );
    });
    const initialResult = await Promise.race([resultPromise, new Promise<null>(resolve => {
      const t = setTimeout((r: (v: null) => void) => r(null), PROGRESS_THRESHOLD_MS, resolve);
      t.unref();
    }), initialAbortPromise]);
    if (initialResult !== null) {
      shellCommand.cleanup();
      return initialResult;
    }
    if (backgroundShellId) {
      return {
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        backgroundTaskId: backgroundShellId,
        assistantAutoBackgrounded
      };
    }
  }

  // Start polling the output file for progress. The poller's #tick calls
  // onProgress every second, which resolves progressSignal below.
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // One-shot wake-on-abort: if the abort fires while the polling loop is
  // mid-Promise.race, immediately resolve whatever progressSignal is in
  // flight so the loop body's interrupt/kill branch runs without waiting
  // up to ~1s for the next natural progress tick. `{ once: true }` auto-
  // removes after firing; subsequent iterations don't need it because the
  // first abort flips interruptBackgroundingStarted=true and the loop
  // resolves to a return shortly thereafter.
  if (!abortController.signal.aborted) {
    abortController.signal.addEventListener('abort', wakeProgressSignal, { once: true });
  }

  // Progress loop: wake is driven by the shared poller calling onProgress,
  // which resolves the progressSignal.
  try {
    while (true) {
      const progressSignal = createProgressSignal();
      // If an `'interrupt'` abort already fired before this iteration starts
      // (e.g., interrupt landed during the initial 2s wait, where the
      // wake-on-abort listener block below was skipped because signal was
      // already aborted), wake progressSignal synchronously so the interrupt
      // branch runs immediately instead of waiting up to ~1s for the next
      // natural tick. Gated on:
      //   - reason === 'interrupt': non-interrupt aborts (e.g. 'user-cancel')
      //     trigger ShellCommand.#abortHandler's kill path, which makes
      //     resultPromise resolve naturally. Waking here for those reasons
      //     would tight-spin (the interrupt branch's reason check fails so
      //     interruptBackgroundingStarted never flips, and the loop would
      //     wake itself every iteration).
      //   - !interruptBackgroundingStarted: don't re-wake after the
      //     interrupt branch has already done its work and we're awaiting
      //     backgroundShellId.
      if (
        abortController.signal.aborted &&
        abortController.signal.reason === 'interrupt' &&
        !interruptBackgroundingStarted
      ) {
        wakeProgressSignal();
      }
      const result = await Promise.race([resultPromise, progressSignal]);
      if (result !== null) {
        // Race: backgrounding fired (15s timer / onTimeout / Ctrl+B) but the
        // command completed before the next poll tick. #handleExit sets
        // backgroundTaskId but skips outputFilePath (it assumes the background
        // message or <task_notification> will carry the path). Strip
        // backgroundTaskId so the model sees a clean completed command,
        // reconstruct outputFilePath for large outputs, and suppress the
        // redundant <task_notification> from the .then() handler.
        // Check result.backgroundTaskId (not the closure var) to also cover
        // Ctrl+B, which calls shellCommand.background() directly.
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined
          };
          // Mirror ShellCommand.#handleExit's large-output branch that was
          // skipped because #backgroundTaskId was set.
          const {
            taskOutput
          } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          shellCommand.cleanup();
          return fixedResult;
        }
        // Command has completed - return the actual result
        // If we registered as a foreground task, unregister it
        if (foregroundTaskId) {
          unregisterForeground(foregroundTaskId, setAppState);
        }
        // Clean up stream resources for foreground commands
        // (backgrounded commands are cleaned up by LocalShellTask)
        shellCommand.cleanup();
        return result;
      }

      // Check if command was backgrounded (either via old mechanism or new backgroundAll)
      if (backgroundShellId) {
        return {
          // On interrupt-backgrounding, surface the partial output so the
          // model sees what ran before the new user message arrived.
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // User submitted a new message mid-execution. ShellCommand.#abortHandler
      // intentionally NO-OPs on `'interrupt'` so the caller can background the
      // process instead of killing it — without this branch the bash subprocess
      // keeps running untracked and the foreground LocalShellTaskState lingers
      // in state.tasks (invisible to the BackgroundTasksDialog because
      // isBackgroundTask filters out isBackgrounded:false). Mirrors
      // PowerShellTool.tsx:938-950.
      if (abortController.signal.aborted && abortController.signal.reason === 'interrupt' && !interruptBackgroundingStarted) {
        interruptBackgroundingStarted = true;
        if (!isBackgroundTasksDisabled) {
          startBackgrounding();
          // Reloop so the backgroundShellId check above catches the sync
          // foregroundTaskId→background path. Without `continue`, we'd fall
          // through to the Ctrl+B check below, which matches
          // status === 'backgrounded' and would incorrectly mark this as
          // backgroundedByUser:true (PowerShell bugs 020/021).
          continue;
        }
        shellCommand.kill();
      }

      // Check if this foreground task was backgrounded via backgroundAll()
      if (foregroundTaskId) {
        // shellCommand.status becomes 'backgrounded' when background() is called
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true
          };
        }
      }

      // Time for a progress update
      const elapsed = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);

      // Show minimal backgrounding UI if available
      // Skip if background tasks are disabled
      // Also skip when an interrupt has already started backgrounding: the
      // async spawnBackgroundTask().then() path may not have set
      // backgroundShellId yet, but we know the loop is about to return with
      // a backgroundTaskId. Registering a foreground task here would race —
      // the .then() spawns a fresh task with the same taskOutput.taskId,
      // overwriting the foreground entry in state.tasks via registerTask
      // and leaking its unregisterCleanup callback.
      if (!isBackgroundTasksDisabled && backgroundShellId === undefined && !interruptBackgroundingStarted && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        // Register this command as a foreground task so it can be backgrounded via Ctrl+B
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground({
            command,
            description: description || command,
            shellCommand,
            agentId
          }, setAppState, toolUseId);
        }
        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true
        });
      }
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? {
          timeoutMs
        } : undefined)
      };
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
  }
}
