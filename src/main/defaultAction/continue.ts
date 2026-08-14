// Continue branch — `claudin --continue`. Loads the most recent conversation
// and launches the REPL with it. Extracted from src/main.tsx (ROADMAP 11g
// Fase 5b). Pure code-motion: signatures match the original closure variables.

import type { Root } from 'src/ink.js';
import type { StatsStore } from 'src/context/stats.js';
import type { FpsMetrics } from 'src/utils/fpsTracker.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { exitWithError, renderAndRun } from 'src/interactiveHelpers.js';
import { launchRepl } from 'src/replLauncher.js';
import { logError } from 'src/utils/log.js';
import { errorMessage } from 'src/utils/errors.js';
import { logEvent } from 'src/services/analytics/index.js';
import { loadConversationForResume } from 'src/utils/conversationRecovery.js';
import { processResumedConversation } from 'src/utils/sessionRestore.js';
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js';
import { maybeActivateBrief, maybeActivateProactive } from 'src/main/lifecycle.js';

export type ContinueBranchDeps = {
  root: Root;
  options: { forkSession?: unknown };
  sessionConfig: Record<string, unknown>;
  resumeContext: Parameters<typeof processResumedConversation>[2];
  /** Mutable handle for mainThreadAgentDefinition — fallback used when the
   * resumed session does not carry an agent definition. */
  mainThreadAgentDefinitionRef: { current: unknown };
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore | undefined;
};

export async function runContinueBranch(deps: ContinueBranchDeps): Promise<void> {
  const { root, options, sessionConfig, resumeContext, mainThreadAgentDefinitionRef, getFpsMetrics, stats } = deps;
  let resumeSucceeded = false;
  try {
    const resumeStart = performance.now();

    const { clearSessionCaches } = await import('src/commands/clear/caches.js');
    clearSessionCaches();
    const result = await loadConversationForResume(undefined /* sessionId */, undefined /* sourceFile */);
    if (!result) {
      logEvent('tengu_continue', { success: false });
      return await exitWithError(root, 'No conversation found to continue');
    }
    const loaded = await processResumedConversation(result, {
      forkSession: !!options.forkSession,
      includeAttribution: true,
      transcriptPath: result.fullPath,
    }, resumeContext);
    if (loaded.restoredAgentDef) {
      mainThreadAgentDefinitionRef.current = loaded.restoredAgentDef;
    }
    maybeActivateProactive(options);
    maybeActivateBrief(options);
    logEvent('tengu_continue', {
      success: true,
      resume_duration_ms: Math.round(performance.now() - resumeStart),
    });
    resumeSucceeded = true;
    await launchRepl(root, {
      getFpsMetrics,
      stats,
      initialState: loaded.initialState,
    }, {
      ...sessionConfig,
      mainThreadAgentDefinition: (loaded.restoredAgentDef ?? mainThreadAgentDefinitionRef.current) as AgentDefinition | undefined,
      initialMessages: loaded.messages,
      initialFileHistorySnapshots: loaded.fileHistorySnapshots,
      initialContentReplacements: loaded.contentReplacements,
      initialAgentName: loaded.agentName,
      initialAgentColor: loaded.agentColor,
    } as Parameters<typeof launchRepl>[2], renderAndRun);
  } catch (error) {
    if (!resumeSucceeded) {
      logEvent('tengu_continue', { success: false });
    }
    logError(error);
    return await exitWithError(root, errorMessage(error), () => gracefulShutdown(1));
  }
}
