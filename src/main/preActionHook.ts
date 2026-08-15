// Commander preAction hook extracted from src/main.tsx run() (ROADMAP 11g Fase 7b).
//
// Runs initialization only when executing a command, not when displaying help.
// All profileCheckpoint(...) calls remain in this module because they fire
// inside the hook callback, which is the original logical callsite. The
// snapshot test in src/main/__tests__/bootSnapshot.test.ts scans this file.

import { feature } from 'bun:bundle';
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

import { setInlinePlugins } from 'src/bootstrap/state.js';
// init.ts is the heaviest module in the bundle (undici + growthbook + OAuth
// populate + mTLS + scratchpad/swarm bootstrap). Loading it statically here
// pulled it into the main chunk and made `--help` evaluate the whole graph.
// Defer it — the preAction hook only fires for *executing* commands, so the
// dynamic import cost is paid exactly when it would have been anyway.
const getInit = async (): Promise<typeof import('src/entrypoints/init.js').init> =>
  (await import('src/entrypoints/init.js')).init;
import { loadPolicyLimits } from 'src/services/policyLimits/index.js';
import { loadRemoteManagedSettings } from 'src/services/remoteManagedSettings/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { clearPluginCache } from 'src/services/plugins/pluginLoader.js';
import { ensureKeychainPrefetchCompleted } from 'src/services/secureStorage/keychainPrefetch.js';
import { ensureMdmSettingsLoaded } from 'src/services/settings/mdm/settings.js';
import { profileCheckpoint } from 'src/utils/startupProfiler.js';

import { runMigrations } from 'src/main/lifecycle.js';

/**
 * Attach the preAction hook to `program`. Returns the same `program` to allow
 * chaining. The hook fires when commander dispatches a command — not when
 * `--help` is printed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPreActionHook(program: CommanderCommand<any, any, any>): CommanderCommand<any, any, any> {
  program.hook('preAction', async thisCommand => {
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    await (await getInit())();
    profileCheckpoint('preAction_after_init');

    // process.title on Windows sets the console title directly; on POSIX,
    // terminal shell integration may mirror the process name to the tab.
    // After init() so settings.json env can also gate this (gh-4765).
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claudin';
    }

    // Attach logging sinks so subcommand handlers can use logEvent/logError.
    // Before PR #11106 logEvent dispatched directly; after, events queue until
    // a sink attaches. setup() attaches sinks for the default command, but
    // subcommands (doctor, mcp, plugin, auth) never call setup() and would
    // silently drop events on process.exit(). Both inits are idempotent.
    const { initSinks } = await import('src/utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508: --plugin-dir is a top-level program option. The default
    // action reads it from its own options destructure, but subcommands
    // (plugin list, plugin install, mcp *) have their own actions and
    // never see it. Wire it up here so getInlinePlugins() works everywhere.
    // thisCommand.opts() is typed {} here because this hook is attached
    // before .option('--plugin-dir', ...) in the chain — extra-typings
    // builds the type as options are added. Narrow with a runtime guard;
    // the collect accumulator + [] default guarantee string[] in practice.
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // Copy legacy .claudin-profile.json sidecar into providerProfiles[]
    // (one-shot, idempotent), then rescue CLAUDE_CODE_USE_* envs into
    // /provider when no active profile is set.
    try {
      const { runClaudinStartupMigrations } = require('src/services/config/claudinStartupMigrations.js') as typeof import('src/services/config/claudinStartupMigrations.js');
      runClaudinStartupMigrations();
    } catch (e) {
      // Migrations are best-effort; never block startup on them.
      logForDebugging(`[startup-migrations] failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    profileCheckpoint('preAction_after_claudin_migrations');

    // Load remote managed settings for enterprise customers (non-blocking)
    // Fails open - if fetch fails, continues without remote settings
    // Settings are applied via hot-reload when they arrive
    // Must happen after init() to ensure config reading is allowed
    void loadRemoteManagedSettings();
    void loadPolicyLimits();
    profileCheckpoint('preAction_after_remote_settings');

    // Load settings sync (non-blocking, fail-open)
    // CLI: uploads local settings to remote (CCR download is handled by print.ts)
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('src/services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
    }
    profileCheckpoint('preAction_after_settings_sync');
  });
  return program;
}
