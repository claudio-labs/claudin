// Print/headless branch — `claudin -p` / `--print` / SDK mode. Sets up the
// non-interactive AppState, connects MCP per-server with incremental push,
// dedupes claude.ai connectors, and dispatches to cli/print's runHeadless.
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 5c).

import { feature } from 'bun:bundle';
import pickBy from 'lodash-es/pickBy.js';
import uniqBy from 'lodash-es/uniqBy.js';
import { setSdkBetas, setSessionPersistenceDisabled } from 'src/platform/bootstrap/state.js';
import { initializeTelemetryAfterTrust } from 'src/platform/entrypoints/init.js';
import { clearServerCache, getMcpToolsCommandsAndResources } from 'src/mcp/client.js';
import { dedupClaudeAiMcpServers, getMcpServerSignature } from 'src/mcp/config.js';
import type { McpSdkServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js';
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/mcp/utils.js';
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js';
import { onChangeAppState } from 'src/terminal/state/onChangeAppState.js';
import { createStore } from 'src/terminal/state/store.js';
import { isAdvisorEnabled } from 'src/platform/doctor/advisor.js';
import { validateForceLoginOrg } from 'src/providers/auth/auth.js';
import { filterAllowedSdkBetas } from 'src/providers/transport/betas.js';
import { logForDebugging, setHasFormattedOutput } from 'src/shared/debug.js';
import { getInitialEffortSetting, parseEffortValue } from 'src/utils/effort.js';
import { isBareMode } from 'src/shared/envUtils.js';
import { getInitialFastModeSetting, isFastModeEnabled } from 'src/providers/fastMode.js';
import { applyConfigEnvironmentVariables } from 'src/platform/config/managedEnv.js';
import { checkAndDisableBypassPermissions, verifyAutoModeGateAccess } from 'src/permissions/permissionSetup.js';
import { processSessionStartHooks } from 'src/sessions/sessionStart.js';
import { profileCheckpoint } from 'src/platform/startupProfiler.js';
import type { ThinkingConfig } from 'src/agent/context/thinking.js';
import { startDeferredPrefetches } from 'src/platform/main/deferredPrefetches.js';
import { getMcpStartupTimeoutMs, raceConnectTimeout } from 'src/platform/main/defaultAction/mcpStartupWait.js';
import { logSessionTelemetry } from 'src/platform/main/lifecycle.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { Command } from 'src/shared/types/command.js';
import type { ToolPermissionContext, Tools } from 'src/tools/Tool.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';

export type HeadlessBranchDeps = {
  ctx: BootContext;
  options: {
    continue?: boolean;
    resume?: string | boolean | null;
    sessionPersistence?: boolean;
    permissionPromptTool?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    taskBudget?: number;
    forkSession?: boolean;
    resumeSessionAt?: string;
    rewindFiles?: string;
    enableAuthStatus?: boolean;
    effort?: string;
  };
  teleport: string | boolean | undefined;
  setupTrigger: 'init' | 'maintenance' | null;
  outputFormat: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
  commands: readonly Command[];
  tools: Tools;
  mcpClients: unknown[];
  mcpCommands: unknown[];
  mcpTools: unknown[];
  sdkMcpConfigs: Record<string, McpSdkServerConfig>;
  agentDefinitions: { activeAgents: AgentDefinition[] };
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>;
  claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>;
  toolPermissionContext: ToolPermissionContext;
  effectiveModel: string | undefined;
  advisorModel: string | undefined;
  allowDangerouslySkipPermissions: boolean;
  betas: string[];
  jsonSchema: Record<string, unknown> | undefined;
  allowedTools: string[];
  thinkingConfig: ThinkingConfig;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  userSpecifiedFallbackModel: string | undefined;
  effectiveReplayUserMessages: boolean;
  agentCli: string | undefined;
  verbose: boolean | undefined;
};

export async function runHeadlessBranch(deps: HeadlessBranchDeps): Promise<void> {
  const {
    ctx, options, teleport, setupTrigger, outputFormat, inputPrompt,
    commands, tools, mcpClients, mcpCommands, mcpTools,
    sdkMcpConfigs, agentDefinitions, regularMcpConfigs, claudeaiConfigPromise,
    toolPermissionContext, effectiveModel, advisorModel,
    allowDangerouslySkipPermissions, betas, jsonSchema, allowedTools,
    thinkingConfig, systemPrompt, appendSystemPrompt,
    userSpecifiedFallbackModel, effectiveReplayUserMessages, agentCli, verbose,
  } = deps;

  if (outputFormat === 'stream-json' || outputFormat === 'json') {
    setHasFormattedOutput(true);
  }

  // Apply full environment variables in print mode since trust dialog is bypassed
  // This includes potentially dangerous environment variables from untrusted sources
  // but print mode is considered trusted (as documented in help text)
  applyConfigEnvironmentVariables();

  // Initialize telemetry after env vars are applied so OTEL endpoint env vars and
  // otelHeadersHelper (which requires trust to execute) are available.
  initializeTelemetryAfterTrust();

  // Kick SessionStart hooks now so the subprocess spawn overlaps with
  // MCP connect + plugin init + print.ts import below. loadInitialMessages
  // joins this at print.ts:4397. Guarded same as loadInitialMessages —
  // continue/resume/teleport paths don't fire startup hooks (or fire them
  // conditionally inside the resume branch, where this promise is
  // undefined and the ?? fallback runs). Also skip when setupTrigger is
  // set — those paths run setup hooks first (print.ts:544), and session
  // start hooks must wait until setup completes.
  const sessionStartHooksPromise = options.continue || options.resume || teleport || setupTrigger ? undefined : processSessionStartHooks('startup');
  // Suppress transient unhandledRejection if this rejects before
  // loadInitialMessages awaits it. Downstream await still observes the
  // rejection — this just prevents the spurious global handler fire.
  sessionStartHooksPromise?.catch(() => {});
  profileCheckpoint('before_validateForceLoginOrg');
  // Validate org restriction for non-interactive sessions
  const orgValidation = await validateForceLoginOrg();
  if (!orgValidation.valid) {
    process.stderr.write(orgValidation.message + '\n');
    process.exit(1);
  }

  // Headless mode supports all prompt commands and some local/local-jsx
  // commands that opt in via supportsNonInteractive (local-jsx ones must
  // resolve via onDone without rendering JSX — e.g. /goal).
  // If disableSlashCommands is true, return empty array
  const commandsHeadless = ctx.disableSlashCommands ? [] : commands.filter(command => command.type === 'prompt' && !command.disableNonInteractive || (command.type === 'local' || command.type === 'local-jsx') && command.supportsNonInteractive);
  const defaultState = getDefaultAppState();
  const headlessInitialState: AppState = {
    ...defaultState,
    mcp: {
      ...defaultState.mcp,
      clients: mcpClients,
      commands: mcpCommands,
      tools: mcpTools
    },
    toolPermissionContext,
    effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
    ...(isFastModeEnabled() && {
      fastMode: getInitialFastModeSetting(effectiveModel ?? null)
    }),
    ...(isAdvisorEnabled() && advisorModel && {
      advisorModel
    }),
    // kairosEnabled gates the async fire-and-forget path in
    // executeForkedSlashCommand (processSlashCommand.tsx:132) and
    // AgentTool's shouldRunAsync. The REPL initialState sets this at
    // ~3459; headless was defaulting to false, so the daemon child's
    // scheduled tasks and Agent-tool calls ran synchronously — N
    // overdue cron tasks on spawn = N serial subagent turns blocking
    // user input. Computed at :1620, well before this branch.
    ...(feature('KAIROS') ? {
      kairosEnabled: ctx.kairosEnabled
    } : {})
  } as AppState;

  // Init app state
  const headlessStore = createStore(headlessInitialState, onChangeAppState);

  // Check if bypassPermissions should be disabled based on Statsig gate
  // This runs in parallel to the code below, to avoid blocking the main loop.
  if ((toolPermissionContext as { mode?: string }).mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
    void checkAndDisableBypassPermissions(toolPermissionContext);
  }

  // Async check of auto mode gate — corrects state and disables auto if needed.
  // Gated on TRANSCRIPT_CLASSIFIER (not USER_TYPE) so GrowthBook kill switch runs for external builds too.
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(({
      updateContext
    }) => {
      headlessStore.setState(prev => {
        const nextCtx = updateContext(prev.toolPermissionContext);
        if (nextCtx === prev.toolPermissionContext) return prev;
        return {
          ...prev,
          toolPermissionContext: nextCtx
        };
      });
    });
  }

  // Set global state for session persistence
  if (options.sessionPersistence === false) {
    setSessionPersistenceDisabled(true);
  }

  // Store SDK betas in global state for context window calculation
  // Only store allowed betas (filters by allowlist and subscriber status)
  setSdkBetas(filterAllowedSdkBetas(betas));

  // Print-mode MCP: per-server incremental push into headlessStore.
  // Mirrors useManageMCPConnections — push pending first (so ToolSearch's
  // pending-check at ToolSearchTool.ts:334 sees them), then replace with
  // connected/failed as each server settles.
  const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
    if (Object.keys(configs).length === 0) return Promise.resolve();
    headlessStore.setState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: [...prev.mcp.clients, ...Object.entries(configs).map(([name, config]) => ({
          name,
          type: 'pending' as const,
          config
        }))]
      }
    }));
    return getMcpToolsCommandsAndResources(({
      client,
      tools,
      commands
    }) => {
      headlessStore.setState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: prev.mcp.clients.some(c => c.name === client.name) ? prev.mcp.clients.map(c => c.name === client.name ? client : c) : [...prev.mcp.clients, client],
          tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
          commands: uniqBy([...prev.mcp.commands, ...commands], 'name')
        }
      }));
    }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
  };
  // Await all MCP configs — print mode is often single-turn, so
  // "late-connecting servers visible next turn" doesn't help. SDK init
  // message and turn-1 tool list both need configured MCP tools present.
  // Zero-server case is free via the early return in connectMcpBatch.
  // Connectors parallelize inside getMcpToolsCommandsAndResources
  // (processBatched with Promise.all). claude.ai is awaited too — its
  // fetch was kicked off early (line ~2558) so only residual time blocks
  // here. --bare skips claude.ai entirely for perf-sensitive scripts.
  // Bounded wait — same race mechanism as the claude.ai cap below, but
  // with a generous default: slow-but-working stdio servers (e.g. npx
  // installs on first run) are a real use case. Override via
  // CLAUDIN_MCP_STARTUP_TIMEOUT_MS. If the cap fires, the connect keeps
  // running and updates headlessStore in the background — stragglers'
  // tools are absent for turn 1 but visible turn 2+.
  profileCheckpoint('before_connectMcp');
  const regularMcpTimeoutMs = getMcpStartupTimeoutMs();
  const regularTimedOut = await raceConnectTimeout(connectMcpBatch(regularMcpConfigs, 'regular'), regularMcpTimeoutMs);
  if (regularTimedOut) {
    const stillConnecting = headlessStore.getState().mcp.clients.filter(c => c.type === 'pending').map(c => c.name);
    logForDebugging(`[MCP] MCP server(s) not ready after ${regularMcpTimeoutMs}ms — proceeding without: ${stillConnecting.join(', ') || '(unknown)'}; background connection continues (CLAUDIN_MCP_STARTUP_TIMEOUT_MS overrides the cap)`);
  }
  profileCheckpoint('after_connectMcp');
  // Dedup: suppress plugin MCP servers that duplicate a claude.ai
  // connector (connector wins), then connect claude.ai servers.
  // Bounded wait — #23725 made this blocking so single-turn -p sees
  // connectors, but with 40+ slow connectors tengu_startup_perf p99
  // climbed to 76s. If fetch+connect doesn't finish in time, proceed;
  // the promise keeps running and updates headlessStore in the
  // background so turn 2+ still sees connectors.
  const CLAUDE_AI_MCP_TIMEOUT_MS = 5_000;
  const claudeaiConnect = claudeaiConfigPromise.then(claudeaiConfigs => {
    if (Object.keys(claudeaiConfigs).length > 0) {
      const claudeaiSigs = new Set<string>();
      for (const config of Object.values(claudeaiConfigs)) {
        const sig = getMcpServerSignature(config);
        if (sig) claudeaiSigs.add(sig);
      }
      const suppressed = new Set<string>();
      for (const [name, config] of Object.entries(regularMcpConfigs)) {
        if (!name.startsWith('plugin:')) continue;
        const sig = getMcpServerSignature(config);
        if (sig && claudeaiSigs.has(sig)) suppressed.add(name);
      }
      if (suppressed.size > 0) {
        logForDebugging(`[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate claude.ai connectors: ${[...suppressed].join(', ')}`);
        // Disconnect before filtering from state. Only connected
        // servers need cleanup — clearServerCache on a never-connected
        // server triggers a real connect just to kill it (memoize
        // cache-miss path, see useManageMCPConnections.ts:870).
        for (const c of headlessStore.getState().mcp.clients) {
          if (!suppressed.has(c.name) || c.type !== 'connected') continue;
          c.client.onclose = undefined;
          void clearServerCache(c.name, c.config).catch(() => {});
        }
        headlessStore.setState(prev => {
          let {
            clients,
            tools,
            commands,
            resources
          } = prev.mcp;
          clients = clients.filter(c => !suppressed.has(c.name));
          tools = tools.filter(t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName));
          for (const name of suppressed) {
            commands = excludeCommandsByServer(commands, name);
            resources = excludeResourcesByServer(resources, name);
          }
          return {
            ...prev,
            mcp: {
              ...prev.mcp,
              clients,
              tools,
              commands,
              resources
            }
          };
        });
      }
    }
    // Suppress claude.ai connectors that duplicate an enabled
    // manual server (URL-signature match). Plugin dedup above only
    // handles `plugin:*` keys; this catches manual `.mcp.json` entries.
    // plugin:* must be excluded here — step 1 already suppressed
    // those (claude.ai wins); leaving them in suppresses the
    // connector too, and neither survives (gh-39974).
    const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'));
    const {
      servers: dedupedClaudeAi
    } = dedupClaudeAiMcpServers(claudeaiConfigs, nonPluginConfigs);
    return connectMcpBatch(dedupedClaudeAi, 'claudeai');
  });
  const claudeaiTimedOut = await raceConnectTimeout(claudeaiConnect, CLAUDE_AI_MCP_TIMEOUT_MS);
  if (claudeaiTimedOut) {
    logForDebugging(`[MCP] claude.ai connectors not ready after ${CLAUDE_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`);
  }
  profileCheckpoint('after_connectMcp_claudeai');

  // In headless mode, start deferred prefetches immediately (no user typing delay)
  // --bare / SIMPLE: startDeferredPrefetches early-returns internally.
  // backgroundHousekeeping (initExtractMemories, pruneShellSnapshots,
  // cleanupOldMessageFiles) and sdkHeapDumpMonitor are all bookkeeping
  // that scripted calls don't need — the next interactive session reconciles.
  if (!isBareMode()) {
    startDeferredPrefetches();
    void import('src/platform/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
  }
  logSessionTelemetry();
  profileCheckpoint('before_print_import');
  const {
    runHeadless
  } = await import('src/platform/headless/print.js');
  profileCheckpoint('after_print_import');
  void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, {
    continue: options.continue,
    // runHeadless's resume param doesn't accept null (only
    // string | boolean | undefined) — deps.options.resume does, to mirror
    // the CLI option's own type.
    resume: options.resume ?? undefined,
    verbose: verbose,
    outputFormat: outputFormat,
    jsonSchema,
    permissionPromptToolName: options.permissionPromptTool,
    allowedTools,
    thinkingConfig,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    taskBudget: options.taskBudget ? {
      total: options.taskBudget
    } : undefined,
    systemPrompt,
    appendSystemPrompt,
    userSpecifiedModel: effectiveModel,
    fallbackModel: userSpecifiedFallbackModel,
    // runHeadless's teleport param doesn't accept plain `false` (only
    // string | true | null | undefined) — normalize the falsy boolean case.
    teleport: teleport === false ? undefined : teleport,
    sdkUrl: ctx.sdkUrl,
    replayUserMessages: effectiveReplayUserMessages,
    includePartialMessages: ctx.effectiveIncludePartialMessages,
    forkSession: options.forkSession || false,
    resumeSessionAt: options.resumeSessionAt || undefined,
    rewindFiles: options.rewindFiles,
    enableAuthStatus: options.enableAuthStatus,
    agent: agentCli,
    setupTrigger: setupTrigger ?? undefined,
    sessionStartHooksPromise
  });
}
