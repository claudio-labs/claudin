// Action handler — setup() + post-setup + agent definition resolution
// (Blocks C + D). Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7c.3).
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

import chalk from 'chalk';
import { getInitialMainLoopModel, setInitialMainLoopModel, setMainLoopModelOverride, setMainThreadAgentType } from 'src/platform/bootstrap/state.js';
import { getCommands } from 'src/commands/commands.js';
import { getSystemContext, getUserContext } from 'src/agent/context.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, parseAgentsFromJson } from 'src/tools/AgentTool/loadAgentsDir.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from 'src/platform/doctor/advisor.js';
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js';
import { getCwd } from 'src/shared/fs/cwd.js';
import { logForDebugging } from 'src/shared/debug.js';
import { safeParseJSON } from 'src/shared/data/json.js';
import { logError } from 'src/shared/log.js';
import { applyConfigEnvironmentVariables } from 'src/platform/config/managedEnv.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from 'src/providers/model/model.js';
import { ensureModelStringsInitialized } from 'src/providers/model/modelStrings.js';
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js';
import { cacheSessionTitle, saveAgentSetting } from 'src/sessions/sessionStorage.js';
import { getInitialSettings } from 'src/platform/settings/settings.js';
import { validateUuid } from 'src/shared/data/uuid.js';
import { initBuiltinPlugins } from 'src/plugins/bundled/index.js';
import { initBundledSkills } from 'src/skills/bundled/index.js';
import type { InternalPermissionMode } from 'src/shared/types/permissions.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { ActionOptions } from 'src/platform/main/action/parseOptions.js';

/**
 * Lazy-require accessor for coordinatorMode (gated by COORDINATOR_MODE).
 * Owned by main.tsx; passed in to avoid double-evaluating the conditional.
 */
export type CoordinatorModeModule = {
  isCoordinatorMode: () => boolean;
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
  const { ctx, permissionMode, allowDangerouslySkipPermissions, sessionId } = input;
  logForDebugging('[STARTUP] Running setup()...');
  const setupStart = Date.now();
  const { setup } = await import('src/platform/setup.js');
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
  const { options, ctx, fallbackModel, preSetupCwd, commandsPromise, agentDefsPromise } = input;

  const effectiveReplayUserMessages = !!(options as { replayUserMessages?: boolean }).replayUserMessages;

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
  void deps;

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

      if (customPrompt) {
        const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
      }
    } else {
      logForDebugging(`[teammate] Custom agent ${ctx.storedTeammateOpts.agentType} not found in available agents`);
    }
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
