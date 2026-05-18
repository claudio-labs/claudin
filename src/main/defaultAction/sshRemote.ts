// SSH remote branch — `claudio ssh <host> [dir]`. Probes the remote, deploys
// the binary if needed, opens an ssh connection with a unix-socket -R forward
// to a local auth proxy and hands the REPL an SSHSession. Tools run remotely,
// UI renders locally. `--local` skips probe/deploy/ssh and spawns the current
// binary directly (e2e proxy test). Gated by feature('SSH_REMOTE').
// Extracted from src/main.tsx (ROADMAP 11g Fase 5b).

import { setCwdState, setDirectConnectServerUrl, setOriginalCwd } from '../../bootstrap/state.js';
import type { Root } from '../../ink.js';
import { exitWithError, renderAndRun } from '../../interactiveHelpers.js';
import { launchRepl } from '../../replLauncher.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { createSystemMessage } from '../../utils/messages.js';
import type { BootContext } from '../bootContext.js';

export type SshRemoteBranchDeps = {
  root: Root;
  ctx: BootContext;
  debug: boolean;
  debugToStderr: boolean;
  commands: unknown[];
  ide: unknown;
  mainThreadAgentDefinition: unknown;
  thinkingConfig: unknown;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore | undefined;
  initialState: unknown;
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
    return await exitWithError(root, err instanceof SSHSessionError ? err.message : String(err), () => gracefulShutdown(1));
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
