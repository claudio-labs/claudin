import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from 'src/commands/commands.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { which } from 'src/shared/proc/which.js'
import { STATUSLINE_SETUP_AGENT_TYPE } from 'src/tools/AgentTool/built-in/statuslineSetupAgent.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'

const DEFAULT_REQUEST =
  'Configure my status line from my shell PS1 configuration, or set up the Claudin default line if there is none.'

// The files the PS1 import reads, plus the config home for the settings and
// the script. Anything else (a starship.toml, a .p10k.zsh) asks first.
const SHELL_RC_FILES = ['~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.profile']

export function getStatuslineAllowedTools(): string[] {
  return [
    ...SHELL_RC_FILES.map(file => `${FILE_READ_TOOL_NAME}(${file})`),
    // `//abs/**` anchors at the filesystem root, so a CLAUDIN_CONFIG_DIR
    // outside the home directory is covered too.
    `${FILE_READ_TOOL_NAME}(/${getClaudinConfigHomeDir()}/**)`,
  ]
}

export function buildStatuslineRequest(args: string, hasJq: boolean): string {
  const request = args.trim() || DEFAULT_REQUEST
  return `${request}\n\njq is ${hasJq ? '' : 'not '}installed on this machine.`
}

// Runs the statusline-setup agent directly (context: 'fork') rather than
// asking the main loop to spawn it, so setting up the status line costs no
// request against the session's context. The agent's edits to the config home
// always ask (checkPathSafetyForAutoEdit), so no Edit rule is pre-approved.
const statusline = {
  type: 'prompt',
  name: 'statusline',
  description: "Set up Claudin's status line",
  argumentHint: '[what to show]',
  progressMessage: 'setting up the status line',
  contentLength: 0,
  source: 'builtin',
  context: 'fork',
  agent: STATUSLINE_SETUP_AGENT_TYPE,
  // The agent needs the edit dialog, which -p cannot show.
  disableNonInteractive: true,
  get allowedTools() {
    return getStatuslineAllowedTools()
  },
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const hasJq = (await which('jq')) !== null
    return [{ type: 'text', text: buildStatuslineRequest(args, hasJq) }]
  },
} satisfies Command

export default statusline
