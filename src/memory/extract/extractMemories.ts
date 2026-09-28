/**
 * Background memory extraction. At the end of a main-thread turn a fork of
 * the conversation reads what was said since it last looked and saves what
 * is worth keeping in the auto-memory directory, fenced by a permission
 * policy that lets it write memory files and nothing else.
 *
 * Switches, all read at every end of turn:
 *   CLAUDIN_EXTRACT_MEMORIES=0        turns extraction off
 *   CLAUDIN_EXTRACT_MEMORIES_EVERY=n  forks on every nth eligible turn (15)
 *   CLAUDIN_LOOP_MEMORY_TRIGGER=0     no fork forced by a repeated failure
 *   notifyMemorySaved (global config) announces the files a fork saved
 *
 * The work is done in ./fork/: the trigger policy, the transcript readers,
 * the permission policy, the fork request and the runner holding the state.
 */
import { feature } from 'bun:bundle'
import { runForkedAgent } from 'src/agent/coordinator/forkedAgent.js'
import {
  createExtractionRunner,
  type AppendSystemMessage,
  type ExtractionDeps,
  type ExtractionRunner,
} from 'src/memory/extract/fork/extractionRunner.js'
import { formatMemoryManifest, scanMemoryFiles } from 'src/memory/memdir/memoryScan.js'
import {
  getAutoMemPath,
  getExtractionTurnInterval,
  isAutoMemoryEnabled,
  isAutoMemPath,
  isExtractMemoriesEnabled,
} from 'src/memory/memdir/paths.js'
import { isTeamMemoryEnabled, isTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export { createAutoMemCanUseTool } from 'src/memory/extract/fork/permissions.js'

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000

/** Every dependency reached at call time, so a stubbed module is seen wherever it is swapped in. */
function productionDeps(): ExtractionDeps {
  return {
    runFork: request => runForkedAgent(request),
    readManifest: async memoryDir =>
      formatMemoryManifest(await scanMemoryFiles(memoryDir, new AbortController().signal)),
    settings: {
      extractionEnabled: () => isExtractMemoriesEnabled(),
      autoMemoryEnabled: () => isAutoMemoryEnabled(),
      turnInterval: () => getExtractionTurnInterval(),
      loopTriggerEnabled: () =>
        feature('LOOP_ERROR_MEMORY_TRIGGER')
          ? !isEnvDefinedFalsy(process.env.CLAUDIN_LOOP_MEMORY_TRIGGER)
          : false,
      teamMemoryEnabled: () => (feature('TEAMMEM') ? isTeamMemoryEnabled() : false),
      announceSavedMemories: () => getGlobalConfig().notifyMemorySaved === true,
    },
    memory: {
      directory: () => getAutoMemPath(),
      contains: filePath => isAutoMemPath(filePath),
      containsTeamFile: filePath => isTeamMemPath(filePath),
    },
  }
}

/** Until the first call, an end of turn and a drain do nothing. */
let runner: ExtractionRunner | undefined

/** Starts over: no mark, no cadence count, no kept turn, no loop acted on. */
export function initExtractMemories(): void {
  runner = createExtractionRunner(productionDeps())
}

/** One end of a main-thread turn. Fire-and-forget: it logs its failures and never rejects. */
export function executeExtractMemories(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessage,
): Promise<void> {
  return runner ? runner.onTurnEnd(context, appendSystemMessage) : Promise.resolve()
}

/** For a process about to exit: waits for the extractions in flight, at most `timeoutMs`. */
export function drainPendingExtraction(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
  return runner ? runner.drain(timeoutMs) : Promise.resolve()
}
