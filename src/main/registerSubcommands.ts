// Subcommand registration extracted from src/main.tsx run() (ROADMAP 11g Fase 7b).
//
// Chains the 14 register* calls already extracted in Phase 5a. Called from
// run() in the non-print path (subcommand registration is skipped under
// -p/--print to save ~65ms of bootstrap cost — that branch lives in run()).

import type { Command as CommanderCommand } from '@commander-js/extra-typings';

import type { PendingConnect } from './bootContext.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerAssistantCommand } from './commands/assistant.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerAutoModeCommand } from './commands/autoMode.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInstallCommand } from './commands/install.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerOpenCommand } from './commands/open.js';
import { registerPluginCommands } from './commands/plugin.js';
import { registerRemoteControlCommand } from './commands/remoteControl.js';
import { registerServerCommand } from './commands/server.js';
import { registerSetupTokenCommand } from './commands/setupToken.js';
import { registerSshCommand } from './commands/ssh.js';
import { registerUpdateCommand } from './commands/update.js';

export interface RegisterSubcommandsDeps {
  pendingConnect: PendingConnect | undefined;
}

/**
 * Register all top-level Commander subcommands on `program`. Returns `program`.
 */
export function registerSubcommands(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: CommanderCommand<any, any, any>,
  deps: RegisterSubcommandsDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): CommanderCommand<any, any, any> {
  registerMcpCommands(program);

  registerServerCommand(program);

  registerSshCommand(program);
  registerOpenCommand(program, deps.pendingConnect);

  registerAuthCommands(program);

  registerPluginCommands(program);

  registerSetupTokenCommand(program);
  registerAgentsCommand(program);
  registerAutoModeCommand(program);
  registerRemoteControlCommand(program);
  registerAssistantCommand(program);

  registerDoctorCommand(program);
  registerUpdateCommand(program);
  registerInstallCommand(program);

  return program;
}
