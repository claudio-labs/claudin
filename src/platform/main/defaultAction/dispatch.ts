// Default-action dispatch — sessionConfig/resumeContext construction +
// dispatch to {continue, direct-connect, ssh, assistant-chat, resume}
// branches (Block I). Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7c.6).
//
// The REPL branch (else clause) stays inline in main.tsx because the
// profileCheckpoint('action_after_hooks') call lives at the top of that
// branch and must remain at the original callsite. This helper returns
// `{ handled: false }` for the REPL case; main.tsx falls through to the
// inline REPL launcher.

import { feature } from 'bun:bundle';
import { runContinueBranch } from 'src/platform/main/defaultAction/continue.js';
import { runDirectConnectBranch } from 'src/platform/main/defaultAction/directConnect.js';
import { runSshRemoteBranch } from 'src/platform/main/defaultAction/sshRemote.js';
import { runAssistantChatBranch } from 'src/platform/main/defaultAction/assistantChat.js';
import { runResumeBranch } from 'src/platform/main/defaultAction/resume.js';
import type { Root } from 'src/terminal/ink.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';
import type { ThinkingConfig } from 'src/services/context/thinking.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { ActionOptions } from 'src/platform/main/action/parseOptions.js';

export type SessionConfig = {
  debug: boolean | undefined;
  commands: unknown[];
  initialTools: unknown[];
  mcpClients: unknown[];
  autoConnectIdeFlag: boolean | undefined;
  mainThreadAgentDefinition: unknown;
  disableSlashCommands: boolean;
  dynamicMcpConfig: Record<string, unknown>;
  strictMcpConfig: boolean | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  taskListId: string | undefined;
  thinkingConfig: ThinkingConfig;
};

export type ResumeContext = {
  modeApi: unknown;
  mainThreadAgentDefinition: unknown;
  agentDefinitions: unknown;
  currentCwd: string;
  cliAgents: unknown[];
  initialState: unknown;
};

export type BuildSessionAndResumeContextInput = {
  ctx: BootContext;
  debug: boolean | undefined;
  debugToStderr: boolean | undefined;
  commands: unknown[];
  initialTools: unknown[];
  mcpClients: unknown[];
  mcpCommands: unknown[];
  ide: boolean | undefined;
  mainThreadAgentDefinition: unknown;
  dynamicMcpConfig: Record<string, unknown>;
  strictMcpConfig: boolean | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  thinkingConfig: ThinkingConfig;
  coordinatorModeModule: unknown;
  agentDefinitions: unknown;
  currentCwd: string;
  cliAgents: unknown[];
  initialState: unknown;
};

export function buildSessionAndResumeContext(
  input: BuildSessionAndResumeContextInput,
): { sessionConfig: SessionConfig; resumeContext: ResumeContext } {
  const sessionConfig: SessionConfig = {
    debug: input.debug || input.debugToStderr,
    commands: [...input.commands, ...input.mcpCommands],
    initialTools: input.initialTools,
    mcpClients: input.mcpClients,
    autoConnectIdeFlag: input.ide,
    mainThreadAgentDefinition: input.mainThreadAgentDefinition,
    disableSlashCommands: input.ctx.disableSlashCommands,
    dynamicMcpConfig: input.dynamicMcpConfig,
    strictMcpConfig: input.strictMcpConfig,
    systemPrompt: input.systemPrompt,
    appendSystemPrompt: input.appendSystemPrompt,
    taskListId: input.ctx.taskListId,
    thinkingConfig: input.thinkingConfig,
  };
  const resumeContext: ResumeContext = {
    modeApi: input.coordinatorModeModule,
    mainThreadAgentDefinition: input.mainThreadAgentDefinition,
    agentDefinitions: input.agentDefinitions,
    currentCwd: input.currentCwd,
    cliAgents: input.cliAgents,
    initialState: input.initialState,
  };
  return { sessionConfig, resumeContext };
}

export type RunDefaultActionDispatchInput = {
  root: Root;
  ctx: BootContext;
  options: ActionOptions;
  debug: boolean | undefined;
  debugToStderr: boolean | undefined;
  commands: unknown[];
  initialTools: unknown[];
  mcpClients: unknown[];
  mcpCommands: unknown[];
  ide: boolean | undefined;
  teleport: string | true | undefined | null;
  remote: string | true | undefined | null;
  thinkingConfig: ThinkingConfig;
  dynamicMcpConfig: Record<string, unknown>;
  strictMcpConfig: boolean | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  coordinatorModeModule: unknown;
  agentDefinitions: unknown;
  currentCwd: string;
  cliAgents: unknown[];
  initialState: unknown;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
  mainThreadAgentDefinition: unknown;
};

export type RunDefaultActionDispatchResult =
  | { handled: true; mainThreadAgentDefinition: unknown; sessionConfig: SessionConfig }
  | { handled: false; mainThreadAgentDefinition: unknown; sessionConfig: SessionConfig };

/**
 * Dispatch into 4 specialized branches (continue / direct-connect / ssh /
 * assistant-chat / resume). Returns:
 *   - `handled: true` when one of those branches executed (caller should
 *     NOT run the REPL).
 *   - `handled: false` when the call falls through to the REPL — caller
 *     must run the inline REPL block (with `action_after_hooks` checkpoint).
 *
 * For continue/resume the helper threads the (possibly mutated)
 * `mainThreadAgentDefinition` back to the caller.
 */
export async function runDefaultActionDispatch(
  input: RunDefaultActionDispatchInput,
): Promise<RunDefaultActionDispatchResult> {
  const {
    root,
    ctx,
    options,
    debug,
    debugToStderr,
    commands,
    ide,
    teleport,
    remote,
    thinkingConfig,
    initialState,
    getFpsMetrics,
    stats,
  } = input;
  let mainThreadAgentDefinition = input.mainThreadAgentDefinition;
  const { sessionConfig, resumeContext } = buildSessionAndResumeContext({
    ctx,
    debug,
    debugToStderr,
    commands,
    initialTools: input.initialTools,
    mcpClients: input.mcpClients,
    mcpCommands: input.mcpCommands,
    ide,
    mainThreadAgentDefinition,
    dynamicMcpConfig: input.dynamicMcpConfig,
    strictMcpConfig: input.strictMcpConfig,
    systemPrompt: input.systemPrompt,
    appendSystemPrompt: input.appendSystemPrompt,
    thinkingConfig,
    coordinatorModeModule: input.coordinatorModeModule,
    agentDefinitions: input.agentDefinitions,
    currentCwd: input.currentCwd,
    cliAgents: input.cliAgents,
    initialState,
  });

  if (options.continue) {
    const agentRef = { current: mainThreadAgentDefinition };
    await runContinueBranch({
      root,
      options: options as Parameters<typeof runContinueBranch>[0]['options'],
      sessionConfig: sessionConfig as Parameters<typeof runContinueBranch>[0]['sessionConfig'],
      resumeContext: resumeContext as Parameters<typeof runContinueBranch>[0]['resumeContext'],
      mainThreadAgentDefinitionRef: agentRef,
      getFpsMetrics,
      stats,
    });
    mainThreadAgentDefinition = agentRef.current;
    return { handled: true, mainThreadAgentDefinition, sessionConfig };
  }
  const debugBool = debug as boolean;
  const debugToStderrBool = debugToStderr as boolean;
  if (feature('DIRECT_CONNECT') && ctx.pending.connect?.url) {
    await runDirectConnectBranch({
      root,
      ctx,
      debug: debugBool,
      debugToStderr: debugToStderrBool,
      commands: commands as Parameters<typeof runDirectConnectBranch>[0]['commands'],
      ide,
      mainThreadAgentDefinition: mainThreadAgentDefinition as Parameters<typeof runDirectConnectBranch>[0]['mainThreadAgentDefinition'],
      thinkingConfig,
      getFpsMetrics,
      stats,
      initialState: initialState as Parameters<typeof runDirectConnectBranch>[0]['initialState'],
    });
    return { handled: true, mainThreadAgentDefinition, sessionConfig };
  }
  if (feature('SSH_REMOTE') && ctx.pending.ssh?.host) {
    await runSshRemoteBranch({
      root,
      ctx,
      debug: debugBool,
      debugToStderr: debugToStderrBool,
      commands: commands as Parameters<typeof runSshRemoteBranch>[0]['commands'],
      ide,
      mainThreadAgentDefinition: mainThreadAgentDefinition as Parameters<typeof runSshRemoteBranch>[0]['mainThreadAgentDefinition'],
      thinkingConfig,
      getFpsMetrics,
      stats,
      initialState: initialState as Parameters<typeof runSshRemoteBranch>[0]['initialState'],
    });
    return { handled: true, mainThreadAgentDefinition, sessionConfig };
  }
  if (feature('KAIROS') && ctx.pending.assistantChat && (ctx.pending.assistantChat.sessionId || ctx.pending.assistantChat.discover)) {
    await runAssistantChatBranch({
      root,
      ctx,
      debug: debugBool,
      debugToStderr: debugToStderrBool,
      commands: commands as Parameters<typeof runAssistantChatBranch>[0]['commands'],
      ide,
      mainThreadAgentDefinition: mainThreadAgentDefinition as Parameters<typeof runAssistantChatBranch>[0]['mainThreadAgentDefinition'],
      thinkingConfig,
      getFpsMetrics,
      stats,
      initialState: initialState as Parameters<typeof runAssistantChatBranch>[0]['initialState'],
    });
    return { handled: true, mainThreadAgentDefinition, sessionConfig };
  }
  if (options.resume || options.fromPr || teleport || remote !== null) {
    const agentRef = { current: mainThreadAgentDefinition };
    await runResumeBranch({
      root,
      ctx,
      options: options as Parameters<typeof runResumeBranch>[0]['options'],
      teleport: teleport as Parameters<typeof runResumeBranch>[0]['teleport'],
      remote: remote as Parameters<typeof runResumeBranch>[0]['remote'],
      debug: debugBool,
      debugToStderr: debugToStderrBool,
      commands: commands as Parameters<typeof runResumeBranch>[0]['commands'],
      ide,
      mainThreadAgentDefinitionRef: agentRef,
      thinkingConfig,
      sessionConfig: sessionConfig as Parameters<typeof runResumeBranch>[0]['sessionConfig'],
      resumeContext: resumeContext as Parameters<typeof runResumeBranch>[0]['resumeContext'],
      getFpsMetrics,
      stats,
      initialState: initialState as Parameters<typeof runResumeBranch>[0]['initialState'],
    });
    mainThreadAgentDefinition = agentRef.current;
    return { handled: true, mainThreadAgentDefinition, sessionConfig };
  }

  // Falls through to REPL (caller runs the inline REPL block with
  // profileCheckpoint('action_after_hooks')).
  return { handled: false, mainThreadAgentDefinition, sessionConfig };
}
