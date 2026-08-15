// Direct-connect branch — `claudin open cc://...`. Connects the interactive
// TUI to a remote server. Gated by feature('DIRECT_CONNECT'); dead-code in
// the open build. Extracted from src/platform/main.tsx (ROADMAP 11g Fase 5b).

import { getOriginalCwd, setCwdState, setDirectConnectServerUrl, setOriginalCwd } from 'src/platform/bootstrap/state.js';
import type { Command } from 'src/commands.js';
import type { Root } from 'src/terminal/ink.js';
import { exitWithError, renderAndRun } from 'src/terminal/interactiveHelpers.js';
import { launchRepl } from 'src/replLauncher.js';
import { createDirectConnectSession, DirectConnectError } from 'src/platform/server/createDirectConnectSession.js';
import { type AppState } from 'src/terminal/state/AppStateStore.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import { createSystemMessage } from 'src/services/messages/messages.js';
import type { ThinkingConfig } from 'src/services/context/thinking.js';
import type { BootContext } from 'src/platform/main/bootContext.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';

export type DirectConnectBranchDeps = {
  root: Root;
  ctx: BootContext;
  debug: boolean;
  debugToStderr: boolean;
  commands: Command[];
  ide: boolean | undefined;
  mainThreadAgentDefinition: AgentDefinition | undefined;
  thinkingConfig: ThinkingConfig;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore | undefined;
  initialState: AppState;
};

export async function runDirectConnectBranch(deps: DirectConnectBranchDeps): Promise<void> {
  const { root, ctx, debug, debugToStderr, commands, ide, mainThreadAgentDefinition, thinkingConfig, getFpsMetrics, stats, initialState } = deps;
  const pending = ctx.pending.connect!;
  let directConnectConfig;
  try {
    const session = await createDirectConnectSession({
      serverUrl: pending.url!,
      authToken: pending.authToken,
      cwd: getOriginalCwd(),
      dangerouslySkipPermissions: pending.dangerouslySkipPermissions,
    });
    if (session.workDir) {
      setOriginalCwd(session.workDir);
      setCwdState(session.workDir);
    }
    setDirectConnectServerUrl(pending.url!);
    directConnectConfig = session.config;
  } catch (err) {
    return await exitWithError(root, err instanceof DirectConnectError ? err.message : String(err), () => gracefulShutdown(1));
  }
  const connectInfoMessage = createSystemMessage(`Connected to server at ${pending.url}\nSession: ${directConnectConfig.sessionId}`, 'info');
  await launchRepl(root, {
    getFpsMetrics,
    stats,
    initialState,
  }, {
    debug: debug || debugToStderr,
    commands,
    initialTools: [],
    initialMessages: [connectInfoMessage],
    mcpClients: [],
    autoConnectIdeFlag: ide,
    mainThreadAgentDefinition,
    disableSlashCommands: ctx.disableSlashCommands,
    directConnectConfig,
    thinkingConfig,
  }, renderAndRun);
}
