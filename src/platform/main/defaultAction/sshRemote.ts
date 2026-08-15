// SSH remote branch — `claudin ssh <host> [dir]`. Probes the remote, deploys
// the binary if needed, opens an ssh connection with a unix-socket -R forward
// to a local auth proxy and hands the REPL an SSHSession. Tools run remotely,
// UI renders locally. `--local` skips probe/deploy/ssh and spawns the current
// binary directly (e2e proxy test). Gated by feature('SSH_REMOTE').
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 5b).

import { setCwdState, setDirectConnectServerUrl, setOriginalCwd } from 'src/platform/bootstrap/state.js';
import type { Command } from 'src/commands.js';
import type { Root } from 'src/terminal/ink.js';
import { exitWithError, renderAndRun } from 'src/terminal/interactiveHelpers.js';
import { launchRepl } from 'src/replLauncher.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js';
import { createSystemMessage } from 'src/agent/messages/messages.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';
import type { ThinkingConfig } from 'src/agent/context/thinking.js';
import type { BootContext } from 'src/platform/main/bootContext.js';

export type SshRemoteBranchDeps = {
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

export async function runSshRemoteBranch(deps: SshRemoteBranchDeps): Promise<void> {
  const { root, ctx, debug, debugToStderr, commands, ide, mainThreadAgentDefinition, thinkingConfig, getFpsMetrics, stats, initialState } = deps;
  const pending = ctx.pending.ssh!;
  const { createSSHSession, createLocalSSHSession, SSHSessionError } = await import('../../ssh/createSSHSession.js');
  let sshSession;
  try {
    if (pending.local) {
      process.stderr.write('Starting local ssh-proxy test session...\n');
      sshSession = createLocalSSHSession({
        cwd: pending.cwd,
        permissionMode: pending.permissionMode,
        dangerouslySkipPermissions: pending.dangerouslySkipPermissions,
      });
    } else {
      process.stderr.write(`Connecting to ${pending.host}…\n`);
      // In-place progress: \r + EL0. No-op when stderr isn't a TTY.
      const isTTY = process.stderr.isTTY;
      let hadProgress = false;
      sshSession = await createSSHSession({
        host: pending.host!,
        cwd: pending.cwd,
        localVersion: MACRO.VERSION,
        permissionMode: pending.permissionMode,
        dangerouslySkipPermissions: pending.dangerouslySkipPermissions,
        extraCliArgs: pending.extraCliArgs,
      }, isTTY ? {
        onProgress: (msg: string) => {
          hadProgress = true;
          process.stderr.write(`\r  ${msg}\x1b[K`);
        },
      } : {});
      if (hadProgress) process.stderr.write('\n');
    }
    setOriginalCwd(sshSession.remoteCwd);
    setCwdState(sshSession.remoteCwd);
    setDirectConnectServerUrl(pending.local ? 'local' : pending.host!);
  } catch (err) {
    // SSHSessionError comes back typed `any` from the SSH_REMOTE stub module
    // (feature off in this build), which doesn't narrow `unknown` via
    // `instanceof` — fall back to the general Error check for the message.
    const message =
      err instanceof SSHSessionError && err instanceof Error
        ? err.message
        : String(err);
    return await exitWithError(root, message, () => gracefulShutdown(1));
  }
  const sshInfoMessage = createSystemMessage(
    pending.local
      ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
      : `SSH session to ${pending.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
    'info',
  );
  await launchRepl(root, {
    getFpsMetrics,
    stats,
    initialState,
  }, {
    debug: debug || debugToStderr,
    commands,
    initialTools: [],
    initialMessages: [sshInfoMessage],
    mcpClients: [],
    autoConnectIdeFlag: ide,
    mainThreadAgentDefinition,
    disableSlashCommands: ctx.disableSlashCommands,
    sshSession,
    thinkingConfig,
  }, renderAndRun);
}
