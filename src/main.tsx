// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query) so they run in
//    parallel with the remaining ~135ms of imports below
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API
//    key) in parallel — isRemoteManagedSettingsEligible() otherwise reads them
//    sequentially via sync spawn inside applySafeConfigEnvironmentVariables()
//    (~65ms on every macOS startup)
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();
import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch();
import { feature } from 'bun:bundle';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { Root } from './ink.js';
// launchRepl/setPreloadedChunks pull React+Ink — only needed for interactive
// launch path. getTools pulls every tool's transitive graph. initBootstrap
// pulls undici/growthbook/OAuth populate. All three are gated by argv: cold
// paths (--help/--version/subcommands) never need them. (Phase D.)
import type * as ReplLauncherMod from './replLauncher.js';
import type { McpSdkServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import type { ToolInputJSONSchema } from './Tool.js';
import type * as ToolsMod from './tools.js';
import type * as InitMod from './entrypoints/init.js';
import type { AssistantHandles } from './main/action/parseOptions.js';
import type { AssistantModule as SetupAgentAssistantModule } from './main/action/setupAgent.js';
import type { RunMcpHooksAndTelemetryDeps } from './main/action/startupSequence.js';
const getLaunchRepl = async (): Promise<typeof ReplLauncherMod.launchRepl> =>
  (await import('./replLauncher.js')).launchRepl;
const getSetPreloadedChunks = async (): Promise<typeof ReplLauncherMod.setPreloadedChunks> =>
  (await import('./replLauncher.js')).setPreloadedChunks;
const getGetTools = async (): Promise<typeof ToolsMod.getTools> =>
  (await import('./tools.js')).getTools;
const getInitBootstrap = async (): Promise<typeof InitMod.init> =>
  (await import('./entrypoints/init.js')).init;
import { stopCapturingEarlyInput } from './utils/earlyInput.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { installLifecycleHandlers } from './main/lifecycleHandlers.js';

// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () => require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () => require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for KAIROS (assistant mode)
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS') ? require('./assistant/index.js') as typeof import('./assistant/index.js') : null;
const kairosGate = feature('KAIROS') ? require('./assistant/gate.js') as typeof import('./assistant/gate.js') : null;
import { resolve } from 'path';
import type { StatsStore } from './context/stats.js';
// renderAndRun is loaded lazily inside the default action — it pulls React,
// Ink, KeybindingSetup, AppStateProvider, growthbook, mcpServerApproval, and
// ~20 transitive utilities. None of those are needed for `--help`, `--version`,
// or any non-interactive subcommand path, so deferring this single import
// keeps that whole graph out of `main_tsx_entry`. (Phase B of cold-start plan.)
const getRenderAndRun = async () =>
  (await import('./interactiveHelpers.js')).renderAndRun;
/* eslint-enable @typescript-eslint/no-require-imports */
import { isBareMode, isEnvTruthy } from './utils/envUtils.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
// Plugin startup checks are now handled non-blockingly in REPL.tsx

import { getCwd } from 'src/utils/cwd.js';

// Action-handler-only imports: these are needed after commander parse and action
// dispatch, not during module evaluation. Lazy-loading them defers their
// dependency chains until the REPL is ready to mount.
/* eslint-disable @typescript-eslint/no-require-imports */
const getCreateSyntheticOutputTool = () => require('./tools/SyntheticOutputTool/SyntheticOutputTool.js').createSyntheticOutputTool as typeof import('./tools/SyntheticOutputTool/SyntheticOutputTool.js').createSyntheticOutputTool
const getIsSyntheticOutputToolEnabled = () => require('./tools/SyntheticOutputTool/SyntheticOutputTool.js').isSyntheticOutputToolEnabled as typeof import('./tools/SyntheticOutputTool/SyntheticOutputTool.js').isSyntheticOutputToolEnabled
const getJsonParse = () => require('./utils/slowOperations.js').jsonParse as typeof import('./utils/slowOperations.js').jsonParse
const getCreateSystemMessage = () => require('./utils/messages.js').createSystemMessage as typeof import('./utils/messages.js').createSystemMessage
const getBuildDeepLinkBanner = () => require('./utils/deepLink/banner.js').buildDeepLinkBanner as typeof import('./utils/deepLink/banner.js').buildDeepLinkBanner
const getPermissionModes = () => require('./utils/permissions/PermissionMode.js').PERMISSION_MODES as typeof import('./utils/permissions/PermissionMode.js').PERMISSION_MODES
const getLogEvent = () => require('src/services/analytics/index.js').logEvent as typeof import('src/services/analytics/index.js').logEvent
type AnalyticsMetadata = import('src/services/analytics/index.js').AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
const getInitializeVersionedPlugins = () => require('./utils/plugins/installedPluginsManager.js').initializeVersionedPlugins as typeof import('./utils/plugins/installedPluginsManager.js').initializeVersionedPlugins
const getCleanupOrphanedPluginVersionsInBackground = () => require('./utils/plugins/cacheUtils.js').cleanupOrphanedPluginVersionsInBackground as typeof import('./utils/plugins/cacheUtils.js').cleanupOrphanedPluginVersionsInBackground
const getGlobExclusionsForPluginCacheFn = () => require('./utils/plugins/orphanedPluginFilter.js').getGlobExclusionsForPluginCache as typeof import('./utils/plugins/orphanedPluginFilter.js').getGlobExclusionsForPluginCache
const getProcessSessionStartHooks = () => require('./utils/sessionStart.js').processSessionStartHooks as typeof import('./utils/sessionStart.js').processSessionStartHooks
const getProcessSetupHooks = () => require('./utils/sessionStart.js').processSetupHooks as typeof import('./utils/sessionStart.js').processSetupHooks
const getSaveMode = () => require('./utils/sessionStorage.js').saveMode as typeof import('./utils/sessionStorage.js').saveMode
const getGracefulShutdownSync = () => require('src/utils/gracefulShutdown.js').gracefulShutdownSync as typeof import('src/utils/gracefulShutdown.js').gracefulShutdownSync
/* eslint-enable @typescript-eslint/no-require-imports */

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

// TeleportRepoMismatchDialog, TeleportResumeWrapper dynamically imported at call sites
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress dynamically imported at call site
import {
  getInputPrompt,
  isBeingDebugged,
  type TeammateOptions,
} from './main/helpers.js';
import {
  eagerLoadSettings,
  initializeEntrypoint,
  maybeActivateBrief,
  maybeActivateProactive,
} from './main/lifecycle.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

// logManagedSettings moved to src/main/lifecycle.ts (ROADMAP 11g Fase 2)

// Check if running in debug/inspection mode
// Exit if we detect node debugging or inspection
if (isBeingDebugged()) {
  // Use process.exit directly here since we're in the top-level code before imports
  // and gracefulShutdown is not yet available
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1);
}

// logSessionTelemetry, logStartupTelemetry, runMigrations, prefetchSystemContextIfSafe moved to src/main/lifecycle.ts (ROADMAP 11g Fase 2)
// startDeferredPrefetches moved to src/main/deferredPrefetches.ts (ROADMAP 11g Fase 3)
// Re-exported below to preserve the public surface for src/interactiveHelpers.tsx.
import { startDeferredPrefetches } from './main/deferredPrefetches.js';
export { startDeferredPrefetches };
import { buildBootContext } from './main/bootContext.js';
import { pendingAssistantChat, pendingConnect, pendingSSH } from './main/pendingSlots.js';
import {
  runAssistantArgvStash,
  runDeepLinkArgvHandling,
  runDirectConnectArgvRewrite,
  runSshArgvStash,
} from './main/argvPreparse.js';
import { applyClientType, resolveClientType } from './main/clientType.js';
// All three registrars touch heavy graphs (preActionHook pulls policyLimits +
// remoteManagedSettings; registerSubcommands pulls every command's transitive
// closure — that's the bulk of the 5.2 MB shared chunk). Defer them so they
// only evaluate inside run(), not during module load. (Phase F.)
const getRegisterPreActionHook = async () =>
  (await import('./main/preActionHook.js')).registerPreActionHook;
const getRegisterRootOptions = async () =>
  (await import('./main/rootOptions.js')).registerRootOptions;
const getRegisterSubcommands = async () =>
  (await import('./main/registerSubcommands.js')).registerSubcommands;
// Default-action deps are loaded lazily via './main/defaultActionDeps.js' —
// see the dynamic import at the top of program.action() below. Keeping these
// as type-only imports preserves the type-checking surface while letting the
// bundler keep them out of `main_tsx_entry`. (Phase C of cold-start plan.)
import type { ActionOptions } from './main/action/parseOptions.js';
// Subcommands extracted to src/main/commands/ (ROADMAP 11g Fase 5a) and bundled
// via registerSubcommands in src/main/registerSubcommands.ts (ROADMAP 11g Fase 7b).
// Default-action branches extracted to src/main/defaultAction/ (ROADMAP 11g Fase 5b).
// loadSettingsFromFlag, loadSettingSourcesFromFlag moved to src/main/helpers.ts (ROADMAP 11g Fase 1)
// eagerLoadSettings, initializeEntrypoint moved to src/main/lifecycle.ts (ROADMAP 11g Fase 2)

// Pending slots (DIRECT_CONNECT / KAIROS / SSH_REMOTE) moved to
// src/main/pendingSlots.ts (ROADMAP 11g Fase 7 margin #1). They're imported
// above; argv pre-parsing in main() mutates them by reference BEFORE the
// default action runs, then they're copied into ctx.pending.
export async function main() {
  profileCheckpoint('main_function_start');

  // SECURITY: Prevent Windows from executing commands from current directory
  // This must be set before ANY command execution to prevent PATH hijacking attacks
  // See: https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // Lifecycle handlers: warning handler + exit/SIGINT listeners.
  // Extracted to src/main/lifecycleHandlers.ts (ROADMAP 11g Fase 6).
  installLifecycleHandlers();
  profileCheckpoint('main_warning_handler_initialized');

  // Argv pre-parse helpers extracted to src/main/argvPreparse.ts (ROADMAP 11g Fase 7a).
  // Each helper inspects/mutates process.argv before commander runs and stashes
  // state into the corresponding _pending* slot (later copied into the
  // BootContext at the top of the default action).
  await runDirectConnectArgvRewrite(pendingConnect);
  await runDeepLinkArgvHandling();
  runAssistantArgvStash(pendingAssistantChat);
  runSshArgvStash(pendingSSH);

  // Resolve clientType/previewFormat/sessionSource/isInteractive from env+argv.
  // Extracted to src/main/clientType.ts (ROADMAP 11g Fase 7a). Apply via setters
  // BEFORE initializeEntrypoint() because telemetry init reads isInteractive.
  const resolvedClient = resolveClientType();
  if (!resolvedClient.isInteractive) {
    stopCapturingEarlyInput();
  }
  applyClientType(resolvedClient);
  // Initialize entrypoint based on mode - needs to be set before any event is logged
  initializeEntrypoint(!resolvedClient.isInteractive);
  profileCheckpoint('main_client_type_determined');

  // Parse and load settings flags early, before init()
  eagerLoadSettings();

  // Start init() early — overlapping with commander parse/setup.
  // init() is memoized, so the await in preActionHook resolves instantly
  // if this promise already settled, cutting ~80-150ms off startup latency.
  // Module is now dynamic (Phase D) so the import resolution is chained in.
  const earlyInitPromise = getInitBootstrap().then(init => init());

  // Preload REPL/App dynamic import chunks in parallel with commander setup —
  // but only when argv looks interactive. `--help`/`--version`/`-h`/`-V` exit
  // before launchRepl ever runs, so paying for these preloads (and for the
  // replLauncher module that holds them) is pure waste on those paths.
  const argv = process.argv;
  const looksHelpOrVersion = argv.some(a =>
    a === '--help' || a === '-h' || a === '--version' || a === '-V',
  );
  if (!looksHelpOrVersion) {
    const replChunkPromise = import('./screens/REPL.js');
    const appChunkPromise = import('./components/App.js');
    void getSetPreloadedChunks().then(set => set(
      appChunkPromise as Promise<typeof import('./components/App.js')>,
      replChunkPromise as Promise<typeof import('./screens/REPL.js')>,
    ));
  }

  profileCheckpoint('main_before_run');
  // Commander parse + preAction hook runs; the hook awaits init() which
  // resolves immediately if earlyInitPromise already settled.
  await run();
  await earlyInitPromise; // Ensure any init() error propagates
  profileCheckpoint('main_after_run');
}
// getInputPrompt moved to src/main/helpers.ts (ROADMAP 11g Fase 1)
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // Create help config that sorts options by long option name.
  // Commander supports compareOptions at runtime but @commander-js/extra-typings
  // doesn't include it in the type definitions, so we use Object.assign to add it.
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({
      sortSubcommands: true,
      sortOptions: true
    } as const, {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b))
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // preAction hook extracted to src/main/preActionHook.ts (ROADMAP 11g Fase 7b).
  (await getRegisterPreActionHook())(program);
  program.name('claude').description(`Claude Code - starts an interactive session by default, use -p/--print for non-interactive output`).allowExcessArguments().argument('[prompt]', 'Your prompt', String)
  // Subcommands inherit helpOption via commander's copyInheritedSettings —
  // setting it once here covers mcp, plugin, auth, and all other subcommands.
  .helpOption('-h, --help', 'Display help for command').option('-d, --debug [filter]', 'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")', (_value: string | true) => {
    // If value is provided, it will be the filter string
    // If not provided but flag is present, value will be true
    // The actual filtering is handled in debug.ts by parsing process.argv
    return true;
  }).addOption(new Option('-D, --debug-to-stderr', 'Enable debug mode (to stderr)').argParser(Boolean).hideHelp()).option('--debug-file <path>', 'Write debug logs to a specific file path (implicitly enables debug mode)', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).option('-p, --print', 'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.', () => true).option('--bare', 'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.', () => true).addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp()).addOption(new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp()).addOption(new Option('--maintenance', 'Run Setup hooks with maintenance trigger, then continue').hideHelp()).addOption(new Option('--output-format <format>', 'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)').choices(['text', 'json', 'stream-json'])).addOption(new Option('--json-schema <schema>', 'JSON Schema for structured output validation. ' + 'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String)).option('--include-hook-events', 'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)', () => true).option('--include-partial-messages', 'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)', () => true).addOption(new Option('--input-format <format>', 'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)').choices(['text', 'stream-json'])).option('--mcp-debug', '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)', () => true).option('--dangerously-skip-permissions', 'Bypass all permission checks. Recommended only for sandboxes with no internet access.', () => true).option('--allow-dangerously-skip-permissions', 'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.', () => true).addOption(new Option('--thinking <mode>', 'Thinking mode: enabled, disabled').choices(['enabled', 'disabled']).hideHelp()).addOption(new Option('--max-thinking-tokens <tokens>', '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-turns <turns>', 'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-budget-usd <amount>', 'Maximum dollar amount to spend on API calls (only works with --print)').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd must be a positive number greater than 0');
    }
    return amount;
  })).addOption(new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget must be a positive integer');
    }
    return tokens;
  }).hideHelp()).option('--replay-user-messages', 'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)', () => true).addOption(new Option('--enable-auth-status', 'Enable auth status messages in SDK mode').default(false).hideHelp()).option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")').option('--tools <tools...>', 'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").').option('--disallowedTools, --disallowed-tools <tools...>', 'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")').option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings (space-separated)').addOption(new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts (only works with --print)').argParser(String).hideHelp()).addOption(new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(String)).addOption(new Option('--system-prompt-file <file>', 'Read system prompt from a file').argParser(String).hideHelp()).addOption(new Option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt').argParser(String)).addOption(new Option('--append-system-prompt-file <file>', 'Read system prompt from a file and append to the default system prompt').argParser(String).hideHelp()).addOption(new Option('--permission-mode <mode>', 'Permission mode to use for the session').argParser(String).choices(getPermissionModes())).option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true).option('-r, --resume [value]', 'Resume a conversation by session ID, or open interactive picker with optional search term', value => value || true).option('--fork-session', 'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)', () => true).addOption(new Option('--prefill <text>', 'Pre-fill the prompt input with text without submitting it').hideHelp()).addOption(new Option('--deep-link-origin', 'Signal that this session was launched from a deep link').hideHelp()).addOption(new Option('--deep-link-repo <slug>', 'Repo slug the deep link ?repo= parameter resolved to the current cwd').hideHelp()).addOption(new Option('--deep-link-last-fetch <ms>', 'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline').argParser(v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }).hideHelp()).option('--from-pr [value]', 'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term', value => value || true).option('--no-session-persistence', 'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)').addOption(new Option('--resume-session-at <message id>', 'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)').argParser(String).hideHelp()).addOption(new Option('--rewind-files <user-message-id>', 'Restore files to state at the specified user message and exit (requires --resume)').hideHelp())
  // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
  .option('--model <model>', `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-5').`).option('--provider <provider>', `AI provider to use (anthropic, openai, gemini, github, bedrock, vertex, ollama). Reads API keys from environment variables.`).addOption(new Option('--effort <level>', `Effort level for the current session (low, medium, high, max)`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
    }
    return value;
  })).option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`).option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)').option('--fallback-model <model>', 'Enable automatic fallback to specified model when default model is overloaded (only works with --print)').option('--settings <file-or-json>', 'Path to a settings JSON file or a JSON string to load additional settings from').option('--add-dir <directories...>', 'Additional directories to allow tool access to').option('--ide', 'Automatically connect to IDE on startup if exactly one valid IDE is available', () => true).option('--strict-mcp-config', 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations', () => true).option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)').option('-n, --name <name>', 'Set a display name for this session (shown in /resume and terminal title)').option('--agents <json>', 'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
  // gh-33508: <paths...> (variadic) consumed everything until the next
  // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
  // `mcp` and `add` as paths, then choked on --transport as an unknown
  // top-level option. Single-value + collect accumulator means each
  // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
  .option('--plugin-dir <path>', 'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)', (val: string, prev: string[]) => [...prev, val], [] as string[]).option('--disable-slash-commands', 'Disable all skills', () => true).option('--file <specs...>', 'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)').action(async (prompt, options) => {
    profileCheckpoint('action_handler_start');

    // Lazy-load the default-action graph here — see defaultActionDeps.ts for
    // the rationale. This single dynamic import keeps interactiveHelpers
    // (React/Ink/AppState/...) and the dispatch graph out of `main_tsx_entry`
    // so cold paths (--help, subcommands) don't pay for them.
    const {
      parseActionOptions,
      runMcpAndPerms,
      runActionAgentSetup,
      runActionPostSetup,
      runActionSetup,
      runTrustAndOnboarding,
      runInteractiveStartupBlock,
      runMcpHooksAndTelemetry,
      runPostHeadlessGuards,
      runDefaultActionDispatch,
    } = await import('./main/defaultActionDeps.js');

    // BootContext seam (ROADMAP 11g Fase 4). Currently only carries the three
    // pending slots (DIRECT_CONNECT / KAIROS / SSH_REMOTE) populated by argv
    // pre-parsing in main(). Subsequent waves will migrate more fields here.
    const ctx = buildBootContext({
      prompt,
      pendingConnect,
      pendingAssistantChat,
      pendingSSH,
    });

    // Block A — options parse + validation (ROADMAP 11g Fase 7c.1).
    // Extracted to src/main/action/parseOptions.ts. Mutates ctx in place
    // and returns the locals needed by Blocks B/C/D/E.
    const actionOptions = await parseActionOptions(prompt, options as ActionOptions, ctx, {
      teammate: { getTeammateUtils, getTeammatePromptAddendum, getTeammateModeSnapshot },
      assistant: { assistantModule: assistantModule as AssistantHandles['assistantModule'], kairosGate },
    });
    prompt = actionOptions.prompt;
    const {
      debug,
      debugToStderr,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions,
      baseTools,
      allowedTools,
      disallowedTools,
      mcpConfig,
      permissionModeCli,
      addDir,
      fallbackModel,
      betas,
      ide,
      sessionId,
      includeHookEvents,
      init,
      initOnly,
      maintenance,
      agentsJson,
      agentCli,
      teleport,
      remote,
      remoteControlOption,
      remoteControlName,
      isNonInteractiveSession,
    } = actionOptions;
    let outputFormat = actionOptions.outputFormat;
    let inputFormat = actionOptions.inputFormat;
    let verbose = actionOptions.verbose;
    let print = actionOptions.print;
    let systemPrompt = actionOptions.systemPrompt;
    let appendSystemPrompt = actionOptions.appendSystemPrompt;
    let remoteControl = false;

    // Block B — MCP config + permissions + channels (ROADMAP 11g Fase 7c.2).
    // Extracted to src/main/action/mcpAndPerms.ts.
    const mcpAndPerms = await runMcpAndPerms(
      {
        options: options as ActionOptions,
        ctx,
        permissionModeCli,
        dangerouslySkipPermissions,
        allowDangerouslySkipPermissions,
        baseTools,
        allowedTools,
        disallowedTools,
        mcpConfig,
        addDir,
        isNonInteractiveSession,
        inputFormat,
        outputFormat,
      },
      { autoModeStateModule },
    );
    const {
      permissionMode,
      permissionModeNotification,
      strictMcpConfig,
      devChannels,
      claudeaiConfigPromise,
      mcpConfigPromise,
      mcpConfigResolvedRef,
      overlyBroadBashPermissions,
    } = mcpAndPerms;
    let dynamicMcpConfig = mcpAndPerms.dynamicMcpConfig;
    let toolPermissionContext = mcpAndPerms.toolPermissionContext;

    const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
    profileCheckpoint('action_after_input_prompt');

    // Activate proactive mode BEFORE getTools() so SleepTool.isEnabled()
    // (which returns isProactiveActive()) passes and Sleep is included.
    // The later REPL-path maybeActivateProactive() calls are idempotent.
    maybeActivateProactive(options);
    let tools = (await getGetTools())(toolPermissionContext);

    // Apply coordinator mode tool filtering for headless path
    // (mirrors useMergedTools.ts filtering for REPL/interactive path)
    if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      const {
        applyCoordinatorToolFilter
      } = await import('./utils/toolPool.js');
      tools = applyCoordinatorToolFilter(tools);
    }
    profileCheckpoint('action_tools_loaded');
    let jsonSchema: ToolInputJSONSchema | undefined;
    if (getIsSyntheticOutputToolEnabled()({
      isNonInteractiveSession
    }) && options.jsonSchema) {
      jsonSchema = getJsonParse()(options.jsonSchema) as ToolInputJSONSchema;
    }
    if (jsonSchema) {
      const syntheticOutputResult = getCreateSyntheticOutputTool()(jsonSchema);
      if ('tool' in syntheticOutputResult) {
        // Add SyntheticOutputTool to the tools array AFTER getTools() filtering.
        // This tool is excluded from normal filtering (see tools.ts) because it's
        // an implementation detail for structured output, not a user-controlled tool.
        tools = [...tools, syntheticOutputResult.tool];
        getLogEvent()('tengu_structured_output_enabled', {
          schema_property_count: Object.keys(jsonSchema.properties as Record<string, unknown> || {}).length as AnalyticsMetadata,
        });
      } else {
        getLogEvent()('tengu_structured_output_failure', {
          error: 'Invalid JSON schema' as AnalyticsMetadata
        });
      }
    }

    // IMPORTANT: setup() must be called before any other code that depends on the cwd or worktree setup
    profileCheckpoint('action_before_setup');
    const { preSetupCwd, commandsPromise, agentDefsPromise } = await runActionSetup({
      options: options as ActionOptions,
      ctx,
      permissionMode,
      allowDangerouslySkipPermissions,
      sessionId,
    });
    profileCheckpoint('action_after_setup');

    const {
      effectiveReplayUserMessages,
      sessionNameArg,
      userSpecifiedModel,
      userSpecifiedFallbackModel,
      currentCwd,
      commands,
      agentDefinitionsResult,
    } = await runActionPostSetup({
      options: options as ActionOptions,
      ctx,
      outputFormat,
      fallbackModel,
      preSetupCwd,
      commandsPromise,
      agentDefsPromise,
    });
    profileCheckpoint('action_commands_loaded');

    const agentSetup = await runActionAgentSetup(
      {
        options: options as ActionOptions,
        ctx,
        isNonInteractiveSession,
        agentCli,
        agentsJson,
        userSpecifiedModel,
        agentDefinitionsResult,
        systemPrompt,
        appendSystemPrompt,
        inputPrompt,
      },
      { coordinatorModeModule, assistantModule: assistantModule as SetupAgentAssistantModule },
    );
    const {
      agentDefinitions,
      cliAgents,
      agentSetting,
      effectiveModel,
      initialMainLoopModel,
      resolvedInitialModel,
      advisorModel,
    } = agentSetup;
    let mainThreadAgentDefinition = agentSetup.mainThreadAgentDefinition;
    systemPrompt = agentSetup.systemPrompt;
    appendSystemPrompt = agentSetup.appendSystemPrompt;
    inputPrompt = agentSetup.inputPrompt;
    // Wave 6 audit — split the +33ms gap between action_commands_loaded and
    // action_mcp_configs_loaded into three measurable segments: agent setup,
    // trust/onboarding, post-headless guards (MCP configs parse).
    profileCheckpoint('action_after_agent_setup');


    // Ink root is only needed for interactive sessions — patchConsole in the
    // Ink constructor would swallow console output in headless mode.
    let root!: Root;
    let getFpsMetrics!: () => FpsMetrics | undefined;
    let stats!: StatsStore;

    // Block E — trust dialog + onboarding + login + orgValidation
    // (ROADMAP 11g Fase 7c.4). Extracted to src/main/action/trustAndOnboarding.ts.
    // Interactive-only; the helper creates the Ink root and returns the
    // render handles + the mutated locals.
    if (!isNonInteractiveSession) {
      const trustResult = await runTrustAndOnboarding({
        permissionMode,
        allowDangerouslySkipPermissions,
        commands,
        devChannels,
        remoteControlOption,
        mainThreadAgentDefinition,
        prompt,
        inputPrompt,
      });
      root = trustResult.root;
      getFpsMetrics = trustResult.getFpsMetrics;
      stats = trustResult.stats;
      remoteControl = trustResult.remoteControl;
      prompt = trustResult.prompt;
      inputPrompt = trustResult.inputPrompt;
    }
    // Wave 6 audit checkpoint (after trust dialog + onboarding + login +
    // orgValidation). Headless sessions skip the block entirely, so Δ is ~0
    // there; interactive cold path is where the cost concentrates.
    profileCheckpoint('action_after_trust_onboarding');

    // Block F-1 — exitCode guard + LSP + invalid settings + startup prefetches
    // + MCP config split (ROADMAP 11g Fase 7c.5). Extracted to
    // src/main/action/startupSequence.ts.
    const guards = await runPostHeadlessGuards({
      options: options as ActionOptions,
      ctx,
      root,
      isNonInteractiveSession,
      dynamicMcpConfig,
      mcpConfigPromise,
    });
    if (guards.exited) {
      return;
    }
    const { allMcpConfigs, sdkMcpConfigs, regularMcpConfigs } = guards;
    profileCheckpoint('action_mcp_configs_loaded');

    // Block F-2 — MCP resources prefetch + hooksPromise + thinking + startup
    // telemetry calls (ROADMAP 11g Fase 7c.5). Extracted to
    // src/main/action/startupSequence.ts.
    const hooksAndTelemetry = runMcpHooksAndTelemetry(
      {
        options: options as ActionOptions,
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
      },
      { assistantModule: assistantModule as RunMcpHooksAndTelemetryDeps['assistantModule'], coordinatorModeModule },
    );
    const {
      hooksPromise,
      hookMessages,
      mcpClients,
      mcpTools,
      mcpCommands,
      thinkingConfig,
      thinkingEnabled,
    } = hooksAndTelemetry;

    // Initialize versioned plugins system (triggers V1→V2 migration if
    // needed). Then run orphan GC, THEN warm the Grep/Glob exclusion cache.
    // Sequencing matters: the warmup scans disk for .orphaned_at markers,
    // so it must see the GC's Pass 1 (remove markers from reinstalled
    // versions) and Pass 2 (stamp unmarked orphans) already applied. The
    // warm also lands before autoupdate (fires on first submit in REPL)
    // can orphan this session's active version underneath us.
    // --bare / SIMPLE: skip plugin version sync + orphan cleanup. These
    // are install/upgrade bookkeeping that scripted calls don't need —
    // the next interactive session will reconcile. The await here was
    // blocking -p on a marketplace round-trip.
    if (isBareMode()) {
      // skip — no-op
    } else if (isNonInteractiveSession) {
      // In headless mode, await to ensure plugin sync completes before CLI exits
      await getInitializeVersionedPlugins()();
      profileCheckpoint('action_after_plugins_init');
      void getCleanupOrphanedPluginVersionsInBackground()().then(() => getGlobExclusionsForPluginCacheFn()());
    } else {
      // In interactive mode, fire-and-forget — this is purely bookkeeping
      // that doesn't affect runtime behavior of the current session
      void getInitializeVersionedPlugins()().then(async () => {
        profileCheckpoint('action_after_plugins_init');
        await getCleanupOrphanedPluginVersionsInBackground()();
        void getGlobExclusionsForPluginCacheFn()();
      });
    }
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
    if (initOnly) {
      applyConfigEnvironmentVariables();
      await getProcessSetupHooks()('init', {
        forceSyncExecution: true
      });
      await getProcessSessionStartHooks()('startup', {
        forceSyncExecution: true
      });
      getGracefulShutdownSync()(0);
      return;
    }

    // --print mode (extracted to src/main/defaultAction/headless.ts — Fase 5c)
    if (isNonInteractiveSession) {
      const { runHeadlessBranch } = await import('./main/defaultAction/headless.js');
      await runHeadlessBranch({
        ctx,
        options: {
          continue: options.continue,
          resume: options.resume,
          sessionPersistence: options.sessionPersistence,
          permissionPromptTool: options.permissionPromptTool,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          taskBudget: options.taskBudget,
          forkSession: options.forkSession,
          resumeSessionAt: options.resumeSessionAt,
          rewindFiles: options.rewindFiles,
          enableAuthStatus: options.enableAuthStatus,
          effort: options.effort,
        },
        teleport: teleport ?? undefined,
        setupTrigger,
        outputFormat,
        inputPrompt,
        commands,
        tools,
        mcpClients,
        mcpCommands,
        mcpTools,
        sdkMcpConfigs,
        agentDefinitions,
        regularMcpConfigs,
        claudeaiConfigPromise,
        toolPermissionContext,
        effectiveModel,
        advisorModel,
        allowDangerouslySkipPermissions,
        betas,
        jsonSchema,
        allowedTools,
        thinkingConfig,
        systemPrompt,
        appendSystemPrompt,
        userSpecifiedFallbackModel,
        effectiveReplayUserMessages,
        agentCli,
        verbose,
      });
      return;
    }

    // Block H — interactive startup block: model log + notifications +
    // initialState + history + setImmediate telemetry (ROADMAP 11g Fase 7c.5).
    // Extracted to src/main/action/startupSequence.ts.
    const interactiveStartup = runInteractiveStartupBlock(
      {
        options: options as ActionOptions,
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
      },
      { getTeammateUtils },
    );
    const { initialState, initialTools } = interactiveStartup;

    // Block I — sessionConfig/resumeContext + dispatch (ROADMAP 11g Fase 7c.6).
    // Extracted to src/main/defaultAction/dispatch.ts. The dispatch helper
    // builds sessionConfig/resumeContext internally and returns sessionConfig
    // for the REPL inline block below.
    const dispatchResult = await runDefaultActionDispatch({
      root,
      ctx,
      options: options as ActionOptions,
      debug,
      debugToStderr,
      commands,
      initialTools,
      mcpClients,
      mcpCommands,
      ide,
      teleport,
      remote,
      thinkingConfig,
      dynamicMcpConfig,
      strictMcpConfig,
      systemPrompt,
      appendSystemPrompt,
      coordinatorModeModule,
      agentDefinitions,
      currentCwd,
      cliAgents,
      initialState,
      getFpsMetrics,
      stats,
      mainThreadAgentDefinition,
    });
    const { sessionConfig } = dispatchResult;
    if (dispatchResult.handled) {
      return;
    }
    mainThreadAgentDefinition = dispatchResult.mainThreadAgentDefinition as typeof mainThreadAgentDefinition;

    // REPL branch — stays inline because the action_after_hooks checkpoint
    // must remain at the original callsite.
    {
      const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;
      profileCheckpoint('action_after_hooks');
      maybeActivateProactive(options);
      maybeActivateBrief(options);
      // Persist the current mode for fresh sessions so future resumes know what mode was used
      if (feature('COORDINATOR_MODE')) {
        getSaveMode()(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // If launched via a deep link, show a provenance banner so the user
      // knows the session originated externally. Linux xdg-open and
      // browsers with "always allow" set dispatch the link with no OS-level
      // confirmation, so this is the only signal the user gets that the
      // prompt — and the working directory / CLAUDE.md it implies — came
      // from an external source rather than something they typed.
      let deepLinkBanner: ReturnType<ReturnType<typeof getCreateSystemMessage>> | null = null;
      if (feature('LODESTONE')) {
        if (options.deepLinkOrigin) {
          getLogEvent()('tengu_deep_link_opened', {
            has_prefill: Boolean(options.prefill),
            has_repo: Boolean(options.deepLinkRepo)
          });
          deepLinkBanner = getCreateSystemMessage()(getBuildDeepLinkBanner()({
            cwd: getCwd(),
            prefillLength: options.prefill?.length,
            repo: options.deepLinkRepo,
            lastFetch: options.deepLinkLastFetch !== undefined ? new Date(options.deepLinkLastFetch) : undefined
          }), 'warning');
        } else if (options.prefill) {
          deepLinkBanner = getCreateSystemMessage()('Launched with a pre-filled prompt — review it before pressing Enter.', 'warning');
        }
      }
      const initialMessages = deepLinkBanner ? [deepLinkBanner, ...hookMessages] : hookMessages.length > 0 ? hookMessages : undefined;
      const launchRepl = await getLaunchRepl();
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState,
      } as Parameters<typeof launchRepl>[1], {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages,
      } as Parameters<typeof launchRepl>[2], await getRenderAndRun());
    }
  }).version(`${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (Claudin)`, '-v, --version', 'Output the version number');

  // Post-action root options extracted to src/main/rootOptions.ts (ROADMAP 11g Fase 7b).
  (await getRegisterRootOptions())(program);
  profileCheckpoint('run_main_options_built');

  // -p/--print mode: skip subcommand registration. The 52 subcommands
  // (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
  // never dispatched in print mode — commander routes the prompt to the
  // default action. The subcommand registration path was measured at ~65ms
  // on baseline — mostly the isBridgeEnabled() call (25ms settings Zod parse
  // + 40ms sync keychain subprocess), both hidden by the try/catch that
  // always returns false before enableConfigs(). cc:// URLs are rewritten to
  // `open` at main() line ~851 BEFORE this runs, so argv check is safe here.
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // Subcommand registration extracted to src/main/registerSubcommands.ts (ROADMAP 11g Fase 7b).
  (await getRegisterSubcommands())(program, { pendingConnect });

  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // Record final checkpoint for total_time calculation
  profileCheckpoint('main_after_run');

  // Log startup perf to Statsig (sampled) and output detailed report if enabled
  profileReport();
  return program;
}
// logTenguInit, maybeActivateProactive, maybeActivateBrief moved to src/main/lifecycle.ts (ROADMAP 11g Fase 2)
// resetCursor, TeammateOptions, extractTeammateOptions moved to src/main/helpers.ts (ROADMAP 11g Fase 1)
