/**
 * ListAgents — who this conversation can SendMessage to. Off together with
 * SendMessage under CLAUDIN_DISABLE_SEND_MESSAGE=1.
 */
import { z } from 'zod/v4'
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js'
import { isTeamLead } from 'src/agent/coordinator/teammate.js'
import { TEAM_LEAD_NAME } from 'src/agent/coordinator/swarm/constants.js'
import { isPanelAgentTask } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { LIST_AGENTS_TOOL_NAME } from 'src/tools/ListAgentsTool/constants.js'
import {
  type AgentRow,
  formatAgentListing,
} from 'src/tools/ListAgentsTool/format.js'
import { DESCRIPTION, getPrompt } from 'src/tools/ListAgentsTool/prompt.js'
import { renderToolResultMessage } from 'src/tools/ListAgentsTool/UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const rowSchema = lazySchema(() =>
  z.object({ name: z.string(), details: z.array(z.string()) }),
)
const outputSchema = lazySchema(() =>
  z.object({
    subagents: z.array(rowSchema()),
    teammates: z.array(rowSchema()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function describeStatus(status: string, isBackgrounded: boolean): string {
  switch (status) {
    case 'running':
      return isBackgrounded ? 'running' : 'running inline'
    case 'completed':
      return 'finished'
    case 'failed':
    case 'killed':
      return 'stopped'
    default:
      return status
  }
}

/**
 * The background agents this conversation spawned, by the name a send
 * resolves: the latest registration of a name, or the raw agentId when the
 * agent has none. A name whose task was already evicted still answers — a
 * send resumes it from its transcript — so it stays listed.
 */
export function collectSubagents(
  appState: Pick<AppState, 'tasks' | 'agentNameRegistry'>,
  selfAgentId: string | undefined,
): AgentRow[] {
  const nameById = new Map<string, string>()
  for (const [name, id] of appState.agentNameRegistry) nameById.set(id, name)

  const rows: AgentRow[] = []
  const listed = new Set<string>()
  for (const task of Object.values(appState.tasks)) {
    if (!isPanelAgentTask(task) || task.agentId === selfAgentId) continue
    listed.add(task.agentId)
    rows.push({
      name: nameById.get(task.agentId) ?? task.agentId,
      details: [describeStatus(task.status, task.isBackgrounded), task.description],
    })
  }
  for (const [name, id] of appState.agentNameRegistry) {
    if (listed.has(id) || id === selfAgentId) continue
    listed.add(id)
    rows.push({ name, details: ['finished'] })
  }
  return rows
}

/** The team's members other than this one, the lead under its fixed name. */
export function collectTeammates(
  appState: Pick<AppState, 'teamContext'>,
): AgentRow[] {
  const team = appState.teamContext
  if (!team) return []
  const rows: AgentRow[] = isTeamLead(team)
    ? []
    : [{ name: TEAM_LEAD_NAME, details: ['team lead'] }]
  for (const mate of Object.values(team.teammates)) {
    if (mate.name === team.selfAgentName) continue
    rows.push({ name: mate.name, details: mate.agentType ? [mate.agentType] : [] })
  }
  return rows
}

export const ListAgentsTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  searchHint: 'list the agents and teammates to send messages to',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt({ swarm: isAgentSwarmsEnabled() })
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return LIST_AGENTS_TOOL_NAME
  },
  shouldDefer: true,
  isEnabled() {
    return !isEnvTruthy(process.env.CLAUDIN_DISABLE_SEND_MESSAGE)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage,
  async call(_input, context) {
    const appState = context.getAppState()
    return {
      data: {
        subagents: collectSubagents(appState, context.agentId),
        teammates: isAgentSwarmsEnabled() ? collectTeammates(appState) : [],
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatAgentListing(content as Output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
