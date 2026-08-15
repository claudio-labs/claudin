// Action handler — startup sequence after trust/onboarding (Blocks F + H).
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7c.5).
//
// Split into three sequential helpers, called from main.tsx with
// profileCheckpoint(...) interleaved at the original sites:
//
//   const guards = await runPostHeadlessGuards(...);
//   if (guards.exited) return;
//   profileCheckpoint('action_mcp_configs_loaded');
//   const hooks = runMcpHooksAndTelemetry(...);
//   // plugins init stays inline (checkpoint inside .then() callback)
//   // initOnly short-circuit stays inline
//   // headless branch (Block G) call stays inline
//   const interactive = runInteractiveStartupBlock(...);
//
// No helper performs profileCheckpoint(...).

import { feature } from 'bun:bundle';
import { addToHistory } from 'src/agent/history.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/platform/analytics/index.js';
import { getSubscriptionType } from 'src/providers/auth/auth.js';
import { getRemoteControlAtStartup, getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js';
import { logForDebugging } from 'src/shared/debug.js';
import { isBareMode } from 'src/shared/envUtils.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js';
import { checkQuotaStatus } from 'src/providers/claudeAiLimits.js';
import { fetchBootstrapData } from 'src/providers/transport/bootstrap.js';
import { prefetchPassesEligibility } from 'src/providers/usage/referral.js';
import { isLspGloballyEnabled } from 'src/platform/lsp/userSettings.js';
import { initializeLspServerManager } from 'src/platform/lsp/manager.js';
import { prefetchAllMcpResources } from 'src/mcp/client.js';
import type { McpSdkServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js';
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js';
import { isAdvisorEnabled } from 'src/platform/doctor/advisor.js';
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js';
import { logError } from 'src/shared/log.js';
import { logContextMetrics } from 'src/providers/transport/api.js';
import { uniq } from 'src/shared/data/array.js';
import { getUserMsgOptIn } from 'src/platform/bootstrap/state.js';
import { countConcurrentSessions, registerSession, updateSessionName } from 'src/sessions/concurrentSessions.js';
import { registerCleanup } from 'src/shared/cleanupRegistry.js';
import { createEmptyAttributionState } from 'src/vcs/git/commitAttribution.js';
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js';
import { getModelDeprecationWarning } from 'src/providers/model/deprecation.js';
import { getInitialEffortSetting, parseEffortValue } from 'src/providers/effort/effort.js';
import { getInitialFastModeSetting, prefetchFastModeStatus, resolveFastModeStatusFromCache } from 'src/providers/fastMode.js';
import { gracefulShutdownSync } from 'src/shared/proc/gracefulShutdown.js';
import { isInBundledMode } from 'src/platform/install/bundledMode.js';
import { logManagedSettings, logSessionTelemetry, logStartupTelemetry, logTenguInit } from 'src/platform/main/lifecycle.js';
import { createUserMessage } from 'src/agent/messages/messages.js';
import { processSessionStartHooks } from 'src/sessions/sessionStart.js';
import { prefetchCopilotModelCatalog } from 'src/providers/model/copilotModelCatalog.js';
import { prefetchOllamaModels } from 'src/providers/model/ollamaModels.js';
import { prefetchOpenAICompatibleModels } from 'src/providers/model/openaiModelDiscovery.js';
import { getInitialSettings, getSettingsWithErrors } from 'src/platform/settings/settings.js';
import { plural } from 'src/shared/text/stringUtils.js';
import { computeInitialTeamContext } from 'src/agent/coordinator/swarm/reconnection.js';
import { shouldEnablePromptSuggestion } from 'src/terminal/prompt-suggestion/promptSuggestion.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from 'src/agent/context/thinking.js';
import { launchInvalidSettingsDialog } from 'src/terminal/dialogLaunchers.js';
import { type AppState, IDLE_SPECULATION_STATE } from 'src/terminal/state/AppStateStore.js';
import type { Root } from 'src/terminal/ink.js';
import type { InternalPermissionMode } from 'src/shared/types/permissions.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { ActionOptions } from 'src/platform/main/action/parseOptions.js';
import uniqBy from 'lodash-es/uniqBy.js';

// =============================================================================
// runPostHeadlessGuards — Block F-1: exitCode guard + LSP + invalid settings +
// startup prefetches + MCP config loading + sdk/regular split
// =============================================================================

export type RunPostHeadlessGuardsInput = {
  options: ActionOptions;
  ctx: BootContext;
  root: Root;
  isNonInteractiveSession: boolean;
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig | McpSdkServerConfig> | Record<string, unknown>;
  mcpConfigPromise: Promise<{ servers: Record<string, unknown> }>;
};

export type RunPostHeadlessGuardsResult =
  | { exited: true }
  | {
      exited: false;
      allMcpConfigs: Record<string, ScopedMcpServerConfig | McpSdkServerConfig>;
      sdkMcpConfigs: Record<string, McpSdkServerConfig>;
      regularMcpConfigs: Record<string, ScopedMcpServerConfig>;
    };

export async function runPostHeadlessGuards(
  input: RunPostHeadlessGuardsInput,
): Promise<RunPostHeadlessGuardsResult> {
  const { ctx: _ctx, root, isNonInteractiveSession, dynamicMcpConfig, mcpConfigPromise } = input;

  // If gracefulShutdown was initiated (e.g., user rejected trust dialog),
  // process.exitCode will be set. Skip all subsequent operations that could
  // trigger code execution before the process exits (e.g. we don't want apiKeyHelper
  // to run if trust was not established).
  if (process.exitCode !== undefined) {
    logForDebugging('Graceful shutdown initiated, skipping further initialization');
    return { exited: true };
  }

  // Initialize LSP manager AFTER trust is established (or in non-interactive mode
  // where trust is implicit). This prevents plugin LSP servers from executing
  // code in untrusted directories before user consent.
  // Must be after inline plugins are set (if any) so --plugin-dir LSP servers are included.
  if (isLspGloballyEnabled()) {
    initializeLspServerManager();
  }

  if (!isNonInteractiveSession) {
    const { errors } = getSettingsWithErrors();
    const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
    const settingsTransport = tryGetActiveProvider()?.transport;
    if (
      nonMcpErrors.length > 0 &&
      settingsTransport !== 'openai_compat' &&
      settingsTransport !== 'codex_responses' &&
      settingsTransport !== 'github_copilot'
    ) {
      await launchInvalidSettingsDialog(root, {
        settingsErrors: nonMcpErrors,
        onExit: () => gracefulShutdownSync(1),
      });
    }
  }

  // Check quota status, fast mode, passes eligibility, and bootstrap data
  // --bare / SIMPLE: skip — these are cache-warms for the REPL's
  // first-turn responsiveness (quota, passes, fastMode, bootstrap data). Fast
  // mode doesn't apply to the Agent SDK anyway (see getFastModeUnavailableReason).
  const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('tengu_cicada_nap_ms', 0);
  const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
  const skipStartupPrefetches = isBareMode() || (bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs);
  // Always prefetch Ollama models (not gated by throttle — local server, fast & cheap)
  prefetchOllamaModels();
  // Prefetch models for remote OpenAI-compat providers (OpenRouter, Groq, NovitaAI, etc.)
  void prefetchOpenAICompatibleModels();
  // Prefetch the live Copilot model catalog (no-op unless github_copilot is active)
  prefetchCopilotModelCatalog();

  if (!skipStartupPrefetches) {
    const lastPrefetchedInfo = lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
    logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);
    checkQuotaStatus().catch(error => logError(error));

    // Fetch bootstrap data from the server and update all cache values.
    void fetchBootstrapData();

    // TODO: Consolidate other prefetches into a single bootstrap request.
    void prefetchPassesEligibility();
    if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)) {
      void prefetchFastModeStatus();
    } else {
      // Kill switch skips the network call, not org-policy enforcement.
      // Resolve from cache so orgStatus doesn't stay 'pending' (which
      // getFastModeUnavailableReason treats as permissive).
      resolveFastModeStatusFromCache();
    }
    if (bgRefreshThrottleMs > 0) {
      saveGlobalConfig(current => ({
        ...current,
        startupPrefetchedAt: Date.now(),
      }));
    }
  } else {
    logForDebugging(`Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`);
    // Resolve fast mode org status from cache (no network)
    resolveFastModeStatusFromCache();
  }
  if (!isNonInteractiveSession) {
    // Pre-fetch example commands (runs git log, no API call)
    const { refreshExampleCommands } = await import('src/commands/exampleCommands.js');
    void refreshExampleCommands();
  }

  const { servers: existingMcpConfigs } = await mcpConfigPromise;
  // CLI flag (--mcp-config) should override file-based configs, matching settings precedence
  const allMcpConfigs = {
    ...existingMcpConfigs,
    ...dynamicMcpConfig,
  } as Record<string, ScopedMcpServerConfig | McpSdkServerConfig>;

  // Separate SDK configs from regular MCP configs
  const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
  const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};
  for (const [name, config] of Object.entries(allMcpConfigs)) {
    const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
    if (typedConfig.type === 'sdk') {
      sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
    } else {
      regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
    }
  }

  return { exited: false, allMcpConfigs, sdkMcpConfigs, regularMcpConfigs };
}

// =============================================================================
// runMcpHooksAndTelemetry — Block F-2: MCP prefetch + hooksPromise + thinking +
// startup telemetry calls
// =============================================================================

export type RunMcpHooksAndTelemetryInput = {
  options: ActionOptions;
  ctx: BootContext;
  isNonInteractiveSession: boolean;
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>;
  claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>;
  mainThreadAgentDefinition: { agentType: string } | undefined;
  resolvedInitialModel: string;
  initOnly: boolean | undefined;
  init: boolean | undefined;
  maintenance: boolean | undefined;
  // logTenguInit inputs
  prompt: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
  verbose: boolean | undefined;
  debug: boolean | undefined;
  debugToStderr: boolean | undefined;
  print: boolean | undefined;
  outputFormat: string | undefined;
  inputFormat: string | undefined;
  allowedTools: string[];
  disallowedTools: string[];
  allMcpConfigs: Record<string, unknown>;
  dangerouslySkipPermissions: boolean | undefined;
  permissionMode: InternalPermissionMode;
  allowDangerouslySkipPermissions: boolean;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  // logContextMetrics
  toolPermissionContext: unknown;
  // session name
  sessionNameArg: string | undefined;
};

export type RunMcpHooksAndTelemetryDeps = {
  assistantModule: { getAssistantActivationPath: () => string } | null;
  coordinatorModeModule: { isCoordinatorMode: () => boolean } | null;
};

type McpPrefetchResult = Awaited<ReturnType<typeof prefetchAllMcpResources>>;

export type RunMcpHooksAndTelemetryResult = {
  mcpPromise: Promise<McpPrefetchResult>;
  hooksPromise: ReturnType<typeof processSessionStartHooks> | null;
  hookMessages: Awaited<NonNullable<ReturnType<typeof processSessionStartHooks>>>;
  mcpClients: McpPrefetchResult['clients'];
  mcpTools: McpPrefetchResult['tools'];
  mcpCommands: McpPrefetchResult['commands'];
  thinkingEnabled: boolean;
  thinkingConfig: ThinkingConfig;
};

export function runMcpHooksAndTelemetry(
  input: RunMcpHooksAndTelemetryInput,
  deps: RunMcpHooksAndTelemetryDeps,
): RunMcpHooksAndTelemetryResult {
  const {
    options,
    ctx,
    isNonInteractiveSession,
    regularMcpConfigs,
    claudeaiConfigPromise,
    mainThreadAgentDefinition,
    resolvedInitialModel,
    initOnly,
    init,
    maintenance,
    prompt,
    inputPrompt,
    verbose,
    debug,
    debugToStderr,
    print,
    outputFormat,
    inputFormat,
    allowedTools,
    disallowedTools,
    allMcpConfigs,
    dangerouslySkipPermissions,
    permissionMode,
    allowDangerouslySkipPermissions,
    systemPrompt,
    appendSystemPrompt,
    toolPermissionContext,
    sessionNameArg,
  } = input;
  const { assistantModule, coordinatorModeModule } = deps;

  // Prefetch MCP resources after trust dialog (this is where execution happens).
  // Interactive mode only: print mode defers connects until headlessStore exists
  // and pushes per-server (below), so ToolSearch's pending-client handling works
  // and one slow server doesn't block the batch.
  const localMcpPromise = isNonInteractiveSession
    ? Promise.resolve({ clients: [], tools: [], commands: [] })
    : prefetchAllMcpResources(regularMcpConfigs);
  const claudeaiMcpPromise = isNonInteractiveSession
    ? Promise.resolve({ clients: [], tools: [], commands: [] })
    : claudeaiConfigPromise.then(configs =>
        Object.keys(configs).length > 0
          ? prefetchAllMcpResources(configs)
          : { clients: [], tools: [], commands: [] },
      );
  // Merge with dedup by name: each prefetchAllMcpResources call independently
  // adds helper tools (ListMcpResourcesTool, ReadMcpResourceTool) via
  // local dedup flags, so merging two calls can yield duplicates. print.ts
  // already uniqBy's the final tool pool, but dedup here keeps appState clean.
  const mcpPromise = Promise.all([localMcpPromise, claudeaiMcpPromise]).then(([local, claudeai]) => ({
    clients: [...local.clients, ...claudeai.clients],
    tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
    commands: uniqBy([...local.commands, ...claudeai.commands], 'name'),
  }));

  // Start hooks early so they run in parallel with MCP connections.
  // Skip for initOnly/init/maintenance (handled separately), non-interactive
  // (handled via setupTrigger), and resume/continue (conversationRecovery.ts
  // fires 'resume' instead — without this guard, hooks fire TWICE on /resume
  // and the second systemMessage clobbers the first. gh-30825)
  const hooksPromise = initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume
    ? null
    : processSessionStartHooks('startup', {
        agentType: mainThreadAgentDefinition?.agentType,
        model: resolvedInitialModel,
      });

  // MCP never blocks REPL render OR turn 1 TTFT. useManageMCPConnections
  // populates appState.mcp async as servers connect (connectToServer is
  // memoized — the prefetch calls above and the hook converge on the same
  // connections). getToolUseContext reads store.getState() fresh via
  // computeTools(), so turn 1 sees whatever's connected by query time.
  // Slow servers populate for turn 2+. Matches interactive-no-prompt
  // behavior. Print mode: per-server push into headlessStore (below).
  const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
  // Suppress transient unhandledRejection — the prefetch warms the
  // memoized connectToServer cache but nobody awaits it in interactive.
  mcpPromise.catch(() => {});
  const mcpClients: McpPrefetchResult['clients'] = [];
  const mcpTools: McpPrefetchResult['tools'] = [];
  const mcpCommands: McpPrefetchResult['commands'] = [];
  let thinkingEnabled = shouldEnableThinkingByDefault();
  let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? { type: 'adaptive' } : { type: 'disabled' };
  if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
    thinkingEnabled = true;
    thinkingConfig = { type: 'adaptive' };
  } else if (options.thinking === 'disabled') {
    thinkingEnabled = false;
    thinkingConfig = { type: 'disabled' };
  } else {
    const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
      : (options as { maxThinkingTokens?: number }).maxThinkingTokens;
    if (maxThinkingTokens !== undefined) {
      if (maxThinkingTokens > 0) {
        thinkingEnabled = true;
        thinkingConfig = { type: 'enabled', budgetTokens: maxThinkingTokens };
      } else if (maxThinkingTokens === 0) {
        thinkingEnabled = false;
        thinkingConfig = { type: 'disabled' };
      }
    }
  }
  logForDiagnosticsNoPII('info', 'started', {
    version: MACRO.VERSION,
    is_native_binary: isInBundledMode(),
  });
  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'exited');
  });
  void logTenguInit({
    hasInitialPrompt: Boolean(prompt),
    hasStdin: Boolean(inputPrompt),
    verbose: verbose as boolean,
    debug: debug as boolean,
    debugToStderr: debugToStderr as boolean,
    print: print ?? false,
    outputFormat: outputFormat ?? 'text',
    inputFormat: inputFormat ?? 'text',
    numAllowedTools: allowedTools.length,
    numDisallowedTools: disallowedTools.length,
    mcpClientCount: Object.keys(allMcpConfigs).length,
    worktreeEnabled: ctx.worktreeEnabled,
    skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
    githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
    dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
    permissionMode,
    modeIsBypass: permissionMode === 'bypassPermissions',
    allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
    systemPromptFlag: systemPrompt ? ((options as { systemPromptFile?: string }).systemPromptFile ? 'file' : 'flag') : undefined,
    appendSystemPromptFlag: appendSystemPrompt ? ((options as { appendSystemPromptFile?: string }).appendSystemPromptFile ? 'file' : 'flag') : undefined,
    thinkingConfig,
    assistantActivationPath: feature('KAIROS') && ctx.kairosEnabled ? assistantModule?.getAssistantActivationPath() : undefined,
    isCoordinator: feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode() === true,
  });

  // Log context metrics once at initialization
  void logContextMetrics(regularMcpConfigs, toolPermissionContext as Parameters<typeof logContextMetrics>[1]);
  logManagedSettings();

  // Register PID file for concurrent-session detection (~/.claudin/sessions/)
  // and fire multi-clauding telemetry. Lives here (not init.ts) so only the
  // REPL path registers — not subcommands like `claude doctor`. Chained:
  // count must run after register's write completes or it misses our own file.
  void registerSession().then(registered => {
    if (!registered) return;
    if (sessionNameArg) {
      void updateSessionName(sessionNameArg);
    }
    void countConcurrentSessions().then(count => {
      if (count >= 2) {
        logEvent('tengu_concurrent_sessions', {
          num_sessions: count as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }
    });
  });

  return {
    mcpPromise,
    hooksPromise,
    hookMessages,
    mcpClients,
    mcpTools,
    mcpCommands,
    thinkingEnabled,
    thinkingConfig,
  };
}

// =============================================================================
// runInteractiveStartupBlock — Block H: model log + notifications + initialState
// + history + setImmediate telemetry
// =============================================================================

export type RunInteractiveStartupBlockInput = {
  options: ActionOptions;
  ctx: BootContext;
  // model telemetry
  agentSetting: string | undefined;
  resolvedInitialModel: string;
  // notifications
  permissionModeNotification: string | undefined;
  overlyBroadBashPermissions: Array<{ ruleDisplay: string; sourceDisplay: string }>;
  // initialState fields
  toolPermissionContext: { mode?: unknown } & Record<string, unknown>;
  initialMainLoopModel: string | null;
  agentDefinitions: { allAgents: unknown[]; activeAgents: unknown[] } & Record<string, unknown>;
  mainThreadAgentDefinition: { agentType: string } | undefined;
  verbose: boolean | undefined;
  remoteControl: boolean;
  remoteControlName: string | undefined;
  advisorModel: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
  thinkingEnabled: boolean;
  mcpTools: Array<unknown>;
};

export type RunInteractiveStartupBlockResult = {
  initialState: AppState;
  initialTools: Array<unknown>;
};

export function runInteractiveStartupBlock(
  input: RunInteractiveStartupBlockInput,
  deps: { getTeammateUtils: () => { isPlanModeRequired: () => boolean } },
): RunInteractiveStartupBlockResult {
  const {
    options,
    ctx,
    agentSetting,
    resolvedInitialModel,
    permissionModeNotification,
    overlyBroadBashPermissions,
    toolPermissionContext,
    initialMainLoopModel,
    agentDefinitions,
    mainThreadAgentDefinition,
    verbose,
    remoteControl,
    remoteControlName,
    advisorModel,
    inputPrompt,
    thinkingEnabled,
    mcpTools,
  } = input;
  const { getTeammateUtils } = deps;

  // Log model config at startup
  logEvent('tengu_startup_manual_model_config', {
    cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    env_var: tryGetActiveProvider()?.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    settings_file: (getInitialSettings() || {}).model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    subscriptionType: getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });

  // Get deprecation warning for the initial model (resolvedInitialModel computed earlier for hooks parallelization)
  const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

  // Build initial notification queue
  const initialNotifications: Array<{
    key: string;
    text: string;
    color?: 'warning';
    priority: 'high';
  }> = [];
  if (permissionModeNotification) {
    initialNotifications.push({
      key: 'permission-mode-notification',
      text: permissionModeNotification,
      priority: 'high',
    });
  }
  if (deprecationWarning) {
    initialNotifications.push({
      key: 'model-deprecation-warning',
      text: deprecationWarning,
      color: 'warning',
      priority: 'high',
    });
  }
  if (overlyBroadBashPermissions.length > 0) {
    const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay));
    const displays = displayList.join(', ');
    const sources = uniq(overlyBroadBashPermissions.map(p => p.sourceDisplay)).join(', ');
    const n = displayList.length;
    initialNotifications.push({
      key: 'overly-broad-bash-notification',
      text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
      color: 'warning',
      priority: 'high',
    });
  }
  const effectiveToolPermissionContext = {
    ...toolPermissionContext,
    mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? ('plan' as const) : toolPermissionContext.mode,
  };
  // All startup opt-in paths (--tools, --brief, defaultView) have fired
  // above; initialIsBriefOnly just reads the resulting state.
  const initialIsBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false;
  const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || ctx.kairosEnabled;
  let ccrMirrorEnabled = false;
  if (feature('CCR_MIRROR') && !fullRemoteControl) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isCcrMirrorEnabled } = require('src/platform/bridge/bridgeEnabled.js') as typeof import('src/platform/bridge/bridgeEnabled.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    ccrMirrorEnabled = isCcrMirrorEnabled();
  }
  const initialState: AppState = {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: verbose ?? getGlobalConfig().verbose ?? false,
    mainLoopModel: initialMainLoopModel,
    mainLoopModelForSession: null,
    isBriefOnly: initialIsBriefOnly,
    collapseSubagentProgress: getGlobalConfig().collapseSubagentProgress ?? true,
    expandedView: getGlobalConfig().showSpinnerTree ? 'teammates' : getGlobalConfig().showExpandedTodos ? 'tasks' : 'none',
    showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
    selectedIPAgentIndex: -1,
    collapsedTaskGroups: [],
    seededTaskGroups: [],
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    toolPermissionContext: effectiveToolPermissionContext as AppState['toolPermissionContext'],
    agent: mainThreadAgentDefinition?.agentType,
    agentDefinitions: agentDefinitions as AppState['agentDefinitions'],
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    statusLineText: undefined,
    kairosEnabled: ctx.kairosEnabled,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
    replBridgeExplicit: remoteControl,
    replBridgeOutboundOnly: ccrMirrorEnabled,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: remoteControlName,
    showRemoteCallout: false,
    notifications: {
      current: null,
      queue: initialNotifications,
    },
    elicitation: {
      queue: [],
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    thinkingEnabled,
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    authVersion: 0,
    initialMessage: inputPrompt
      ? {
          message: createUserMessage({
            content: String(inputPrompt),
          }),
        }
      : null,
    effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
    activeOverlays: new Set<string>(),
    fastMode: getInitialFastModeSetting(resolvedInitialModel),
    ...(isAdvisorEnabled() && advisorModel && {
      advisorModel,
    }),
    // Compute teamContext synchronously to avoid useEffect setState during render.
    // KAIROS: assistantTeamContext takes precedence — set earlier in the
    // KAIROS block so Agent(name: "foo") can spawn in-process teammates
    // without TeamCreate. computeInitialTeamContext() is for tmux-spawned
    // teammates reading their own identity, not the assistant-mode leader.
    teamContext: feature('KAIROS')
      ? ((ctx.assistantTeamContext as ReturnType<NonNullable<typeof computeInitialTeamContext>> | undefined) ?? computeInitialTeamContext?.())
      : computeInitialTeamContext?.(),
  };

  // Add CLI initial prompt to history
  if (inputPrompt) {
    addToHistory(String(inputPrompt));
  }
  const initialTools = mcpTools;

  // Keep startup bookkeeping best-effort so restricted environments can
  // still reach the REPL even when the global config is not writable.
  saveGlobalConfig(current => ({
    ...current,
    numStartups: (current.numStartups ?? 0) + 1,
  }));
  setImmediate(() => {
    void logStartupTelemetry();
    logSessionTelemetry();
  });

  return {
    initialState,
    initialTools,
  };
}

