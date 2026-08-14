// Integration tests for runShellCommand — focused on the foreground/background
// lifecycle, especially the interrupt-backgrounding branch (mirrors
// PowerShellTool.tsx:938-950) without which a bash command that's interrupted
// by a new user message keeps running orphaned and its LocalShellTaskState
// lingers in state.tasks invisible to the BackgroundTasksDialog
// (isBackgroundTask filters out isBackgrounded:false).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppState } from 'src/state/AppStateStore.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { isLocalShellTask } from 'src/tasks/LocalShellTask/guards.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { resetCommandQueue } from 'src/utils/messageQueueManager.js'
import { drainSdkEvents } from 'src/utils/sdkEventQueue.js'
import type { ExecResult } from 'src/utils/ShellCommand.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import {
  applyBashOutputFilter,
  planBashFilterForExecution,
  runShellCommand,
  type BashToolInput,
} from './BashTool.js'

type SetAppStateFn = (f: (prev: AppState) => AppState) => void

function makeStateHarness(): {
  setAppState: SetAppStateFn
  getState: () => AppState
} {
  let state = getDefaultAppState()
  const setAppState: SetAppStateFn = updater => {
    state = updater(state)
  }
  return {
    setAppState,
    getState: () => state,
  }
}

async function consume(
  gen: ReturnType<typeof runShellCommand>,
): Promise<ExecResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) {
      return step.value
    }
  }
}

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  ;(t as unknown as { unref?: () => void }).unref?.()
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

beforeEach(() => {
  // Module-level queues persist across tests; clear them so SDK events and
  // task notifications from one test don't bleed into the next.
  resetCommandQueue()
  drainSdkEvents()
})

afterEach(() => {
  resetCommandQueue()
  drainSdkEvents()
})

// PROGRESS_THRESHOLD_MS is 2s. Anything that needs to enter the polling loop
// (foreground registration, interrupt branch, Ctrl+B) needs the underlying
// command to last >2s. The original delay of 2.5s was only 500ms above the
// threshold and prone to flakiness on loaded CI runners — bumped to 3.5s
// after the second-pass review flagged this.
const FOREGROUND_REGISTRATION_DELAY_MS = 3_500
const TEST_TIMEOUT_MS = 30_000

// `isBackgroundTasksDisabled` in BashTool is captured at module load time:
//   const isBackgroundTasksDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
// We can't flip it at runtime — so we honestly skip the kill-fallback test
// unless the runner was launched with the env var pre-set, instead of pretending
// to test it.
const BG_DISABLED_AT_LOAD = isEnvTruthy(
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
)

describe('runShellCommand — happy paths', () => {
  test.skipIf(BG_DISABLED_AT_LOAD)(
    'run_in_background:true returns a backgroundTaskId immediately and registers a backgrounded task',
    async () => {
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = {
        command: 'sleep 0.2 && echo bg-done',
        run_in_background: true,
      }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })
      const result = await consume(gen)

      expect(result.backgroundTaskId).toBeDefined()
      expect(result.code).toBe(0)
      const tasks = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.isBackgrounded).toBe(true)
      // Let the underlying process finish so it doesn't leak into the next test.
      await sleep(600)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'short command completes synchronously without registering a foreground task',
    async () => {
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = { command: 'echo hello-claudin' }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })
      const result = await consume(gen)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('hello-claudin')
      expect(result.backgroundTaskId).toBeUndefined()
      expect(result.interrupted).toBe(false)
      // No foreground task should have been registered (command finished
      // before the 2s threshold) — and even if one had been, it must be
      // unregistered on completion.
      const tasks = Object.values(harness.getState().tasks)
      expect(tasks.filter(isLocalShellTask)).toHaveLength(0)
    },
    TEST_TIMEOUT_MS,
  )

})

// ---------------------------------------------------------------------------
// Bash output filter — pre-exec rewrite, end to end. The plan's
// effectiveCommand is what call() executes; prove with a real shell that the
// rewritten command runs (oneline output, no full-format headers) and that
// the marker then describes the command that actually ran. Uses this repo's
// own git history, so no fixture setup is needed.
// ---------------------------------------------------------------------------

describe('bash output filter — pre-exec rewrite integration', () => {
  test(
    'git log executes as git log --oneline and the marker reports it',
    async () => {
      const savedFlag = getGlobalConfig().bashOutputFilterEnabled
      saveGlobalConfig(c => ({ ...c, bashOutputFilterEnabled: true }))
      try {
        const input: BashToolInput = { command: 'git log' }
        const plan = planBashFilterForExecution(input)
        expect(plan.rewrite?.to).toBe('git log --oneline')

        const harness = makeStateHarness()
        // The persistent shell is a shared singleton; an earlier test in the
        // suite can leave its cwd outside the repo (observed on CI as
        // `git log` → 128 "fatal: not a git repository"). Pin it to the repo
        // root first so the rewrite runs inside a git repository regardless of
        // file order.
        await consume(
          runShellCommand({
            input: { command: `cd ${JSON.stringify(process.cwd())}` },
            abortController: new AbortController(),
            setAppState: harness.setAppState,
            setToolJSX: () => {},
            isMainThread: true,
          }),
        )
        const gen = runShellCommand({
          input: { ...input, command: plan.effectiveCommand },
          abortController: new AbortController(),
          setAppState: harness.setAppState,
          setToolJSX: () => {},
          isMainThread: true,
        })
        const result = await consume(gen)
        expect(result.code).toBe(0)
        // Real proof the rewrite executed: oneline format has no Author: header.
        expect(result.stdout).not.toContain('Author:')
        expect(result.stdout).toMatch(/^[0-9a-f]{7,}\s/m)

        applyBashOutputFilter(result, input.command, plan)
        expect(result.stdout).toContain('original="git log"')
        expect(result.stdout).toContain('actual="git log --oneline"')
      } finally {
        saveGlobalConfig(c => ({ ...c, bashOutputFilterEnabled: savedFlag }))
      }
    },
    TEST_TIMEOUT_MS,
  )
})

describe('runShellCommand — interrupt-backgrounding (regression for shells-stuck bug)', () => {
  test.skipIf(BG_DISABLED_AT_LOAD)(
    'interrupt during a long-running command moves the foreground task to background and marks it notified for eviction',
    async () => {
      const harness = makeStateHarness()
      const ac = new AbortController()
      // Long enough to reliably enter the polling loop (>2s) and to still be
      // running when we trigger the interrupt.
      const input: BashToolInput = { command: 'sleep 8' }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const t = setTimeout(() => {
        ac.abort('interrupt')
      }, FOREGROUND_REGISTRATION_DELAY_MS)
      unrefTimer(t)

      const result = await consume(gen)

      // The result must indicate the command was backgrounded — NOT killed
      // and NOT left dangling. Pre-fix this code path didn't exist and the
      // caller would either spin in the polling loop (Bash uses
      // interruptBehavior:'block' so the for-await isn't cancelled) or leave
      // a foreground task in state.tasks invisible to the UI.
      expect(result.backgroundTaskId).toBeDefined()
      expect(result.interrupted).toBe(false)
      // No `backgroundedByUser:true` — that's reserved for Ctrl+B. The
      // interrupt branch must `continue` to the backgroundShellId check, not
      // fall through to the Ctrl+B branch (PowerShell bugs 020/021).
      expect(result.backgroundedByUser).toBeUndefined()

      // The task must now be a *background* task — visible to the dialog
      // because isBackgroundTask filters out isBackgrounded:false.
      const shellTasks = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      expect(shellTasks).toHaveLength(1)
      expect(shellTasks[0]!.isBackgrounded).toBe(true)
      expect(['running', 'completed', 'failed', 'killed']).toContain(
        shellTasks[0]!.status,
      )

      // Eviction precondition: after the underlying process exits, the
      // backgroundExistingForegroundTask `.then` handler must (a) flip status
      // to a terminal state and (b) call enqueueShellNotification which sets
      // notified:true. evictTerminalTask in framework.ts only evicts when
      // both conditions hold — without them the task lingers forever.
      const sc = shellTasks[0]!.shellCommand
      sc?.kill()
      // 500ms is enough for: process exit → flushAndCleanup → updateTaskState
      // → enqueueShellNotification. Bumped from 200ms after observing flake
      // on slower machines.
      await sleep(500)
      const settled = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      expect(settled).toHaveLength(1)
      expect(settled[0]!.status).not.toBe('running')
      expect(settled[0]!.notified).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(BG_DISABLED_AT_LOAD)(
    'interrupt-backgrounding surfaces the partial output captured while the command was running',
    async () => {
      // sleep 8 alone produces nothing — `fullOutput` would be '' and the
      // assertion at BashTool.tsx:1092 (stdout: interruptBackgroundingStarted
      // ? fullOutput : '') would silently mask a regression. Emit a marker
      // BEFORE the wait so the polling tick at ~3s captures it into
      // fullOutput; then interrupt and verify it lands on result.stdout.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = {
        command: 'echo PARTIAL_OUTPUT_MARKER && sleep 8',
      }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const t = setTimeout(() => {
        ac.abort('interrupt')
      }, FOREGROUND_REGISTRATION_DELAY_MS)
      unrefTimer(t)

      const result = await consume(gen)

      expect(result.backgroundTaskId).toBeDefined()
      // The whole point of interruptBackgroundingStarted-controlled fullOutput
      // return: the model needs to see what ran before the new prompt arrived.
      expect(result.stdout).toContain('PARTIAL_OUTPUT_MARKER')

      const shellTasks = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      shellTasks[0]!.shellCommand?.kill()
      await sleep(500)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(BG_DISABLED_AT_LOAD)(
    'interrupt fired BEFORE the 2s polling threshold backgrounds quickly (does not wait for the timer)',
    async () => {
      // Two regressions guarded here:
      //   1) Without the fix, an interrupt during the initial 2s Promise.race
      //      sits unobserved until the timer fires (~2s wasted before the
      //      polling loop's interrupt branch could even run). The initial-
      //      wait abort observer in runShellCommand resolves the race the
      //      moment abort lands.
      //   2) The follow-up race the reviewer flagged: with interrupt
      //      mid-loop, the next iteration could fire the foreground-
      //      registration block before spawnBackgroundTask().then resolved,
      //      creating a foreground task that's then overwritten when the
      //      .then runs (leaking unregisterCleanup). The
      //      `!interruptBackgroundingStarted` guard on the registration
      //      block prevents that — assert exactly ONE task exists.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = { command: 'sleep 8' }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const interruptDelay = 300
      const start = Date.now()
      const t = setTimeout(() => {
        ac.abort('interrupt')
      }, interruptDelay)
      unrefTimer(t)

      const result = await consume(gen)
      const elapsed = Date.now() - start

      // Timing guard for fix #2: the result should land well before the
      // 2s timer would have expired. We use a loose bound (1500ms) so
      // GC/scheduler jitter doesn't flake — without the fix, this would
      // be ~2000ms+ every time. With the fix, ~300-600ms typically.
      expect(elapsed).toBeLessThan(1500)
      expect(result.backgroundTaskId).toBeDefined()
      expect(result.backgroundedByUser).toBeUndefined()

      // Critical idempotency check: even though the loop iterates multiple
      // times after the early interrupt (the async spawnBackgroundTask path
      // takes a microtask to resolve), the interruptBackgroundingStarted
      // flag must prevent re-entry. A regression that loses the flag would
      // call startBackgrounding repeatedly and create multiple tasks.
      const shellTasks = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      expect(shellTasks).toHaveLength(1)
      expect(shellTasks[0]!.isBackgrounded).toBe(true)

      shellTasks[0]!.shellCommand?.kill()
      await sleep(500)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(BG_DISABLED_AT_LOAD)(
    'multiple consecutive aborts on the same controller do not re-trigger backgrounding',
    async () => {
      // AbortController.abort is itself idempotent (the listener fires once),
      // so this test mostly pins behavior — but it also documents that the
      // interruptBackgroundingStarted flag is the second line of defense if
      // some future change re-enters the loop after the first interrupt.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = { command: 'sleep 8' }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const t1 = setTimeout(() => {
        ac.abort('interrupt')
        // Second abort with the same reason — should be a no-op.
        ac.abort('interrupt')
        // And one with a different reason — also no-op once aborted.
        ac.abort('user-cancel')
      }, FOREGROUND_REGISTRATION_DELAY_MS)
      unrefTimer(t1)

      const result = await consume(gen)

      expect(result.backgroundTaskId).toBeDefined()
      const shellTasks = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      // Exactly one task, and it must be backgrounded — not killed by the
      // 'user-cancel' that landed *after* abort already latched.
      expect(shellTasks).toHaveLength(1)
      expect(shellTasks[0]!.isBackgrounded).toBe(true)

      shellTasks[0]!.shellCommand?.kill()
      await sleep(500)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(BG_DISABLED_AT_LOAD)(
    'interrupt arriving AFTER run_in_background:true returned is a no-op',
    async () => {
      // run_in_background commands return from runShellCommand BEFORE the
      // polling loop ever opens (BashTool.tsx:998-1010). So a later interrupt
      // on the same controller must not affect the already-returned result
      // or spawn an extra task. The underlying process is owned by
      // spawnShellTask now, not runShellCommand — its abort wiring lives
      // elsewhere.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const input: BashToolInput = {
        command: 'sleep 0.3 && echo bg-done',
        run_in_background: true,
      }

      const gen = runShellCommand({
        input,
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })
      const result = await consume(gen)

      // Before the interrupt fires we already have a backgrounded task.
      expect(result.backgroundTaskId).toBeDefined()
      const beforeInterrupt = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      expect(beforeInterrupt).toHaveLength(1)
      expect(beforeInterrupt[0]!.isBackgrounded).toBe(true)
      const taskIdBefore = beforeInterrupt[0]!.id

      // Now interrupt — should not double-register, should not change the
      // backgrounded task's identity. The interrupt has nothing left to act
      // on because the generator has already returned.
      ac.abort('interrupt')
      await sleep(300)

      const afterInterrupt = Object.values(harness.getState().tasks).filter(
        isLocalShellTask,
      )
      // Either the task is still there (status terminal) or it was evicted —
      // both are fine. What's NOT fine is a *new* task spawned by the
      // interrupt path.
      const newTasks = afterInterrupt.filter(t => t.id !== taskIdBefore)
      expect(newTasks).toHaveLength(0)

      // Drain so the process doesn't leak.
      await sleep(400)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(!BG_DISABLED_AT_LOAD)(
    'interrupt with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 falls back to killing the process',
    async () => {
      // Honest skip: isBackgroundTasksDisabled is a module-load constant in
      // BashTool.tsx:226. The previous version of this test pretended to
      // exercise the kill branch by doing an early-return when the env var
      // wasn't set in advance — which silently re-tested the enabled path.
      // This version only runs when the runner was actually launched with
      // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, e.g.:
      //   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 bun test runShellCommand
      // Otherwise the kill fallback at BashTool.tsx:1119 stays uncovered by
      // CI but at least we're not hiding that.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const gen = runShellCommand({
        input: { command: 'sleep 8' },
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const t = setTimeout(
        () => ac.abort('interrupt'),
        FOREGROUND_REGISTRATION_DELAY_MS,
      )
      unrefTimer(t)

      const result = await consume(gen)
      expect(result.backgroundTaskId).toBeUndefined()
      // SIGKILL exit code per ShellCommand.ts:49.
      expect(result.code).toBe(137)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a non-interrupt abort ("user-cancel") kills the process — does NOT background it',
    async () => {
      // ShellCommand.#abortHandler short-circuits ONLY on reason==='interrupt'
      // (ShellCommand.ts:189-191). Any other abort reason hits this.kill()
      // and the result resolves with an interrupted/killed code. The new
      // interrupt branch must not accidentally absorb these.
      const harness = makeStateHarness()
      const ac = new AbortController()
      const gen = runShellCommand({
        input: { command: 'sleep 8' },
        abortController: ac,
        setAppState: harness.setAppState,
        setToolJSX: () => {},
        isMainThread: true,
      })

      const t = setTimeout(() => ac.abort('user-cancel'), 500)
      unrefTimer(t)

      const result = await consume(gen)
      expect(result.backgroundTaskId).toBeUndefined()
      // SIGKILL → code 137 from ShellCommand.ts:49.
      expect(result.code).toBe(137)
    },
    TEST_TIMEOUT_MS,
  )
})
