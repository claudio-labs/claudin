// /fork and /subtask: one spawner (spawnForkFromDirective), Claude Code's
// wording for each.

import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import { FORK_GLYPH } from 'src/shared/constants/figures.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/shared/types/command.js'
import { spawnForkFromDirective } from 'src/tools/AgentTool/forkFromDirective.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export type ForkWording = {
  usage: string
  coordinator: string
  noTurn: string
}

// The result renders as markdown, where a bare `<directive>` is an HTML tag
// and vanishes — hence Claude Code's escaped `\<…\>`.
export const FORK_WORDING: ForkWording = {
  usage: 'Usage: /fork \\<directive\\>',
  coordinator: 'Forking is not available in coordinator sessions. Use /branch instead.',
  noTurn: 'Cannot fork before the first conversation turn',
}

export async function runFork(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
  wording: ForkWording,
  spawn: typeof spawnForkFromDirective = spawnForkFromDirective,
): Promise<null> {
  const directive = args.trim()
  if (!directive) {
    onDone(wording.usage, { display: 'system' })
    return null
  }
  const result = await spawn(directive, context, context.canUseTool ?? hasPermissionsToUseTool)
  switch (result.kind) {
    case 'spawned':
      onDone(`${FORK_GLYPH} forked ${result.name} (${result.agentId.slice(-4)})`, { display: 'system' })
      break
    case 'coordinator':
      onDone(wording.coordinator, { display: 'system' })
      break
    case 'no-turn':
      onDone(wording.noTurn, { display: 'system' })
      break
  }
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  return runFork(onDone, context, args, FORK_WORDING)
}
