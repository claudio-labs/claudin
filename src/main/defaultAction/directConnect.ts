// Direct-connect branch — `claudin open cc://...`. Connects the interactive
// TUI to a remote server. Gated by feature('DIRECT_CONNECT'); dead-code in
// the open build. Extracted from src/main.tsx (ROADMAP 11g Fase 5b).

import { getOriginalCwd, setCwdState, setDirectConnectServerUrl, setOriginalCwd } from '../../bootstrap/state.js';
import type { Command } from '../../commands.js';
import type { Root } from '../../ink.js';
import { exitWithError, renderAndRun } from '../../interactiveHelpers.js';
import { launchRepl } from '../../replLauncher.js';
import { createDirectConnectSession, DirectConnectError } from '../../server/createDirectConnectSession.js';
import { type AppState } from '../../state/AppStateStore.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import type { FpsMetrics } from '../../utils/fpsTracker.js';
import { createSystemMessage } from '../../utils/messages.js';
import type { ThinkingConfig } from '../../utils/thinking.js';
import type { BootContext } from '../bootContext.js';
import type { StatsStore } from '../../context/stats.js';

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
