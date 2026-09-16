// Action handler — MCP config + permissions + channels (Block B).
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7c.2).
//
// Covers: initialPermissionModeFromCLI, autoModeFlagCli (TRANSCRIPT_CLASSIFIER),
// --mcp-config parsing + policy filtering, enterprise MCP gate,
// --channels / dev-channels parsing, brief-tool opt-in,
// initializeToolPermissionContext + dangerous-permission warnings, mcp config
// promises (claudeai + local), and format validation against sdkUrl / replay /
// includePartialMessages / sessionPersistence.
//
// profileCheckpoint(...) calls remain at the original callsite in main.tsx;
// this helper performs no checkpointing.

import chalk from 'chalk';
import { resolve } from 'path';
import mapValues from 'lodash-es/mapValues.js';
import { feature } from 'bun:bundle';
import { setAdditionalDirectoriesForClaudeMd } from 'src/platform/bootstrap/state.js';
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/mcp/claudeai.js';
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/mcp/config.js';
import type { McpServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js';
import type { ChannelEntry } from 'src/platform/bootstrap/state.js';
import { assertMinVersion } from 'src/platform/install/autoUpdater.js';
import { logForDebugging } from 'src/shared/debug.js';
import { isBareMode } from 'src/shared/envUtils.js';
import { errorMessage } from 'src/shared/errors.js';
import { safeParseJSON } from 'src/shared/data/json.js';
import {
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup.js';
import { getPlatform } from 'src/shared/proc/platform.js';
import { writeToStderr } from 'src/shared/proc/process.js';
import { setSessionBypassPermissionsMode } from 'src/platform/bootstrap/state.js';
import { plural } from 'src/shared/text/stringUtils.js';
import type { ValidationError } from 'src/platform/settings/validation.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { ActionOptions } from 'src/platform/main/action/parseOptions.js';

/**
 * Lazy-require accessor for autoModeState (gated by TRANSCRIPT_CLASSIFIER).
 * Owned by main.tsx; passed in to keep the helper free of conditional
 * top-level requires.
 */
export type AutoModeStateModule = {
  setAutoModeFlagCli: (v: boolean) => void;
} | null;

export type McpAndPermsDeps = {
  autoModeStateModule: AutoModeStateModule;
};

export type McpAndPermsResult = {
  permissionMode: ReturnType<typeof initialPermissionModeFromCLI>['mode'];
  permissionModeNotification: ReturnType<typeof initialPermissionModeFromCLI>['notification'];
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig>;
  strictMcpConfig: boolean;
  devChannels: ChannelEntry[] | undefined;
  toolPermissionContext: Awaited<ReturnType<typeof initializeToolPermissionContext>>['toolPermissionContext'];
  overlyBroadBashPermissions: Awaited<ReturnType<typeof initializeToolPermissionContext>>['overlyBroadBashPermissions'];
  claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>;
  mcpConfigPromise: ReturnType<typeof getClaudeCodeMcpConfigs>;
  /** Ref to the ms duration; populated when mcpConfigPromise resolves. */
  mcpConfigResolvedRef: { current: number | undefined };
};

/**
 * Inputs from main.tsx (post Block A).
 */
export type McpAndPermsInput = {
  options: ActionOptions;
  ctx: BootContext;
  permissionModeCli: string | undefined;
  dangerouslySkipPermissions: boolean | undefined;
  allowDangerouslySkipPermissions: boolean;
  baseTools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpConfig: string[];
  addDir: string[];
  isNonInteractiveSession: boolean;
  inputFormat: string | undefined;
  outputFormat: string | undefined;
};

export async function runMcpAndPerms(
  input: McpAndPermsInput,
  deps: McpAndPermsDeps,
): Promise<McpAndPermsResult> {
  const {
    options,
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
  } = input;
  const { autoModeStateModule } = deps;

  const { mode: permissionMode, notification: permissionModeNotification } = initialPermissionModeFromCLI({
    permissionModeCli,
    dangerouslySkipPermissions,
  });

  // Store session bypass permissions mode for trust dialog check
  setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // autoModeFlagCli is the "did the user intend auto this session" signal.
    if (
      (options as { enableAutoMode?: boolean }).enableAutoMode ||
      permissionModeCli === 'auto' ||
      permissionMode === 'auto' ||
      (!permissionModeCli && isDefaultPermissionModeAuto())
    ) {
      autoModeStateModule?.setAutoModeFlagCli(true);
    }
  }

  // Parse the MCP config files/strings if provided
  let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {};
  if (mcpConfig && mcpConfig.length > 0) {
    const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);
    let allConfigs: Record<string, McpServerConfig> = {};
    const allErrors: ValidationError[] = [];
    for (const configItem of processedConfigs) {
      let configs: Record<string, McpServerConfig> | null = null;
      let errors: ValidationError[] = [];

      // First try to parse as JSON string
      const parsedJson = safeParseJSON(configItem);
      if (parsedJson) {
        const result = parseMcpConfig({
          configObject: parsedJson,
          filePath: 'command line',
          expandVars: true,
          scope: 'dynamic',
        });
        if (result.config) {
          configs = result.config.mcpServers;
        } else {
          errors = result.errors;
        }
      } else {
        // Try as file path
        const configPath = resolve(configItem);
        const result = parseMcpConfigFromFilePath({
          filePath: configPath,
          expandVars: true,
          scope: 'dynamic',
        });
        if (result.config) {
          configs = result.config.mcpServers;
        } else {
          errors = result.errors;
        }
      }
      if (errors.length > 0) {
        allErrors.push(...errors);
      } else if (configs) {
        // Merge configs, later ones override earlier ones
        allConfigs = {
          ...allConfigs,
          ...configs,
        };
      }
    }
    if (allErrors.length > 0) {
      const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
      logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
        level: 'error',
      });
      process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`);
      process.exit(1);
    }
    if (Object.keys(allConfigs).length > 0) {
      const scopedConfigs = mapValues(allConfigs, config => ({
        ...config,
        scope: 'dynamic' as const,
      }));

      const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs);
      if (blocked.length > 0) {
        process.stderr.write(`Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
      }
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...allowed,
      };
    }
  }

  // Extract strict MCP config flag
  const strictMcpConfig = (options as { strictMcpConfig?: boolean }).strictMcpConfig || false;

  // Check if enterprise MCP configuration exists.
  if (doesEnterpriseMcpConfigExist()) {
    if (strictMcpConfig) {
      process.stderr.write(chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'));
      process.exit(1);
    }

    if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
      process.stderr.write(chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'));
      process.exit(1);
    }
  }

  // Store additional directories for CLAUDE.md loading
  setAdditionalDirectoriesForClaudeMd(addDir);

  // Channel server allowlist from --channels flag.
  // --channels / --dangerously-load-development-channels shipped behind the
  // KAIROS/KAIROS_CHANNELS build flags; neither is on here, so the options
  // are never registered and nothing can populate this.
  const devChannels: ChannelEntry[] | undefined = undefined;

  // SDK opt-in for SendUserMessage via --tools.

  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: allowedTools,
    disallowedToolsCli: disallowedTools,
    baseToolsCli: baseTools,
    permissionMode,
    allowDangerouslySkipPermissions,
    addDirs: addDir,
  });
  let toolPermissionContext = initResult.toolPermissionContext;
  const { warnings, dangerousPermissions, overlyBroadBashPermissions } = initResult;

  if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
  }

  // Print any warnings from initialization
  warnings.forEach(warning => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(warning);
  });
  void assertMinVersion();

  // claude.ai config fetch: -p mode only.
  const claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> =
    isNonInteractiveSession && !strictMcpConfig && !doesEnterpriseMcpConfigExist() && !isBareMode()
      ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
          const { allowed, blocked } = filterMcpServersByPolicy(configs);
          if (blocked.length > 0) {
            process.stderr.write(`Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
          }
          return allowed;
        })
      : Promise.resolve({});

  // Kick off MCP config loading early.
  logForDebugging('[STARTUP] Loading MCP configs...');
  const mcpConfigStart = Date.now();
  const mcpConfigResolvedRef: { current: number | undefined } = { current: undefined };
  const mcpConfigPromise = (strictMcpConfig || isBareMode()
    ? Promise.resolve({ servers: {} as Record<string, ScopedMcpServerConfig>, errors: [] })
    : getClaudeCodeMcpConfigs(dynamicMcpConfig)
  ).then(result => {
    mcpConfigResolvedRef.current = Date.now() - mcpConfigStart;
    return result;
  });

  // NOTE: We do NOT call prefetchAllMcpResources here — that's deferred until after trust dialog

  if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: Invalid input format "${inputFormat}".`);
    process.exit(1);
  }
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
    process.exit(1);
  }

  // Validate sdkUrl is only used with appropriate formats.
  if (ctx.sdkUrl) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`);
      process.exit(1);
    }
  }

  // Validate replayUserMessages is only used with stream-json formats.
  if ((options as { replayUserMessages?: boolean }).replayUserMessages) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`);
      process.exit(1);
    }
  }

  // Validate includePartialMessages.
  if (ctx.effectiveIncludePartialMessages) {
    if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
      writeToStderr(`Error: --include-partial-messages requires --print and --output-format=stream-json.`);
      process.exit(1);
    }
  }

  // Validate --no-session-persistence.
  if ((options as { sessionPersistence?: boolean }).sessionPersistence === false && !isNonInteractiveSession) {
    writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
    process.exit(1);
  }

  return {
    permissionMode,
    permissionModeNotification,
    dynamicMcpConfig,
    strictMcpConfig,
    devChannels,
    toolPermissionContext,
    overlyBroadBashPermissions,
    claudeaiConfigPromise,
    mcpConfigPromise,
    mcpConfigResolvedRef,
  };
}
