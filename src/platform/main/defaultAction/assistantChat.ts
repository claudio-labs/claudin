// Assistant chat branch — `claudin assistant [sessionId]`. REPL as a pure
// viewer client of a remote assistant session. Gated by feature('KAIROS').
// Dead-code in the open build. Extracted from src/platform/main.tsx (ROADMAP 11g
// Fase 5b).

import { setIsRemoteMode, setKairosActive, setUserMsgOptIn } from 'src/platform/bootstrap/state.js';
import { filterCommandsForRemoteMode } from 'src/commands.js';
import { launchAssistantInstallWizard, launchAssistantSessionChooser } from 'src/terminal/dialogLaunchers.js';
import type { Root } from 'src/terminal/ink.js';
import { exitWithError, exitWithMessage, renderAndRun } from 'src/terminal/interactiveHelpers.js';
import { createRemoteSessionConfig } from 'src/platform/remote/RemoteSessionManager.js';
import { launchRepl } from 'src/agent/repl/replLauncher.js';
import { type AppState } from 'src/terminal/state/AppStateStore.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import { createSystemMessage } from 'src/agent/messages/messages.js';
import { prepareApiRequest } from 'src/platform/teleport/api.js';
import type { ThinkingConfig } from 'src/agent/context/thinking.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';

export type AssistantChatBranchDeps = {
  root: Root;
  ctx: BootContext;
  debug: boolean;
  debugToStderr: boolean;
  commands: Parameters<typeof filterCommandsForRemoteMode>[0];
  ide: boolean | undefined;
  mainThreadAgentDefinition: AgentDefinition | undefined;
  thinkingConfig: ThinkingConfig;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore | undefined;
  initialState: AppState;
};

export async function runAssistantChatBranch(deps: AssistantChatBranchDeps): Promise<void> {
  const { root, ctx, debug, debugToStderr, commands, ide, mainThreadAgentDefinition, thinkingConfig, getFpsMetrics, stats, initialState } = deps;
  const pending = ctx.pending.assistantChat!;
  const { discoverAssistantSessions } = await import('../../../assistant/sessionDiscovery.js');
  let targetSessionId = pending.sessionId;

  // Discovery flow — list bridge environments, filter sessions
  if (!targetSessionId) {
    let sessions;
    try {
      sessions = await discoverAssistantSessions();
    } catch (e) {
      return await exitWithError(root, `Failed to discover sessions: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
    }
    if (sessions.length === 0) {
      let installedDir: string | null;
      try {
        installedDir = await launchAssistantInstallWizard(root);
      } catch (e) {
        return await exitWithError(root, `Assistant installation failed: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
      }
      if (installedDir === null) {
        await gracefulShutdown(0);
        process.exit(0);
      }
      // The daemon needs a few seconds to spin up its worker and
      // establish a bridge session before discovery will find it.
      return await exitWithMessage(root, `Assistant installed in ${installedDir}. The daemon is starting up — run \`claude assistant\` again in a few seconds to connect.`, {
        exitCode: 0,
        beforeExit: () => gracefulShutdown(0),
      });
    }
    if (sessions.length === 1) {
      targetSessionId = sessions[0]!.id;
    } else {
      const picked = await launchAssistantSessionChooser(root, { sessions });
      if (!picked) {
        await gracefulShutdown(0);
        process.exit(0);
      }
      targetSessionId = picked;
    }
  }

  // Auth — call prepareApiRequest() once for orgUUID, but use a
  // getAccessToken closure for the token so reconnects get fresh tokens.
  const { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens } = await import('src/services/auth/auth.js');
  await checkAndRefreshOAuthTokenIfNeeded();
  let apiCreds;
  try {
    apiCreds = await prepareApiRequest();
  } catch (e) {
    return await exitWithError(root, `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`, () => gracefulShutdown(1));
  }
  const getAccessToken = (): string => getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken;

  // Brief mode activation: setKairosActive(true) satisfies BOTH opt-in
  // and entitlement for isBriefEnabled() (BriefTool.ts:124-132).
  setKairosActive(true);
  setUserMsgOptIn(true);
  setIsRemoteMode(true);
  const remoteSessionConfig = createRemoteSessionConfig(targetSessionId!, getAccessToken, apiCreds.orgUUID, /* hasInitialPrompt */false, /* viewerOnly */true);
  const infoMessage = createSystemMessage(`Attached to assistant session ${targetSessionId!.slice(0, 8)}…`, 'info');
  const assistantInitialState: AppState = {
    ...initialState,
    isBriefOnly: true,
    kairosEnabled: false,
    replBridgeEnabled: false,
  };
  const remoteCommands = filterCommandsForRemoteMode(commands);
  await launchRepl(root, {
    getFpsMetrics,
    stats,
    initialState: assistantInitialState,
  }, {
    debug: debug || debugToStderr,
    commands: remoteCommands,
    initialTools: [],
    initialMessages: [infoMessage],
    mcpClients: [],
    autoConnectIdeFlag: ide,
    mainThreadAgentDefinition,
    disableSlashCommands: ctx.disableSlashCommands,
    remoteSessionConfig,
    thinkingConfig,
  }, renderAndRun);
}
