// Lifecycle helpers extracted from src/platform/main.tsx (ROADMAP 11g Fase 2).
// Pure-ish boot helpers with no closure capture from run() — every dependency
// arrives via parameter or direct import. Side-effect ordering preserved.

import { feature } from 'bun:bundle';
import { profileCheckpoint } from 'src/platform/startupProfiler.js';
import { getSystemContext } from 'src/agent/context.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, isAutoUpdaterDisabled, saveGlobalConfig } from 'src/platform/config/config.js';
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import { migrateAutoUpdatesToSettings } from 'src/platform/migrations/migrateAutoUpdatesToSettings.js';
import { migrateBypassPermissionsAcceptedToSettings } from 'src/platform/migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from 'src/platform/migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateFable5ToFable51 } from 'src/platform/migrations/migrateFable5ToFable51.js';
import { migrateFennecToOpus } from 'src/platform/migrations/migrateFennecToOpus.js';
import { migrateLegacyOpusToCurrent } from 'src/platform/migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from 'src/platform/migrations/migrateOpusToOpus1m.js';
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from 'src/platform/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js';
import { migrateSonnet1mToSonnet45 } from 'src/platform/migrations/migrateSonnet1mToSonnet45.js';
import { migrateSonnet45ToSonnet46 } from 'src/platform/migrations/migrateSonnet45ToSonnet46.js';
import { resetAutoModeOptInForDefaultOffer } from 'src/platform/migrations/resetAutoModeOptInForDefaultOffer.js';
import { resetProToOpusDefault } from 'src/platform/migrations/resetProToOpusDefault.js';
import { migrateChangelogFromConfig } from 'src/platform/install/releaseNotes.js';
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js';
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js';
import { eagerParseCliFlag } from 'src/platform/cliArgs.js';
import { getInitialSettings } from 'src/platform/settings/settings.js';
import { loadSettingSourcesFromFlag, loadSettingsFromFlag } from 'src/platform/main/helpers.js';

// @[MODEL LAUNCH]: Consider any migrations you may need for model strings. See migrateSonnet1mToSonnet45.ts for an example.
// Bump this when adding a new sync migration so existing users re-run the set.
const CURRENT_MIGRATION_VERSION = 13;

export function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    // Before migrateOpusToOpus1m, not after: that one only fires on an exact
    // 'opus', so a user arriving from 'fennec-latest' has to land on 'opus'
    // first to get the same 1M merge every other Opus user gets.
    migrateFennecToOpus();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    // Independent of the Opus/Sonnet chain above: rewrites the retired
    // 'claude-fable-5' pin to 'claude-fable-5-1' wherever it is persisted.
    migrateFable5ToFable51();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : {
            ...prev,
            migrationVersion: CURRENT_MIGRATION_VERSION,
          },
    );
  }
  // Async migration - fire and forget since it's non-blocking
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}

/**
 * Prefetch system context (including git status) only when it's safe to do so.
 * Git commands can execute arbitrary code via hooks and config (e.g., core.fsmonitor,
 * diff.external), so we must only run them after trust is established or in
 * non-interactive mode where trust is implicit.
 */
export function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // In non-interactive mode (--print), trust dialog is skipped and
  // execution is considered trusted (as documented in help text)
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // In interactive mode, only prefetch if trust has already been established
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // Otherwise, don't prefetch - wait for trust to be established first
}

/**
 * Parse and load settings flags early, before init()
 * This ensures settings are filtered from the start of initialization
 */
export function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // Parse --settings flag early to ensure settings are loaded before init()
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // Parse --setting-sources flag early to control which sources are loaded
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}

export function initializeEntrypoint(isNonInteractive: boolean): void {
  // Skip if already set (e.g., by SDK or other entrypoints)
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return;
  }
  const cliArgs = process.argv.slice(2);

  // Check for MCP serve command (handle flags before mcp serve, e.g., --debug mcp serve)
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp';
    return;
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action';
    return;
  }

  // Note: 'local-agent' entrypoint is set by the local agent mode launcher
  // via CLAUDE_CODE_ENTRYPOINT env var (handled by early return above)

  // Set based on interactive status
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}
