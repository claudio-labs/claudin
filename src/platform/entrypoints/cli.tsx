import { feature } from 'bun:bundle';
// NOTE: `validateProviderEnvForStartupOrExit` is dynamic-imported below
// (inside `main()`) on purpose. The static graph of providerValidation
// → providerConfig pulls a ~580 KB chunk (zod schemas eagerly built at
// top-level, preset definitions, OAuth glue) which would otherwise
// bloat the cold-start parse path for `--version`/`--help`.

// Claudin: polyfill globalThis.File for Node < 20.
// undici v7 references `File` at module evaluation time (webidl type
// assertions). Node 18 lacks the global, causing a ReferenceError inside
// the bundled __commonJS require chain which deadlocks the process when a
// proxy is configured (configureGlobalAgents → require_undici).
// eslint-disable-next-line custom-rules/no-top-level-side-effects
if (typeof globalThis.File === 'undefined') {
  try {
    // Node 18.13+ exposes File in node:buffer but not as a global.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File: NodeFile } = require('node:buffer')
    globalThis.File = NodeFile
  } catch {
    // Absolute fallback: stub so `MakeTypeAssertion(File)` doesn't throw.
    // @ts-expect-error -- minimal polyfill
    globalThis.File = class File extends Blob {
      name: string
      lastModified: number
      constructor(parts: BlobPart[], name: string, opts?: FilePropertyBag) {
        super(parts, opts)
        this.name = name
        this.lastModified = opts?.lastModified ?? Date.now()
      }
    }
  }
}

// Claudin: polyfill Promise.withResolvers for Node < 22.
// undici v8+ (used by the bundled fetch) calls Promise.withResolvers at
// runtime during the first HTTP request. Node 21 and earlier lack it,
// causing every API call to fail with "Promise.withResolvers is not a
// function". The polyfill must be installed before any module that pulls
// in undici evaluates — keep it at the top with the File polyfill above.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>() {
    let resolve: (value: T | PromiseLike<T>) => void = () => {}
    let reject: (reason?: unknown) => void = () => {}
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// Claudin: polyfill util.markAsUncloneable for Node < 22.4.
// undici v8 calls util.markAsUncloneable on Response/Request internals to
// prevent structured-clone copies. Node 22.3 and earlier (and all 20.x)
// lack it, causing every HTTP call to throw "util.markAsUncloneable is
// not a function". Stub is a no-op — losing the structured-clone guard
// is harmless when the function isn't available anyway.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeUtil = require('node:util') as { markAsUncloneable?: unknown }
  if (typeof nodeUtil.markAsUncloneable !== 'function') {
    nodeUtil.markAsUncloneable = () => {}
  }
}

// Claudin: disable experimental API betas by default.
// Tool search (defer_loading), global cache scope, and context management
// require internal API support not available to external accounts → 500.
// Users can opt-in with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=false.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= 'true'

// Claudin: enable fine-grained tool streaming on Anthropic 1P by default.
// Without it, the API buffers each tool_use input until complete before
// emitting input_json_delta — freezes spinner counter and delays tool render.
// GrowthBook gate (`tengu_fgts`) is stubbed in open build, so we default the
// env opt-in. Set to '0' to disable.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ??= '1'

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// Set max heap size for child processes in CCR environments (containers have 16GB)
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. feature() gate
// DCEs this entire block from external builds.
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

// Wave 12 — strict whitelist for subcommand names accepted by the
// `<cmd> --help` fast-path. Must match the regex used in scripts/build.ts
// (capture loop) so a name accepted here is guaranteed to have a snapshot
// (or the readFileSync falls through to the slow path). Keeping this
// module-level avoids re-compiling the pattern on every CLI launch.
const SUBCOMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Fast-path for --version/-v: zero module loading needed
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined at build time
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (Claudin)`);
    return;
  }

  // Wave 11 — Fast-path for --help/-h. The full commander program takes
  // ~500 ms warm to load+evaluate+render the help text because configuring
  // all subcommands and their options still drags in providerValidation,
  // permission modes, command registries, and dialogs. The help text itself
  // is static given a build, so we capture it once during `bun run build`
  // (see scripts/build.ts) into dist/help.txt and serve it here with a
  // single readFileSync + stdout write. Falls through to the slow path if
  // the snapshot file is missing or the user passes additional flags.
  // CLAUDIN_HELP_CAPTURE is set when build.ts is harvesting the help text
  // itself — in that case we must take the slow path so commander actually
  // emits the help output for us to capture.
  //
  // Wave 12 extends the fast-path to `claudin <cmd> --help`. The build
  // captures each subcommand's help into dist/help-<cmd>.txt; we serve
  // those whenever args.length === 2 and the first arg passes the same
  // strict whitelist used during capture.
  if (
    !process.env.CLAUDIN_HELP_CAPTURE &&
    (
      (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) ||
      (
        args.length === 2 &&
        (args[1] === '--help' || args[1] === '-h') &&
        SUBCOMMAND_NAME_RE.test(args[0])
      )
    )
  ) {
    try {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { join, dirname } = await import('node:path');
      const distDir = dirname(fileURLToPath(import.meta.url));
      const snapshotName = args.length === 1 ? 'help.txt' : `help-${args[0]}.txt`;
      const help = readFileSync(join(distDir, snapshotName), 'utf-8');
      process.stdout.write(help);
      return;
    } catch {
      // Snapshot missing or unreadable — fall through to the full commander
      // path so the user still gets help, just slower.
    }
  }

  // --provider one-shot is no longer supported. Provider selection is
  // profile-driven via /provider; users with the flag in their shell are
  // pointed at the wizard.
  if (args.includes('--provider')) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      'The --provider CLI flag was removed. Run "claudin" and use /provider to choose a profile.',
    );
    process.exit(1);
  }

  // Kick off the heavy main.js import in parallel with the lightweight prep
  // work below. This is the single biggest chunk in the bundle (~320ms of ESM
  // evaluation); starting it now lets its parse/eval overlap with the small
  // sequential awaits that follow. The result is awaited at the end of this
  // function — see `cli_before_main_import`. Fast-path branches (--daemon, etc.)
  // return before reaching that await, so we attach a no-op catch to avoid
  // PromiseRejection warnings if the orphaned import ever rejects.
  // (Phase A of cold-start plan.)
  const mainImportPromise = import('src/platform/main.js')
  mainImportPromise.catch(() => {
    /* fast-path exited before main was needed; swallow */
  })

  // Enable configs first so we can read settings
  {
    const { enableConfigs } = await import('src/platform/config/config.js')
    enableConfigs()
  }

  // Apply settings.env from user settings
  {
    const { applySafeConfigEnvironmentVariables } = await import('src/platform/config/managedEnv.js')
    applySafeConfigEnvironmentVariables()
  }

  // Fire-and-forget update check: writes ~/.claudin/latest-version.json in the
  // background so the *next* launch's StartupBanner can render the notice.
  // Never awaited — must not gate boot on npm view latency. Self-swallows all
  // errors (see runStartupUpdateCheck).
  void (async () => {
    const { runStartupUpdateCheck } = await import('src/platform/install/startupUpdateCheck.js')
    await runStartupUpdateCheck(args)
  })()

  // Resolve the active provider once — it gates the GitHub Copilot token
  // refresh below, the Grove prefetch, and the clear-on-start logic further
  // down. enableConfigs() already ran above, so profile reads are safe here.
  const { tryGetActiveProvider } = await import(
    'src/providers/presets/activeProvider.js'
  )
  const activeProvider = tryGetActiveProvider()

  // GitHub token hydration is sequential (refresh writes before hydrate reads).
  // validateProviderEnvForStartupOrExit must follow hydration in case the
  // active provider is github_copilot (validation reads the hydrated token).
  // Gated on the active transport: refreshGithubModelsTokenIfNeeded would
  // early-return for other providers anyway, but the gate keeps the
  // credentials/secure-storage chunk (and its awaits) entirely off the serial
  // cold path for the non-Copilot majority.
  if (activeProvider?.transport === 'github_copilot') {
    const {
      hydrateGithubModelsTokenFromSecureStorage,
      refreshGithubModelsTokenIfNeeded,
    } = await import('src/providers/oauth/githubModelsCredentials.js')
    await refreshGithubModelsTokenIfNeeded()
    hydrateGithubModelsTokenFromSecureStorage()
  }

  const { validateProviderEnvForStartupOrExit } = await import(
    'src/providers/presets/providerValidation.js'
  )
  await validateProviderEnvForStartupOrExit()

  // Ctrl+L-style clear before mounting the REPL. Disabled by default so the
  // launch preserves the user's existing terminal contents; opt in with
  // CLAUDIN_CLEAR_ON_START=1. Scrollback is preserved either way (no \x1b[3J).
  // The banner is rendered by Ink (<StartupBanner /> in REPL.tsx) so it scrolls
  // naturally into scrollback as content grows.
  // Wave 7 prefetch (earlier kick) — only meaningful for Anthropic OAuth
  // consumer subscribers, the audience the GroveDialog targets. Fired here
  // (instead of inside trustAndOnboarding) so the two HTTP GETs overlap
  // with main.tsx parse + setup() + commander dispatch — roughly +500 ms
  // of headroom vs. +66 ms when kicked from trust_onboarding_start. Errors
  // are already swallowed inside each memoized fn.
  if (activeProvider && activeProvider.transport === 'anthropic') {
    void (async () => {
      const grove = await import('src/platform/privacy/grove.js')
      void grove.getGroveSettings()
      void grove.getGroveNoticeConfig()
    })()
  }
  if (
    activeProvider &&
    process.stdout.isTTY &&
    process.env.CLAUDIN_CLEAR_ON_START === '1'
  ) {
    const { clearTerminal } = await import('src/terminal/ink/clearTerminal.js')
    process.stdout.write(clearTerminal)
  }

  // For all other paths, load the startup profiler
  const {
    profileCheckpoint
  } = await import('src/platform/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // Fast-path for --dump-system-prompt: output the rendered system prompt and exit.
  // Used by prompt sensitivity evals to extract the system prompt at a specific commit.
  // `--subagent` renders what an Agent-tool child gets instead (the main prompt
  // never contains it — that block is assembled by
  // enhanceSystemPromptWithEnvDetails, not getSystemPrompt).
  // Ant-only: eliminated from external builds via feature flag.
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('src/platform/config/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('src/providers/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt,
      enhanceSystemPromptWithEnvDetails,
      DEFAULT_AGENT_PROMPT
    } = await import('src/agent/prompts/prompts.js');
    const prompt = args.includes('--subagent') ? await enhanceSystemPromptWithEnvDetails([DEFAULT_AGENT_PROMPT], model) : await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('src/platform/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // Fast-path for `claude remote-control` (also accepts legacy `claude remote` / `claude sync` / `claude bridge`):
  // serve local machine as bridge environment.
  // feature() must stay inline for build-time dead code elimination;
  // isBridgeEnabled() checks the runtime GrowthBook gate.
  if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc' || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
    profileCheckpoint('cli_bridge_path');
    const {
      enableConfigs
    } = await import('src/platform/config/config.js');
    enableConfigs();
    const {
      getBridgeDisabledReason,
      checkBridgeMinVersion
    } = await import('src/platform/bridge/bridgeEnabled.js');
    const {
      BRIDGE_LOGIN_ERROR
    } = await import('src/platform/bridge/types.js');
    const {
      bridgeMain
    } = await import('src/platform/bridge/bridgeMain.js');
    const {
      exitWithError
    } = await import('src/shared/proc/process.js');

    // Auth check must come before the GrowthBook gate check — without auth,
    // GrowthBook has no user context and would return a stale/default false.
    // getBridgeDisabledReason awaits GB init, so the returned value is fresh
    // (not the stale disk cache), but init still needs auth headers to work.
    const {
      getClaudeAIOAuthTokens
    } = await import('src/providers/auth/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge is a remote control feature - check policy limits
    const {
      waitForPolicyLimitsToLoad,
      isPolicyAllowed
    } = await import('src/platform/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    await bridgeMain(args.slice(1));
    return;
  }

  // Fast-path for `claude daemon [subcommand]`: long-running supervisor.
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('src/platform/config/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('src/shared/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for `claude ps|logs|attach|kill` and `--bg`/`--background`.
  // Session management against the ~/.claudin/sessions/ registry. Flag
  // literals are inlined so bg.js only loads when actually dispatching.
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('src/platform/config/config.js');
    enableConfigs();
    const bg = await import('../headless/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  // Fast-path for template job commands.
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../headless/handlers/templateJobs.js');
    await templatesMain(args);
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // Fast-path for `claude environment-runner`: headless BYOC runner.
  // feature() must stay inline for build-time dead code elimination.
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for `claude self-hosted-runner`: headless self-hosted-runner
  // targeting the SelfHostedRunnerWorkerService API (register + poll; poll IS
  // heartbeat). feature() must stay inline for build-time dead code elimination.
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('src/platform/config/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('src/vcs/git/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('src/vcs/git/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        const {
          exitWithError
        } = await import('src/shared/proc/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // No special flags detected, load and run the full CLI
  if (process.env.CLAUDIN_DISABLE_EARLY_INPUT !== '1') {
    const {
      startCapturingEarlyInput
    } = await import('src/terminal/input/earlyInput.js');
    startCapturingEarlyInput();
  }
  profileCheckpoint('cli_before_main_import');
  // mainImportPromise was started at the top of main() to overlap with the
  // sequential prep work above (Phase A). It's almost certainly resolved by
  // now, so this await is effectively free.
  const {
    main: cliMain
  } = await mainImportPromise;
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
