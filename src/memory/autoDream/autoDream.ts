// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered

import { feature } from 'bun:bundle'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { runForkedAgent } from 'src/agent/coordinator/forkedAgent.js'
import type { Message } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  isAutoMemoryEnabled,
  getAutoMemPath,
  isAutoMemPath,
} from 'src/memory/memdir/paths.js'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
} from 'src/memory/memdir/teamMemPaths.js'
import { isAutoDreamEnabled } from 'src/memory/autoDream/config.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import {
  getOriginalCwd,
  getKairosActive,
  getSessionId,
} from 'src/platform/bootstrap/state.js'
import { createAutoMemCanUseTool } from 'src/memory/extract/extractMemories.js'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { collectDreamDigest } from 'src/memory/autoDream/dreamDigest.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
} from 'src/memory/autoDream/consolidationLock.js'
import { addDreamTurn } from 'src/agent/tasks/DreamTask/DreamTask.js'
import {
  type DreamRunDeps,
  productionTaskStore,
  runDream,
} from 'src/memory/autoDream/run/dreamRun.js'
import { readDreamTurn } from 'src/memory/autoDream/run/forkMessages.js'
import {
  decideAfterScan,
  decideBeforeScan,
  type DreamThresholds,
} from 'src/memory/autoDream/run/schedule.js'

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
  return isAutoDreamEnabled() && isAutoMemoryEnabled() && !getKairosActive()
}

function isForced(): boolean {
  // No switch forces a dream in this build: every dream passes the schedule.
  return false
}

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

let runner:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

export function initAutoDream(): void {
  const thresholds: DreamThresholds = {
    ...DEFAULTS,
    scanIntervalMs: SESSION_SCAN_INTERVAL_MS,
  }
  const deps: DreamRunDeps = {
    runFork: params => runForkedAgent(params),
    digest: (sinceMs, sessionIds) => collectDreamDigest(sinceMs, sessionIds),
    tasks: productionTaskStore,
    prompt: extra =>
      buildConsolidationPrompt(
        getAutoMemPath(),
        getProjectDir(getOriginalCwd()),
        extra,
        feature('TEAMMEM') ? (isTeamMemoryEnabled() ? getTeamMemPath() : null) : null,
      ),
    canUseTool: () => createAutoMemCanUseTool(getAutoMemPath()),
    watch: makeDreamProgressWatcher,
    rollback: rollbackConsolidationLock,
    announceSaves: () => getGlobalConfig().notifyMemorySaved === true,
  }
  // Forgotten by the next initAutoDream, with the rest of this schedule.
  let lastScanAt: number | undefined

  runner = async (context, appendSystemMessage) => {
    const gatesOpen = isGateOpen()
    const lastConsolidatedAt = gatesOpen ? await readLastConsolidatedAt() : 0
    const now = Date.now()
    const before = decideBeforeScan({ gatesOpen, now, lastConsolidatedAt, lastScanAt }, thresholds)
    if (before.kind !== 'scan') {
      logForDebugging(`[autoDream] skipped: ${before.kind}`)
      return
    }
    lastScanAt = now
    const currentSession = getSessionId()
    const others = (await listSessionsTouchedSince(lastConsolidatedAt)).filter(id => id !== currentSession)
    const after = decideAfterScan(others, lastConsolidatedAt, thresholds)
    if (after.kind !== 'due') {
      logForDebugging(`[autoDream] skipped: ${after.count} sessions since the last consolidation`)
      return
    }
    const priorMtime = await tryAcquireConsolidationLock()
    if (priorMtime === null) {
      logForDebugging('[autoDream] skipped: another process holds the lock')
      return
    }
    const outcome = await runDream(
      { context, appendSystemMessage, sessionIds: after.sessionIds, lastConsolidatedAt: after.lastAt, priorMtime },
      deps,
    )
    logForDebugging(`[autoDream] ${outcome}`)
  }
}

function makeDreamProgressWatcher(
  taskId: string,
  setAppState: import('src/agent/Task.js').SetAppState,
): (msg: Message) => void {
  return message => {
    const turn = readDreamTurn(message, isAutoMemPath)
    if (turn === null) return
    addDreamTurn(taskId, { text: turn.text, toolUseCount: turn.toolUseCount }, turn.touchedPaths, setAppState)
  }
}

export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  const run = runner
  if (run === null) return
  try {
    await run(context, appendSystemMessage)
  } catch (error) {
    logForDebugging(`[autoDream] ${errorMessage(error)}`, { level: 'error' })
  }
}
