// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// Background memory consolidation. Fires the /dream prompt as a forked
// subagent when time-gate passes AND enough sessions have accumulated.
//
// Gate order (cheapest first):
//   1. Time: hours since lastConsolidatedAt >= minHours (one stat)
//   2. Sessions: transcript count with mtime > lastConsolidatedAt >= minSessions
//   3. Lock: no other process mid-consolidation
//
// State is closure-scoped inside initAutoDream() rather than module-level
// (tests call initAutoDream() in beforeEach for a fresh closure).
// What the runner reaches outside itself — the gate, the lock, the decision
// sources and the fork — comes in as AutoDreamDeps, so a test drives the
// whole runner without mock.module.
//
// Interactive sessions only: a `-p` run is often the only turn its process
// sees, and a fork started there was cut off at exit.
// CLAUDIN_AUTO_DREAM_HEADLESS=1 lets a `-p` run dream, and runHeadless then
// waits for it (drainPendingAutoDream). CLAUDIN_AUTO_DREAM_FORCE=1 opens the
// gates — enabled, time, sessions — for a bench fixture.

import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from 'src/agent/coordinator/forkedAgent.js'
import {
  createUserMessage,
  createMemorySavedMessage,
  createSystemMessage,
} from 'src/agent/messages/messages.js'
import type { Message } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import {
  findHygieneFindings,
  globalFindingsLine,
  type HygieneFinding,
  isMemoryHygieneEnabled,
} from 'src/memory/memdir/memoryHygiene.js'
import { readMemoryFiles } from 'src/memory/memdir/memoryAudit.js'
import { writtenPaths } from 'src/tools/shared/writtenPaths.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { isAutoDreamEnabled } from 'src/memory/autoDream/config.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import {
  getOriginalCwd,
  getKairosActive,
  getIsNonInteractiveSession,
  getIsRemoteMode,
  getSessionId,
} from 'src/platform/bootstrap/state.js'
import {
  memoryCountsOf,
} from 'src/memory/extract/extractMemories.js'
import { createMemoryCanUseTool } from 'src/memory/forkToolGate.js'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { collectDreamDigest } from 'src/memory/autoDream/dreamDigest.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
} from 'src/memory/autoDream/consolidationLock.js'
import {
  registerDreamTask,
  addDreamTurn,
  completeDreamTask,
  failDreamTask,
  isDreamTask,
} from 'src/agent/tasks/DreamTask/DreamTask.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'

// Scan throttle: when time-gate passes but session-gate doesn't, the lock
// mtime doesn't advance, so the time-gate keeps passing every turn.
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

type AutoDreamConfig = {
  minHours: number
  minSessions: number
}

/**
 * Scheduling thresholds. The enabled gate lives in config.ts
 * (isAutoDreamEnabled); these are only the scheduling knobs.
 */
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
}

function isGateOpen(): boolean {
  if (getKairosActive()) return false // KAIROS mode uses disk-skill dream
  if (getIsRemoteMode()) return false
  if (getIsNonInteractiveSession() && !isEnvTruthy(process.env.CLAUDIN_AUTO_DREAM_HEADLESS)) {
    return false
  }
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}

// CLAUDIN_AUTO_DREAM_FORCE=1, for a bench fixture: bypasses the enabled,
// time and session gates and the lock acquire. Still scans sessions so the
// prompt's session list is populated.
function isForced(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_AUTO_DREAM_FORCE)
}

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

/** What the runner calls outside itself; production passes defaultAutoDreamDeps. */
export type AutoDreamDeps = {
  isGateOpen: () => boolean
  readLastConsolidatedAt: () => Promise<number>
  listSessionsTouchedSince: (sinceMs: number) => Promise<string[]>
  tryAcquireConsolidationLock: () => Promise<number | null>
  rollbackConsolidationLock: (priorMtime: number) => Promise<void>
  collectDreamDigest: (sinceMs: number, sessionIds: readonly string[]) => Promise<string>
  runForkedAgent: typeof runForkedAgent
  /** Whether a finished dream says so in the transcript (`notifyMemorySaved`). */
  notifyMemorySaved: () => boolean
  /** What the hygiene pass finds once the dream is done, for the line about the global dir. */
  hygieneFindings: () => Promise<HygieneFinding[]>
}

export const defaultAutoDreamDeps: AutoDreamDeps = {
  isGateOpen,
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  collectDreamDigest: (sinceMs, sessionIds) => collectDreamDigest(sinceMs, sessionIds),
  runForkedAgent,
  notifyMemorySaved: () => getGlobalConfig().notifyMemorySaved === true,
  hygieneFindings: async () => {
    if (!isMemoryHygieneEnabled()) return []
    const dirs = getMemoryDirs()
    return findHygieneFindings(await readMemoryFiles(dirs), dirs)
  },
}

let runner:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

/**
 * Call once at startup (from backgroundHousekeeping alongside
 * initExtractMemories), or per-test in beforeEach for a fresh closure.
 */
export function initAutoDream(deps: AutoDreamDeps = defaultAutoDreamDeps): void {
  let lastSessionScanAt = 0

  runner = async function runAutoDream(context, appendSystemMessage) {
    const cfg = DEFAULTS
    const force = isForced()
    if (!force && !deps.isGateOpen()) return

    // --- Time gate ---
    let lastAt: number
    try {
      lastAt = await deps.readLastConsolidatedAt()
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] readLastConsolidatedAt failed: ${(e as Error).message}`,
      )
      return
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000
    if (!force && hoursSince < cfg.minHours) return

    // --- Scan throttle ---
    const sinceScanMs = Date.now() - lastSessionScanAt
    if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      logForDebugging(
        `[autoDream] scan throttle — time-gate passed but last scan was ${Math.round(sinceScanMs / 1000)}s ago`,
      )
      return
    }
    lastSessionScanAt = Date.now()

    // --- Session gate ---
    let sessionIds: string[]
    try {
      sessionIds = await deps.listSessionsTouchedSince(lastAt)
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] listSessionsTouchedSince failed: ${(e as Error).message}`,
      )
      return
    }
    // Exclude the current session (its mtime is always recent).
    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)
    if (!force && sessionIds.length < cfg.minSessions) {
      logForDebugging(
        `[autoDream] skip — ${sessionIds.length} sessions since last consolidation, need ${cfg.minSessions}`,
      )
      return
    }

    // --- Lock ---
    // Under force, skip acquire entirely — use the existing mtime so
    // kill's rollback is a no-op (rewinds to where it already is).
    // The lock file stays untouched; next non-force turn sees it as-is.
    let priorMtime: number | null
    if (force) {
      priorMtime = lastAt
    } else {
      try {
        priorMtime = await deps.tryAcquireConsolidationLock()
      } catch (e: unknown) {
        logForDebugging(
          `[autoDream] lock acquire failed: ${(e as Error).message}`,
        )
        return
      }
      if (priorMtime === null) return
    }

    logForDebugging(
      `[autoDream] firing — ${hoursSince.toFixed(1)}h since last, ${sessionIds.length} sessions to review`,
    )

    const setAppState =
      context.toolUseContext.setAppStateForTasks ??
      context.toolUseContext.setAppState
    const abortController = new AbortController()
    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: sessionIds.length,
      priorMtime,
      abortController,
    })

    try {
      const transcriptDir = getProjectDir(getOriginalCwd())
      const prune = isMemoryHygieneEnabled()
      // The decision sources (plans, session prompts, impactful commits) are
      // read here, in the harness, so the fork judges with data instead of
      // grepping transcripts — and never runs git itself.
      const digest = await deps.collectDreamDigest(lastAt, sessionIds)
      // Tool constraints note goes in `extra`, not the shared prompt body —
      // manual /dream runs in the main loop with normal permissions and this
      // would be misleading there.
      const extra = `

**Tool constraints for this run:** Bash is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar). Anything that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.${
        prune
          ? ' A memory file is deleted with a Patch `*** Delete File:` section, after a Read of it; the gate refuses one that deletes an index, touches the global dir other than by adding, or deletes a private memory without writing its survivor in the same Patch.'
          : ''
      }

Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => `- ${id}`).join('\n')}

${digest}`
      const prompt = buildConsolidationPrompt(getMemoryDirs(), transcriptDir, extra)

      const result = await deps.runForkedAgent({
        promptMessages: [createUserMessage({ content: prompt })],
        cacheSafeParams: createCacheSafeParams(context),
        // One project's run cannot judge the global dir stale: it may only add to it.
        canUseTool: createMemoryCanUseTool(['global'], { patch: prune ? 'prune' : 'none' }),
        querySource: 'auto_dream',
        forkLabel: 'auto_dream',
        skipTranscript: true,
        // A prune Patch applies all or nothing: a private memory it deletes
        // has no git history, so it must not outlive a failed survivor write.
        overrides: {
          abortController,
          ...(prune && { options: { ...context.toolUseContext.options, patchAllOrNothing: true } }),
        },
        onMessage: makeDreamProgressWatcher(taskId, setAppState),
      })

      completeDreamTask(taskId, setAppState)
      // Inline completion summary in the main transcript (same surface as
      // extractMemories's "Saved N memories" message).
      const dreamState = context.toolUseContext.getAppState().tasks?.[taskId]
      if (
        appendSystemMessage &&
        isDreamTask(dreamState) &&
        dreamState.filesTouched.length > 0 &&
        deps.notifyMemorySaved()
      ) {
        appendSystemMessage({
          ...createMemorySavedMessage(dreamState.filesTouched),
          memoryCounts: memoryCountsOf(dreamState.filesTouched),
          // SystemMemorySavedMessage doesn't declare `verb` — not yet
          // consumed by the renderer (SystemTextMessage.tsx says "Saved").
          verb: 'Improved',
        } as ReturnType<typeof createMemorySavedMessage> & { verb?: string })
      }
      // What only the user can settle, said whatever notifyMemorySaved says
      const globalLine = globalFindingsLine(
        await deps.hygieneFindings().catch(error => {
          logError(error)
          return []
        }),
      )
      if (appendSystemMessage && globalLine) {
        appendSystemMessage(createSystemMessage(globalLine, 'info'))
      }
      logForDebugging(
        `[autoDream] completed — cache: read=${result.totalUsage.cache_read_input_tokens} created=${result.totalUsage.cache_creation_input_tokens}`,
      )
    } catch (e: unknown) {
      // If the user killed from the bg-tasks dialog, DreamTask.kill already
      // aborted, rolled back the lock, and set status=killed. Don't overwrite
      // or double-rollback.
      if (abortController.signal.aborted) {
        logForDebugging('[autoDream] aborted by user')
        return
      }
      logForDebugging(`[autoDream] fork failed: ${(e as Error).message}`)
      failDreamTask(taskId, setAppState)
      // Rewind mtime so time-gate passes again. Scan throttle is the backoff.
      await deps.rollbackConsolidationLock(priorMtime)
    }
  }
}

/**
 * Watch the forked agent's messages. For each assistant turn, extracts any
 * text blocks (the agent's reasoning/summary — what the user wants to see)
 * and collapses tool_use blocks to a count. The paths an Edit, Write or
 * Patch writes — a Patch's deletes included — are collected for phase-flip +
 * the inline completion message.
 */
function makeDreamProgressWatcher(
  taskId: string,
  setAppState: import('src/agent/Task.js').SetAppState,
): (msg: Message) => void {
  return msg => {
    if (msg.type !== 'assistant') return
    let text = ''
    let toolUseCount = 0
    const touchedPaths: string[] = []
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        toolUseCount++
        if (
          block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME ||
          block.name === APPLY_PATCH_TOOL_NAME
        ) {
          touchedPaths.push(...writtenPaths(block.input, getCwd()))
        }
      }
    }
    addDreamTurn(
      taskId,
      { text: text.trim(), toolUseCount },
      touchedPaths,
      setAppState,
    )
  }
}

/**
 * Entry point from stopHooks. No-op until initAutoDream() has been called.
 * Per-turn cost when enabled: one GB cache read + one stat.
 */
export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  if (!runner) return
  const run = runner(context, appendSystemMessage)
  inFlightDreams.add(run)
  try {
    await run
  } finally {
    inFlightDreams.delete(run)
  }
}

/** Every dream executeAutoDream started that has not settled yet. */
const inFlightDreams = new Set<Promise<void>>()

/**
 * Awaits the dreams in flight, with a soft timeout. Called by runHeadless
 * before gracefulShutdownSync, so a dream CLAUDIN_AUTO_DREAM_HEADLESS let a
 * `-p` run start is not cut off mid-write. No-op when none is running.
 */
export async function drainPendingAutoDream(timeoutMs = 10 * 60_000): Promise<void> {
  if (inFlightDreams.size === 0) return
  await Promise.race([
    Promise.all(inFlightDreams).catch(() => {}),
    // eslint-disable-next-line no-restricted-syntax -- sleep() has no .unref(); timer must not block exit
    new Promise<void>(r => setTimeout(r, timeoutMs).unref()),
  ])
}
