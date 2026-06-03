// Action handler — Block E: trust dialog + onboarding + login refresh +
// org validation. Extracted from src/main.tsx (ROADMAP 11g Fase 7c.4).
//
// Only runs in the interactive path (`!isNonInteractiveSession`). Creates
// the Ink root + render handles, runs the trust/onboarding flow, gates
// remote-control entitlement, dispatches the snapshot-update dialog,
// refreshes auth-dependent caches after login, runs the provider auto-
// wizard, and finally validates force-login org membership.
//
// No profileCheckpoint(...) calls inside — Block E sits between
// `action_commands_loaded` and `action_mcp_configs_loaded` and neither
// boundary is moved.

import { feature } from 'bun:bundle';
import chalk from 'chalk';
import React from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import { isCustomAgent } from '../../tools/AgentTool/loadAgentsDir.js';
import { validateForceLoginOrg } from '../../utils/auth.js';
import { logForDebugging } from '../../utils/debug.js';
import { resetUserCache } from '../../utils/user.js';
import type { Root } from '../../ink.js';
import type { FpsMetrics } from '../../utils/fpsTracker.js';
import type { StatsStore } from '../../context/stats.js';
import type { ChannelEntry } from '../../bootstrap/state.js';
import type { InternalPermissionMode } from '../../types/permissions.js';
import { launchSnapshotUpdateDialog } from '../../dialogLaunchers.js';
import { exitWithError, getRenderContext, showSetupScreens } from '../../interactiveHelpers.js';
import type { AgentDefinitionsBundle } from './setupAgent.js';

export type RunTrustAndOnboardingInput = {
  permissionMode: InternalPermissionMode;
  allowDangerouslySkipPermissions: boolean;
  commands: Awaited<ReturnType<typeof import('../../commands.js').getCommands>>;
  devChannels: ChannelEntry[] | undefined;
  remoteControlOption: boolean | string | undefined;
  mainThreadAgentDefinition: AgentDefinitionsBundle['activeAgents'][number] | undefined;
  prompt: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
};

export type RunTrustAndOnboardingResult = {
  root: Root;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
  remoteControl: boolean;
  prompt: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
};

/**
 * Block E. Interactive-only — the caller MUST gate on
 * `!isNonInteractiveSession` before invoking.
 */
export async function runTrustAndOnboarding(
  input: RunTrustAndOnboardingInput,
): Promise<RunTrustAndOnboardingResult> {
  const {
    permissionMode,
    allowDangerouslySkipPermissions,
    commands,
    devChannels,
    remoteControlOption,
    mainThreadAgentDefinition,
  } = input;
  let prompt = input.prompt;
  let inputPrompt = input.inputPrompt;

  const renderCtx = getRenderContext(false);
  const getFpsMetrics = renderCtx.getFpsMetrics;
  const stats = renderCtx.stats;
  const { createRoot } = await import('../../ink.js');
  const root = await createRoot(renderCtx.renderOptions);

  // Log startup time now, before any blocking dialog renders. Logging
  // from REPL's first render (the old location) included however long
  // the user sat on trust/OAuth/onboarding/resume-picker — p99 was ~70s
  // dominated by dialog-wait time, not code-path startup.
  logEvent('tengu_timer', {
    event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    durationMs: Math.round(process.uptime() * 1000),
  });
  const onboardingShown = await showSetupScreens(
    root,
    permissionMode,
    allowDangerouslySkipPermissions,
    commands,
    devChannels,
  );

  // Now that trust is established and GrowthBook has auth headers,
  // resolve the --remote-control / --rc entitlement gate.
  let remoteControl = false;
  if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
    const { getBridgeDisabledReason } = await import('../../bridge/bridgeEnabled.js');
    const disabledReason = await getBridgeDisabledReason();
    remoteControl = disabledReason === null;
    if (disabledReason) {
      process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`));
    }
  }

  // Check for pending agent memory snapshot updates (only for --agent mode, internal-only).
  // AGENT_MEMORY_SNAPSHOT is dead-code-eliminated and SnapshotUpdateDialog is
  // build-time stubbed in this fork, but the typed control flow is preserved.
  if (
    feature('AGENT_MEMORY_SNAPSHOT') &&
    mainThreadAgentDefinition &&
    isCustomAgent(mainThreadAgentDefinition) &&
    mainThreadAgentDefinition.memory &&
    mainThreadAgentDefinition.pendingSnapshotUpdate
  ) {
    const agentDef = mainThreadAgentDefinition;
    const choice = await launchSnapshotUpdateDialog(root, {
      agentType: agentDef.agentType,
      scope: agentDef.memory!,
      snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
    });
    if (choice === 'merge') {
      // SnapshotUpdateDialog is build-time stubbed in this fork; the real
      // module (upstream) exports buildMergePrompt, so we look it up dynamically.
      const mod = (await import('../../components/agents/SnapshotUpdateDialog.js')) as {
        buildMergePrompt?: (agentType: string, memory: typeof agentDef.memory) => string;
      };
      const mergePrompt = mod.buildMergePrompt?.(agentDef.agentType, agentDef.memory) ?? '';
      inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt;
    }
    agentDef.pendingSnapshotUpdate = undefined;
  }

  // Skip executing /login if we just completed onboarding for it
  if (onboardingShown && typeof prompt === 'string' && prompt.trim().toLowerCase() === '/login') {
    prompt = '';
  }
  if (onboardingShown) {
    // Refresh auth-dependent services now that the user has logged in during onboarding.
    // Keep in sync with the post-login logic in src/commands/login.tsx
    void refreshRemoteManagedSettings();
    void refreshPolicyLimits();
    // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
    resetUserCache();
    // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
    refreshGrowthBookAfterAuthChange();
    // Clear any stale trusted device token then enroll for Remote Control.
    // Both self-gate on tengu_sessions_elevated_auth_enforcement internally
    // — enrollTrustedDevice() via checkGate_CACHED_OR_BLOCKING (awaits
    // the GrowthBook reinit above), clearTrustedDeviceToken() via the
    // sync cached check (acceptable since clear is idempotent).
    void import('../../bridge/trustedDevice.js').then(m => {
      m.clearTrustedDeviceToken();
      return m.enrollTrustedDevice();
    });
  }

  // Auto-wizard when no provider profile exists and Onboarding didn't
  // already render ProviderManager. Onboarding embeds ProviderManager as
  // its OAuth step on fresh installs; opening it again here would force
  // the user through provider selection twice when they intentionally
  // skipped during Onboarding.
  try {
    const { getActiveProviderProfile, getProviderProfiles } = await import('../../utils/providerProfiles.js');
    const hasProfiles = getProviderProfiles().length > 0 || Boolean(getActiveProviderProfile());
    if (!hasProfiles && !onboardingShown) {
      const { showSetupDialog } = await import('../../interactiveHelpers.js');
      const { ProviderManager } = await import('../../components/ProviderManager.js');
      await showSetupDialog<void>(root, done => (
        React.createElement(ProviderManager, {
          mode: 'first-run' as const,
          onDone: () => done(),
        })
      ));
    }
  } catch (e) {
    logForDebugging(`[provider-wizard] auto-wizard failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Ctrl+L-style clear after the first-run wizard finishes. Disabled by
  // default (matches cli.tsx); opt in with CLAUDIN_CLEAR_ON_START=1. The
  // banner itself is rendered by Ink (<StartupBanner /> in REPL.tsx) so it
  // scrolls naturally into scrollback as content grows.
  try {
    const { tryGetActiveProvider } = await import('../../services/api/activeProvider.js');
    if (tryGetActiveProvider() && process.stdout.isTTY && process.env.CLAUDIN_CLEAR_ON_START === '1') {
      const { clearTerminal } = await import('../../ink/clearTerminal.js');
      process.stdout.write(clearTerminal);
    }
  } catch (e) {
    logForDebugging(`[startup-clear] failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const orgValidation = await validateForceLoginOrg();
  if (!orgValidation.valid) {
    await exitWithError(root, orgValidation.message);
  }

  return {
    root,
    getFpsMetrics,
    stats,
    remoteControl,
    prompt,
    inputPrompt,
  };
}
