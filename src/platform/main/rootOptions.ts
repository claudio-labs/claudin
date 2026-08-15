// Post-action root program options extracted from src/platform/main.tsx run()
// (ROADMAP 11g Fase 7b).
//
// These are the options registered AFTER the .action() handler in the original
// chain (worktree, advisor, kairos/proactive, brief, channels, teammate
// identity, sdk-url, teleport/remote, remote-control, hard-fail). They live
// in a dedicated module so the option-list is easy to scan; the pre-action
// option chain remains inline in main.tsx because @commander-js/extra-typings
// uses it to infer the .action() callback's `options` type.

import { feature } from 'bun:bundle';
import { type Command as CommanderCommand, Option } from '@commander-js/extra-typings';

import { canUserConfigureAdvisor } from 'src/platform/doctor/advisor.js';

/**
 * Register post-action root options on `program`. Returns the same `program`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRootOptions(program: CommanderCommand<any, any, any>): CommanderCommand<any, any, any> {
  // Worktree flags
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  if (canUserConfigureAdvisor()) {
    program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp());
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  if (feature('UDS_INBOX')) {
    program.addOption(new Option('--messaging-socket-path <path>', 'Unix domain socket path for the UDS messaging server (defaults to a tmp path)'));
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'));
  }
  if (feature('KAIROS')) {
    program.addOption(new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp());
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(new Option('--channels <servers...>', 'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.').hideHelp());
    program.addOption(new Option('--dangerously-load-development-channels <servers...>', 'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.').hideHelp());
  }

  // Teammate identity options (set by leader when spawning tmux teammates)
  // These replace the CLAUDE_CODE_* environment variables
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for analytics correlation').hideHelp());
  program.addOption(new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"').choices(['auto', 'tmux', 'in-process']).hideHelp());
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());

  // Enable SDK URL for all builds but hide from help
  program.addOption(new Option('--sdk-url <url>', 'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)').hideHelp());

  // Enable teleport/remote flags for all builds but keep them undocumented until GA
  program.addOption(new Option('--teleport [session]', 'Resume a teleport session, optionally specify session ID').hideHelp());
  program.addOption(new Option('--remote [description]', 'Create a remote session with the given description').hideHelp());
  if (feature('BRIDGE_MODE')) {
    program.addOption(new Option('--remote-control [name]', 'Start an interactive session with Remote Control enabled (optionally named)').argParser(value => value || true).hideHelp());
    program.addOption(new Option('--rc [name]', 'Alias for --remote-control').argParser(value => value || true).hideHelp());
  }
  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }
  return program;
}
