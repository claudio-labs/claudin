// Subcommand registration extracted from src/platform/main.tsx run() (ROADMAP 11g Fase 7b).
//
// Chains the 14 register* calls already extracted in Phase 5a. Called from
// run() in the non-print path (subcommand registration is skipped under
// -p/--print to save ~65ms of bootstrap cost — that branch lives in run()).

import type { Command as CommanderCommand } from '@commander-js/extra-typings';

import type { PendingConnect } from 'src/platform/main/bootContext.js';
import { registerAgentsCommand } from 'src/platform/main/commands/agents.js';
import { registerAssistantCommand } from 'src/platform/main/commands/assistant.js';
import { registerAuthCommands } from 'src/platform/main/commands/auth.js';
import { registerAutoModeCommand } from 'src/platform/main/commands/autoMode.js';
import { registerDoctorCommand } from 'src/platform/main/commands/doctor.js';
import { registerInstallCommand } from 'src/platform/main/commands/install.js';
import { registerMcpCommands } from 'src/platform/main/commands/mcp.js';
import { registerOpenCommand } from 'src/platform/main/commands/open.js';
import { registerPluginCommands } from 'src/platform/main/commands/plugin.js';
import { registerRemoteControlCommand } from 'src/platform/main/commands/remoteControl.js';
import { registerServerCommand } from 'src/platform/main/commands/server.js';
import { registerSetupTokenCommand } from 'src/platform/main/commands/setupToken.js';
import { registerSshCommand } from 'src/platform/main/commands/ssh.js';
import { registerUpdateCommand } from 'src/platform/main/commands/update.js';
import { registerWorkflowCommand } from 'src/platform/main/commands/workflow.js';

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
  registerWorkflowCommand(program);

  return program;
}
