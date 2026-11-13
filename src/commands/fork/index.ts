import type { Command } from 'src/commands/commands.js'
import { isForkSubagentEnabled } from 'src/tools/AgentTool/forkSubagent.js'
import { isRunInBackgroundHidden } from 'src/tools/AgentTool/prompt.js'

/**
 * /fork and /subtask need the fork agent, and stay off where nothing would
 * drain a background agent: `-p`, or background tasks turned off.
 */
export function isForkCommandEnabled(
  forkSubagent: boolean = isForkSubagentEnabled(),
  backgroundHidden: boolean = isRunInBackgroundHidden(),
): boolean {
  return forkSubagent && !backgroundHidden
}

export const fork = {
  type: 'local-jsx',
  name: 'fork',
  description: 'Spawn a background agent that inherits the full conversation',
  argumentHint: '<directive>',
  isEnabled: () => isForkCommandEnabled(),
  load: () => import('src/commands/fork/fork.js'),
} satisfies Command

export const subtask = {
  type: 'local-jsx',
  name: 'subtask',
  description: 'Send a subagent off with your full context; its result comes back here',
  argumentHint: '<task>',
  isEnabled: () => isForkCommandEnabled(),
  load: () => import('src/commands/fork/subtask.js'),
} satisfies Command
