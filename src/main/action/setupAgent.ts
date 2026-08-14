// Action handler — setup() + post-setup + agent definition resolution
// (Blocks C + D). Extracted from src/main.tsx (ROADMAP 11g Fase 7c.3).
//
// Three exported helpers, called sequentially from main.tsx with
// profileCheckpoint(...) interleaved at the original sites:
//
//   profileCheckpoint('action_before_setup')
//   const setupRes = await runActionSetup(...)
//   profileCheckpoint('action_after_setup')
//   const postSetup = await runActionPostSetup(...)
//   profileCheckpoint('action_commands_loaded')
//   const agentSetup = await runActionAgentSetup(...)
//
// Each helper performs no checkpointing.

import { feature } from 'bun:bundle';
import chalk from 'chalk';
import { getInitialMainLoopModel, setInitialMainLoopModel, setMainLoopModelOverride, setMainThreadAgentType, setUserMsgOptIn } from 'src/bootstrap/state.js';
import { getCommands } from 'src/commands.js';
import { getSystemContext, getUserContext } from 'src/context.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, parseAgentsFromJson } from 'src/tools/AgentTool/loadAgentsDir.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from 'src/utils/advisor.js';
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging } from 'src/utils/debug.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { safeParseJSON } from 'src/utils/json.js';
import { logError } from 'src/utils/log.js';
import { applyConfigEnvironmentVariables } from 'src/utils/managedEnv.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from 'src/utils/model/model.js';
import { ensureModelStringsInitialized } from 'src/utils/model/modelStrings.js';
import { getIsNonInteractiveSession, getUserMsgOptIn } from 'src/bootstrap/state.js';
import { cacheSessionTitle, saveAgentSetting } from 'src/utils/sessionStorage.js';
import { getInitialSettings } from 'src/utils/settings/settings.js';
import { validateUuid } from 'src/utils/uuid.js';
import { initBuiltinPlugins } from 'src/plugins/bundled/index.js';
import { initBundledSkills } from 'src/skills/bundled/index.js';
import { maybeActivateBrief } from 'src/main/lifecycle.js';
import type { InternalPermissionMode } from 'src/types/permissions.js';
import type { BootContext } from 'src/main/bootContext.js';
import type { ActionOptions } from './parseOptions.js';

/**
 * Lazy-require accessor for coordinatorMode (gated by COORDINATOR_MODE).
 * Owned by main.tsx; passed in to avoid double-evaluating the conditional.
 */
export type CoordinatorModeModule = {
  isCoordinatorMode: () => boolean;
} | null;

/** KAIROS assistant module handle (re-used from parseOptions). */
export type AssistantModule = {
  getAssistantSystemPromptAddendum: () => string;
} | null;

// =============================================================================
// runActionSetup — Block C: setup() + commands/agents kickoff
// =============================================================================

export type RunActionSetupInput = {
  options: ActionOptions;
  ctx: BootContext;
  permissionMode: InternalPermissionMode;
  allowDangerouslySkipPermissions: boolean;
  sessionId: string | undefined;
};

export type RunActionSetupResult = {
  preSetupCwd: string;
  // Promises for commands/agents loading (may be null when worktree is enabled).
  commandsPromise: ReturnType<typeof getCommands> | null;
  agentDefsPromise: ReturnType<typeof getAgentDefinitionsWithOverrides> | null;
};

export async function runActionSetup(input: RunActionSetupInput): Promise<RunActionSetupResult> {
  const { options, ctx, permissionMode, allowDangerouslySkipPermissions, sessionId } = input;
  logForDebugging('[STARTUP] Running setup()...');
  const setupStart = Date.now();
  const { setup } = await import('src/setup.js');
  const messagingSocketPath = feature('UDS_INBOX') ? (options as { messagingSocketPath?: string }).messagingSocketPath : undefined;
  const preSetupCwd = getCwd();
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
    initBuiltinPlugins();
    initBundledSkills();
  }
  const setupPromise = setup(
    preSetupCwd,
    permissionMode,
    allowDangerouslySkipPermissions,
    ctx.worktreeEnabled,
    ctx.worktreeName,
    ctx.tmuxEnabled,
    sessionId ? validateUuid(sessionId) : undefined,
    ctx.worktreePRNumber,
    messagingSocketPath,
  );
  const commandsPromise = ctx.worktreeEnabled ? null : getCommands(preSetupCwd);
  const agentDefsPromise = ctx.worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
  // Suppress transient unhandledRejection if these reject during the ~28ms
  // setupPromise await before Promise.all joins them below.
  commandsPromise?.catch(() => {});
  agentDefsPromise?.catch(() => {});
  await setupPromise;
  logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
  return { preSetupCwd, commandsPromise, agentDefsPromise };
}

// =============================================================================
// runActionPostSetup — Block D-pre-commands: replayUserMessages, prefetches,
// sessionName, model, commands/agents Promise.all
// =============================================================================

export type RunActionPostSetupInput = {
  options: ActionOptions;
  ctx: BootContext;
  outputFormat: string | undefined;
  fallbackModel: string | undefined;
  preSetupCwd: string;
  commandsPromise: ReturnType<typeof getCommands> | null;
  agentDefsPromise: ReturnType<typeof getAgentDefinitionsWithOverrides> | null;
};

export type RunActionPostSetupResult = {
  effectiveReplayUserMessages: boolean;
  sessionNameArg: string | undefined;
  userSpecifiedModel: string | undefined;
  userSpecifiedFallbackModel: string | undefined;
  currentCwd: string;
  commands: Awaited<ReturnType<typeof getCommands>>;
  agentDefinitionsResult: Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>;
};

export async function runActionPostSetup(input: RunActionPostSetupInput): Promise<RunActionPostSetupResult> {
  const { options, ctx, outputFormat, fallbackModel, preSetupCwd, commandsPromise, agentDefsPromise } = input;

  // Replay user messages into stream-json only when the socket was
  // explicitly requested.
  let effectiveReplayUserMessages = !!(options as { replayUserMessages?: boolean }).replayUserMessages;
  if (feature('UDS_INBOX')) {
    if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
      effectiveReplayUserMessages = !!(options as { messagingSocketPath?: string }).messagingSocketPath;
    }
  }

  if (getIsNonInteractiveSession()) {
    applyConfigEnvironmentVariables();
    void getSystemContext();
    void getUserContext();
    void ensureModelStringsInitialized();
  }

  // Apply --name: cache-only.
  const sessionNameArg = (options as { name?: string }).name?.trim();
  if (sessionNameArg) {
    cacheSessionTitle(sessionNameArg);
  }

  // Special case the default model with the null keyword.
  const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
  const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

  // Reuse preSetupCwd unless setup() chdir'd (worktreeEnabled).
  const currentCwd = ctx.worktreeEnabled ? getCwd() : preSetupCwd;
  logForDebugging('[STARTUP] Loading commands and agents...');
  const commandsStart = Date.now();
  const [commands, agentDefinitionsResult] = await Promise.all([
    commandsPromise ?? getCommands(currentCwd),
    agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
  ]);
  logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);

  return {
    effectiveReplayUserMessages,
    sessionNameArg,
    userSpecifiedModel,
    userSpecifiedFallbackModel,
    currentCwd,
    commands,
    agentDefinitionsResult,
  };
}

// =============================================================================
// runActionAgentSetup — Block D-post-commands: agent def + system prompts +
// model + advisor + teammate custom + brief/proactive/assistant addendum
// =============================================================================

export type RunActionAgentSetupInput = {
  options: ActionOptions;
  ctx: BootContext;
  isNonInteractiveSession: boolean;
  agentCli: string | undefined;
  agentsJson: string | undefined;
  userSpecifiedModel: string | undefined;
  agentDefinitionsResult: Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
};

export type AgentDefinitionsBundle = {
  allAgents: Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>['allAgents'];
  activeAgents: Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>['activeAgents'];
} & Awaited<ReturnType<typeof getAgentDefinitionsWithOverrides>>;

export type RunActionAgentSetupResult = {
  agentDefinitions: AgentDefinitionsBundle;
  mainThreadAgentDefinition: AgentDefinitionsBundle['activeAgents'][number] | undefined;
  cliAgents: AgentDefinitionsBundle['activeAgents'];
  agentSetting: string | undefined;
  effectiveModel: string | undefined;
  initialMainLoopModel: string | null;
  resolvedInitialModel: string;
  advisorModel: string | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  inputPrompt: string | AsyncIterable<string>;
};

export type RunActionAgentSetupDeps = {
  coordinatorModeModule: CoordinatorModeModule;
  assistantModule: AssistantModule;
};

export async function runActionAgentSetup(
  input: RunActionAgentSetupInput,
  deps: RunActionAgentSetupDeps,
): Promise<RunActionAgentSetupResult> {
  const {
    options, ctx, isNonInteractiveSession, agentCli, agentsJson,
    userSpecifiedModel, agentDefinitionsResult,
  } = input;
  let { systemPrompt, appendSystemPrompt, inputPrompt } = input;
  const { coordinatorModeModule, assistantModule } = deps;

  // Parse CLI agents if provided via --agents flag.
  let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
  if (agentsJson) {
    try {
      const parsedAgents = safeParseJSON(agentsJson);
      if (parsedAgents) {
        cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
      }
    } catch (error) {
      logError(error);
    }
  }

  // Merge CLI agents with existing ones.
  const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
  const agentDefinitions = {
    ...agentDefinitionsResult,
    allAgents,
    activeAgents: getActiveAgentsFromList(allAgents),
  };

  // Look up main thread agent from CLI flag or settings.
  const agentSetting = agentCli ?? getInitialSettings().agent;
  let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
  if (agentSetting) {
    mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
    if (!mainThreadAgentDefinition) {
      logForDebugging(`Warning: agent "${agentSetting}" not found. ` + `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` + `Using default behavior.`);
    }
  }

  setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

  if (mainThreadAgentDefinition) {
    logEvent('tengu_agent_flag', {
      agentType: isBuiltInAgent(mainThreadAgentDefinition) ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
      ...(agentCli && {
        source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    });
  }

  if (mainThreadAgentDefinition?.agentType) {
    saveAgentSetting(mainThreadAgentDefinition.agentType);
  }

  // Apply the agent's system prompt for non-interactive sessions.
  if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt && !isBuiltInAgent(mainThreadAgentDefinition)) {
    const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
    if (agentSystemPrompt) {
      systemPrompt = agentSystemPrompt;
    }
  }

  // initialPrompt goes first so its slash command (if any) is processed.
  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof inputPrompt === 'string') {
      inputPrompt = inputPrompt ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}` : mainThreadAgentDefinition.initialPrompt;
    } else if (!inputPrompt) {
      inputPrompt = mainThreadAgentDefinition.initialPrompt;
    }
  }

  // Compute effective model early so hooks can run in parallel with MCP.
  let effectiveModel = userSpecifiedModel;
  if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
    effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
  }
  setMainLoopModelOverride(effectiveModel);

  // Compute resolved model for hooks (use user-specified model at launch).
  setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
  const initialMainLoopModel = getInitialMainLoopModel();
  const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());
  let advisorModel: string | undefined;
  if (isAdvisorEnabled()) {
    const advisorOption = canUserConfigureAdvisor() ? (options as { advisor?: string }).advisor : undefined;
    if (advisorOption) {
      logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
      if (!modelSupportsAdvisor(resolvedInitialModel)) {
        process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`));
        process.exit(1);
      }
      const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
      if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
        process.exit(1);
      }
    }
    advisorModel = canUserConfigureAdvisor() ? (advisorOption ?? getInitialAdvisorSetting()) : advisorOption;
    if (advisorModel) {
      logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
    }
  }

  // For tmux teammates with --agent-type, append the custom agent's prompt.
  if (
    isAgentSwarmsEnabled() &&
    ctx.storedTeammateOpts?.agentId &&
    ctx.storedTeammateOpts?.agentName &&
    ctx.storedTeammateOpts?.teamName &&
    ctx.storedTeammateOpts?.agentType
  ) {
    const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === ctx.storedTeammateOpts?.agentType);
    if (customAgent) {
      let customPrompt: string | undefined;
      if (customAgent.source === 'built-in') {
        logForDebugging(`[teammate] Built-in agent ${ctx.storedTeammateOpts.agentType} - skipping custom prompt (not supported)`);
      } else {
        customPrompt = customAgent.getSystemPrompt();
      }

      if (customAgent.memory) {
        logEvent('tengu_agent_memory_loaded', {
          scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }
      if (customPrompt) {
        const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
      }
    } else {
      logForDebugging(`[teammate] Custom agent ${ctx.storedTeammateOpts.agentType} not found in available agents`);
    }
  }

  maybeActivateBrief(options);
  // defaultView: 'chat' is a persisted opt-in.
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && !getIsNonInteractiveSession() && !getUserMsgOptIn() && getInitialSettings().defaultView === 'chat') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isBriefEntitled } = require('src/tools/BriefTool/BriefTool.js') as typeof import('src/tools/BriefTool/BriefTool.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isBriefEntitled()) {
      setUserMsgOptIn(true);
    }
  }
  // Coordinator mode has its own system prompt.
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((options as { proactive?: boolean }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) &&
    !coordinatorModeModule?.isCoordinatorMode()
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const briefVisibility = feature('KAIROS') || feature('KAIROS_BRIEF')
      ? (require('src/tools/BriefTool/BriefTool.js') as typeof import('src/tools/BriefTool/BriefTool.js')).isBriefEnabled()
        ? 'Call SendUserMessage at checkpoints to mark where things stand.'
        : 'The user will see any text you output.'
      : 'The user will see any text you output.';
    /* eslint-enable @typescript-eslint/no-require-imports */
    const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`;
    appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
  }
  if (feature('KAIROS') && ctx.kairosEnabled && assistantModule) {
    const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum();
    appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${assistantAddendum}` : assistantAddendum;
  }

  return {
    agentDefinitions,
    mainThreadAgentDefinition,
    cliAgents,
    agentSetting,
    effectiveModel,
    initialMainLoopModel,
    resolvedInitialModel,
    advisorModel,
    systemPrompt,
    appendSystemPrompt,
    inputPrompt,
  };
}
