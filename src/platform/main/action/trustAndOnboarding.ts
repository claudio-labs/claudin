// Action handler — Block E: trust dialog + onboarding + login refresh +
// org validation. Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7c.4).
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
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/platform/analytics/index.js';
import { refreshGrowthBookAfterAuthChange } from 'src/platform/analytics/growthbook.js';
import { refreshPolicyLimits } from 'src/platform/policyLimits/index.js';
import { refreshRemoteManagedSettings } from 'src/platform/remoteManagedSettings/index.js';
import { isCustomAgent } from 'src/tools/AgentTool/loadAgentsDir.js';
import { validateForceLoginOrg } from 'src/providers/auth/auth.js';
import { logForDebugging } from 'src/shared/debug.js';
import { resetUserCache } from 'src/shared/user.js';
import type { Root } from 'src/terminal/ink.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';
import type { ChannelEntry } from 'src/platform/bootstrap/state.js';
import type { InternalPermissionMode } from 'src/types/permissions.js';
import { launchSnapshotUpdateDialog } from 'src/terminal/dialogLaunchers.js';
import { exitWithError, getRenderContext, showSetupScreens } from 'src/terminal/interactiveHelpers.js';
import { profileCheckpoint } from 'src/platform/startupProfiler.js';
import type { AgentDefinitionsBundle } from 'src/platform/main/action/setupAgent.js';

export type RunTrustAndOnboardingInput = {
  permissionMode: InternalPermissionMode;
  allowDangerouslySkipPermissions: boolean;
  commands: Awaited<ReturnType<typeof import('src/commands.js').getCommands>>;
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

  profileCheckpoint('trust_onboarding_start');
  // Grove HTTP prefetch lives in cli.tsx (wave 7) so it overlaps with
  // main.tsx parse + setup() — we're already ~500 ms past that kick by
  // the time we reach here, so the memoized cache should be warm before
  // GroveDialog mounts inside showSetupScreens.
  const renderCtx = getRenderContext(false);
  const getFpsMetrics = renderCtx.getFpsMetrics;
  const stats = renderCtx.stats;
  profileCheckpoint('trust_render_ctx_ready');
  const { createRoot } = await import('src/terminal/ink.js');
  profileCheckpoint('trust_ink_imported');
  const root = await createRoot(renderCtx.renderOptions);
  profileCheckpoint('trust_ink_root_created');

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
  profileCheckpoint('trust_setup_screens_done');

  // Now that trust is established and GrowthBook has auth headers,
  // resolve the --remote-control / --rc entitlement gate.
  let remoteControl = false;
  if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
    const { getBridgeDisabledReason } = await import('src/platform/bridge/bridgeEnabled.js');
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
      const mod = (await import('src/agent/ui/agents/SnapshotUpdateDialog.js')) as {
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
    void import('src/platform/bridge/trustedDevice.js').then(m => {
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
    const { getActiveProviderProfile, getProviderProfiles } = await import('src/providers/presets/providerProfiles.js');
    const hasProfiles = getProviderProfiles().length > 0 || Boolean(getActiveProviderProfile());
    if (!hasProfiles && !onboardingShown) {
      const { showSetupDialog } = await import('src/terminal/interactiveHelpers.js');
      const { ProviderManager } = await import('src/providers/ui/ProviderManager.js');
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
    const { tryGetActiveProvider } = await import('src/providers/presets/activeProvider.js');
    if (tryGetActiveProvider() && process.stdout.isTTY && process.env.CLAUDIN_CLEAR_ON_START === '1') {
      const { clearTerminal } = await import('src/terminal/ink/clearTerminal.js');
      process.stdout.write(clearTerminal);
    }
  } catch (e) {
    logForDebugging(`[startup-clear] failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  profileCheckpoint('trust_before_org_validation');
  const orgValidation = await validateForceLoginOrg();
  profileCheckpoint('trust_after_org_validation');
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
