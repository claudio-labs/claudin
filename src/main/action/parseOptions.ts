// Action handler — options parse + validation (Block A).
// Extracted from src/main.tsx (ROADMAP 11g Fase 7c.1).
//
// Covers: bootContext seed (post-build mutations), bare/code prompt
// handling, KAIROS assistant gate, options destructuring, worktree/tmux
// validation, teammate identity, sdkUrl/file downloads, sessionId
// validation, fallback model validation, system prompt + append prompts.
//
// profileCheckpoint(...) calls remain at the original callsite in main.tsx;
// this helper performs no checkpointing.

import chalk from 'chalk';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { feature } from 'bun:bundle';
import { getOauthConfig } from '../../constants/oauth.js';
import { getSessionId, getIsNonInteractiveSession, setKairosActive } from '../../bootstrap/state.js';
import { downloadSessionFiles, type FilesApiConfig, parseFileSpecs } from '../../services/api/filesApi.js';
import { tryGetActiveProvider } from '../../services/api/activeProvider.js';
import { logEvent } from '../../services/analytics/index.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { checkHasTrustDialogAccepted, getGlobalConfig } from '../../utils/config.js';
import { seedEarlyInput } from '../../utils/earlyInput.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { errorMessage, getErrnoCode } from '../../utils/errors.js';
import { setAllHookEventsEnabled } from '../../utils/hooks/hookEvents.js';
import { getPlatform } from '../../utils/platform.js';
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js';
import { sessionIdExists } from '../../utils/sessionStorage.js';
import { validateUuid } from '../../utils/uuid.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from '../../utils/worktree.js';
import { isWorktreeModeEnabled } from '../../utils/worktreeModeEnabled.js';
import { extractTeammateOptions } from '../helpers.js';
import type { BootContext } from '../bootContext.js';

/** Lazy-require accessors for teammate utils (circular-dep workarounds in main.tsx). */
export type TeammateAccessors = {
  getTeammateUtils: () => typeof import('../../utils/teammate.js');
  getTeammatePromptAddendum: () => typeof import('../../utils/swarm/teammatePromptAddendum.js');
  getTeammateModeSnapshot: () => typeof import('../../utils/swarm/backends/teammateModeSnapshot.js');
};

/**
 * KAIROS assistant module + gate handles (feature-gated).
 * Stubbed in the open build; typed loosely so TS doesn't resolve them.
 */
export type AssistantModule = {
  markAssistantForced: () => void;
  isAssistantMode: () => boolean;
  isAssistantForced: () => boolean;
  initializeAssistantTeam: () => Promise<unknown>;
};
export type KairosGate = {
  isKairosEnabled: () => Promise<boolean>;
};
export type AssistantHandles = {
  assistantModule: AssistantModule | null;
  kairosGate: KairosGate | null;
};

/** Inputs the helper needs from main.tsx. */
export type ParseActionOptionsDeps = {
  teammate: TeammateAccessors;
  assistant: AssistantHandles;
};

/**
 * Subset of Commander-parsed options touched by Block A. We accept a
 * loose object and re-narrow inside the helper to avoid coupling to
 * Commander's inferred shape (which is constructed in src/main.tsx).
 */
export type ActionOptions = {
  bare?: boolean;
  prefill?: string;
  agents?: string;
  agent?: string;
  outputFormat?: string;
  inputFormat?: string;
  verbose?: boolean;
  print?: boolean;
  init?: boolean;
  initOnly?: boolean;
  maintenance?: boolean;
  disableSlashCommands?: boolean;
  worktree?: boolean | string;
  tmux?: boolean;
  sdkUrl?: string;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  file?: string[];
  continue?: boolean;
  resume?: string | boolean | null;
  forkSession?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  teleport?: string | true;
  remote?: string | true;
  remoteControl?: string | true;
  rc?: string | true;
  fallbackModel?: string;
  model?: string;
  assistant?: boolean;
  // Destructured below:
  debug?: boolean;
  debugToStderr?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string[];
  permissionMode?: string;
  addDir?: string[];
  betas?: string[];
  ide?: boolean;
  sessionId?: string;
  [key: string]: unknown;
};

/** Result of parsing/validating Block A. */
export type ParsedActionOptions = {
  prompt: string | undefined;
  // Destructured Commander option fields used downstream:
  debug: boolean;
  debugToStderr: boolean;
  dangerouslySkipPermissions: boolean | undefined;
  allowDangerouslySkipPermissions: boolean;
  baseTools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpConfig: string[];
  permissionModeCli: string | undefined;
  addDir: string[];
  fallbackModel: string | undefined;
  betas: string[];
  ide: boolean;
  sessionId: string | undefined;
  includeHookEvents: boolean | undefined;
  includePartialMessages: boolean | undefined;
  // Modal flags + formats:
  outputFormat: string | undefined;
  inputFormat: string | undefined;
  verbose: boolean;
  print: boolean | undefined;
  init: boolean;
  initOnly: boolean;
  maintenance: boolean;
  // Captured options/refs needed later:
  agentsJson: string | undefined;
  agentCli: string | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  teleport: string | true | null;
  remote: string | null;
  remoteControlOption: string | true | undefined;
  remoteControlName: string | undefined;
  isNonInteractiveSession: boolean;
};

/**
 * Block A — parse + validate the action options.
 *
 * Mutates the supplied `ctx` (BootContext) in place. Returns the locals
 * needed by Blocks B/C/D/E. Calls `process.exit(...)` on validation
 * failure (preserved from the original inline behavior).
 */
export async function parseActionOptions(
  promptArg: string | undefined,
  options: ActionOptions,
  ctx: BootContext,
  deps: ParseActionOptionsDeps,
): Promise<ParsedActionOptions> {
  const { teammate, assistant } = deps;
  let prompt = promptArg;

  // --bare = one-switch minimal mode. Sets SIMPLE so all the existing
  // gates fire (CLAUDE.md, skills, hooks inside executeHooks, agent
  // dir-walk). Must be set before setup() / any of the gated work runs.
  if (options.bare) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // Ignore "code" as a prompt - treat it the same as no prompt
  if (prompt === 'code') {
    logEvent('tengu_code_prompt_ignored', {});
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.warn(chalk.yellow('Tip: You can launch Claude Code with just `claude`'));
    prompt = undefined;
  }

  // Log event for any single-word prompt
  if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
    logEvent('tengu_single_word_prompt', {
      length: prompt.length,
    });
  }

  // Assistant mode: when .claudin/settings.json has assistant: true AND
  // the tengu_kairos GrowthBook gate is on, force brief on. Permission
  // mode is left to the user — settings defaultMode or --permission-mode
  // apply as normal. REPL-typed messages already default to 'next'
  // priority (messageQueueManager.enqueue) so they drain mid-turn between
  // tool calls. SendUserMessage (BriefTool) is enabled via the brief env
  // var. SleepTool stays disabled (its isEnabled() gates on proactive).
  // kairosEnabled is computed once here and reused at the
  // getAssistantSystemPromptAddendum() call site further down.
  //
  // Trust gate: .claudin/settings.json is attacker-controllable in an
  // untrusted clone. We run ~1000 lines before showSetupScreens() shows
  // the trust dialog, and by then we've already appended
  // .claudin/agents/assistant.md to the system prompt. Refuse to activate
  // until the directory has been explicitly trusted.
  if (feature('KAIROS') && options.assistant && assistant.assistantModule) {
    assistant.assistantModule.markAssistantForced();
  }
  if (
    feature('KAIROS') &&
    assistant.assistantModule?.isAssistantMode() &&
    !(options as { agentId?: unknown }).agentId &&
    assistant.kairosGate
  ) {
    if (!checkHasTrustDialogAccepted()) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(chalk.yellow('Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.'));
    } else {
      ctx.kairosEnabled = assistant.assistantModule.isAssistantForced() || (await assistant.kairosGate.isKairosEnabled());
      if (ctx.kairosEnabled) {
        (options as { brief?: boolean }).brief = true;
        setKairosActive(true);
        ctx.assistantTeamContext = await assistant.assistantModule.initializeAssistantTeam();
      }
    }
  }

  const {
    debug = false,
    debugToStderr = false,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions = false,
    tools: baseTools = [],
    allowedTools = [],
    disallowedTools = [],
    mcpConfig = [],
    permissionMode: permissionModeCli,
    addDir = [],
    fallbackModel,
    betas = [],
    ide = false,
    sessionId,
    includeHookEvents,
    includePartialMessages,
  } = options;

  if (options.prefill) {
    seedEarlyInput(options.prefill);
  }

  const agentsJson = options.agents;
  const agentCli = options.agent;
  if (feature('BG_SESSIONS') && agentCli) {
    process.env.CLAUDE_CODE_AGENT = agentCli;
  }

  let outputFormat = options.outputFormat;
  let inputFormat = options.inputFormat;
  let verbose: boolean | undefined = options.verbose ?? getGlobalConfig().verbose;
  let print = options.print;
  const init = options.init ?? false;
  const initOnly = options.initOnly ?? false;
  const maintenance = options.maintenance ?? false;

  ctx.disableSlashCommands = options.disableSlashCommands || false;
  ctx.taskListId = undefined;

  ctx.worktreeOption = isWorktreeModeEnabled() ? options.worktree : undefined;
  ctx.worktreeName = typeof ctx.worktreeOption === 'string' ? ctx.worktreeOption : undefined;
  ctx.worktreeEnabled = ctx.worktreeOption !== undefined;

  if (ctx.worktreeName) {
    const prNum = parsePRReference(ctx.worktreeName);
    if (prNum !== null) {
      ctx.worktreePRNumber = prNum;
      ctx.worktreeName = undefined;
    }
  }

  ctx.tmuxEnabled = isWorktreeModeEnabled() && options.tmux === true;

  if (ctx.tmuxEnabled) {
    if (!ctx.worktreeEnabled) {
      process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'));
      process.exit(1);
    }
    if (getPlatform() === 'windows') {
      process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'));
      process.exit(1);
    }
    if (!(await isTmuxAvailable())) {
      process.stderr.write(chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`));
      process.exit(1);
    }
  }

  if (isAgentSwarmsEnabled()) {
    const teammateOpts = extractTeammateOptions(options);
    ctx.storedTeammateOpts = teammateOpts;

    const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
    const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;
    if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
      process.stderr.write(chalk.red('Error: --agent-id, --agent-name, and --team-name must all be provided together\n'));
      process.exit(1);
    }

    if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
      teammate.getTeammateUtils().setDynamicTeamContext?.({
        agentId: teammateOpts.agentId,
        agentName: teammateOpts.agentName,
        teamName: teammateOpts.teamName,
        color: teammateOpts.agentColor,
        planModeRequired: teammateOpts.planModeRequired ?? false,
        parentSessionId: teammateOpts.parentSessionId,
      });
    }

    if (teammateOpts.teammateMode) {
      teammate.getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
    }
  }

  ctx.sdkUrl = options.sdkUrl ?? undefined;
  ctx.effectiveIncludePartialMessages = !!includePartialMessages || isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES);

  if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    setAllHookEventsEnabled(true);
  }

  if (ctx.sdkUrl) {
    if (!inputFormat) inputFormat = 'stream-json';
    if (!outputFormat) outputFormat = 'stream-json';
    if (options.verbose === undefined) verbose = true;
    if (!options.print) print = true;
  }

  const teleport = options.teleport ?? null;

  const remoteOption = options.remote;
  const remote = remoteOption === true ? '' : (remoteOption ?? null);

  const remoteControlOption = options.remoteControl ?? options.rc;
  const remoteControlName = typeof remoteControlOption === 'string' && remoteControlOption.length > 0 ? remoteControlOption : undefined;

  if (sessionId) {
    if ((options.continue || options.resume) && !options.forkSession) {
      process.stderr.write(chalk.red('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n'));
      process.exit(1);
    }

    if (!ctx.sdkUrl) {
      const validatedSessionId = validateUuid(sessionId);
      if (!validatedSessionId) {
        process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'));
        process.exit(1);
      }

      if (sessionIdExists(validatedSessionId)) {
        process.stderr.write(chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`));
        process.exit(1);
      }
    }
  }

  ctx.fileSpecs = options.file;
  if (ctx.fileSpecs && ctx.fileSpecs.length > 0) {
    const sessionToken = getSessionIngressAuthToken();
    if (!sessionToken) {
      process.stderr.write(chalk.red('Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n'));
      process.exit(1);
    }

    const fileSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId();
    const files = parseFileSpecs(ctx.fileSpecs);
    if (files.length > 0) {
      const anthropicProfileBase =
        tryGetActiveProvider()?.transport === 'anthropic'
          ? tryGetActiveProvider()?.baseUrl
          : undefined;
      const config: FilesApiConfig = {
        baseUrl: anthropicProfileBase || getOauthConfig().BASE_API_URL,
        oauthToken: sessionToken,
        sessionId: fileSessionId,
      };

      ctx.fileDownloadPromise = downloadSessionFiles(files, config);
    }
  }

  const isNonInteractiveSession = getIsNonInteractiveSession();

  if (fallbackModel && options.model && fallbackModel === options.model) {
    process.stderr.write(chalk.red('Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n'));
    process.exit(1);
  }

  let systemPrompt = options.systemPrompt;
  if (options.systemPromptFile) {
    if (options.systemPrompt) {
      process.stderr.write(chalk.red('Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n'));
      process.exit(1);
    }
    try {
      const filePath = resolve(options.systemPromptFile);
      systemPrompt = readFileSync(filePath, 'utf8');
    } catch (error) {
      const code = getErrnoCode(error);
      if (code === 'ENOENT') {
        process.stderr.write(chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`));
        process.exit(1);
      }
      process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`));
      process.exit(1);
    }
  }

  let appendSystemPrompt = options.appendSystemPrompt;
  if (options.appendSystemPromptFile) {
    if (options.appendSystemPrompt) {
      process.stderr.write(chalk.red('Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n'));
      process.exit(1);
    }
    try {
      const filePath = resolve(options.appendSystemPromptFile);
      appendSystemPrompt = readFileSync(filePath, 'utf8');
    } catch (error) {
      const code = getErrnoCode(error);
      if (code === 'ENOENT') {
        process.stderr.write(chalk.red(`Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`));
        process.exit(1);
      }
      process.stderr.write(chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`));
      process.exit(1);
    }
  }

  if (
    isAgentSwarmsEnabled() &&
    ctx.storedTeammateOpts?.agentId &&
    ctx.storedTeammateOpts?.agentName &&
    ctx.storedTeammateOpts?.teamName
  ) {
    const addendum = teammate.getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
    appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
  }

  return {
    prompt,
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
    includePartialMessages,
    outputFormat,
    inputFormat,
    verbose,
    print,
    init,
    initOnly,
    maintenance,
    agentsJson,
    agentCli,
    systemPrompt,
    appendSystemPrompt,
    teleport,
    remote,
    remoteControlOption,
    remoteControlName,
    isNonInteractiveSession,
  };
}
