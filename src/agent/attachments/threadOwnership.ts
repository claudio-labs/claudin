// Which threads own the session-scoped state the attachment producers read.
//
// Two producers reach for state that belongs to the session rather than to a
// conversation: `teammate_mailbox` (the file-backed mailbox, which it also
// marks read) and the TodoV2 branch of `todo_reminders` (the task list
// getTaskListId() resolves to). A sub-agent that reads either takes it from
// the thread it was meant for — the mailbox destructively, the task list with
// a "keep this list current" instruction aimed at a list the child was never
// asked about (#227).
//
// The gate cannot simply be `agentId`. An in-process teammate reaches runAgent
// like any sub-agent and so has one (inProcessRunner.ts calls runAgent inside
// runWithTeammateContext with an override that sets no agentId), yet it is a
// real owner: its own loop is the only path that delivers a DM mid-turn, and
// getTaskListId() deliberately resolves to the leader's team list for it.
// AsyncLocalStorage propagates into whatever that loop spawns, so the agent
// name and the task list id are identical on both sides — only a context field
// that createSubagentContext does not copy can separate them.
import type { ToolUseContext } from 'src/tools/Tool.js'

export function ownsSessionScopedState(
  context: Pick<ToolUseContext, 'agentId' | 'isTeammateOwnLoop'>,
): boolean {
  return !context.agentId || context.isTeammateOwnLoop === true
}
