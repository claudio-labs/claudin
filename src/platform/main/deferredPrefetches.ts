// Deferred boot prefetches extracted from main.tsx (ROADMAP 11g Fase 3).
//
// Why a dedicated module: main.tsx used to host startDeferredPrefetches(), and
// interactiveHelpers.tsx imported it from main.tsx — that's a load-order cycle
// (main → interactiveHelpers → main). Hoisting the function here breaks the
// cycle: both callers now import from this leaf module.

import { isBareMode, isEnvTruthy } from 'src/shared/envUtils.js';
import { initUser } from 'src/shared/user.js';
import { getUserContext } from 'src/context.js';
import { getRelevantTips } from 'src/terminal/tips/tipRegistry.js';
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js';
import {
  prefetchAwsCredentialsAndBedRockInfoIfSafe,
  prefetchGcpCredentialsIfSafe,
} from 'src/services/auth/auth.js';
import { countFilesRoundedRg } from 'src/shared/fs/ripgrep.js';
import { getCwd } from 'src/shared/fs/cwd.js';
import { initializeAnalyticsGates } from 'src/platform/analytics/sink.js';
import { prefetchOfficialMcpUrls } from 'src/services/mcp/officialRegistry.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { settingsChangeDetector } from 'src/platform/settings/changeDetector.js';
import { skillChangeDetector } from 'src/skills/skillChangeDetector.js';
import { prefetchSystemContextIfSafe } from 'src/platform/main/lifecycle.js';

/**
 * Start background prefetches and housekeeping that are NOT needed before first render.
 * These are deferred from setup() to reduce event loop contention and child process
 * spawning during the critical startup path.
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // This function runs after first render, so it doesn't block the initial paint.
  // However, the spawned processes and async work still contend for CPU and event
  // loop time, which skews startup benchmarks (CPU profiles, time-to-first-render
  // measurements). Skip all of it when we're only measuring startup performance.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare: skip ALL prefetches. These are cache-warms for the REPL's
    // first-turn responsiveness (initUser, getUserContext, tips, countFiles,
    // modelCapabilities, change detectors). Scripted -p calls don't have a
    // "user is typing" window to hide this work in — it's pure overhead on
    // the critical path.
    isBareMode()
  ) {
    return;
  }

  // Process-spawning prefetches (consumed at first API call, user is still typing)
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  const startupTransport = tryGetActiveProvider()?.transport;
  if (startupTransport === 'bedrock' && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (startupTransport === 'vertex' && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  // Analytics and feature flag initialization
  void initializeAnalyticsGates();
  void prefetchOfficialMcpUrls();
  void refreshModelCapabilities();

  // File change detectors deferred from init() to unblock first render
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }
}
