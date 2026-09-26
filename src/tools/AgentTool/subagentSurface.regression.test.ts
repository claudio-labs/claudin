import { describe, expect, it } from 'bun:test'
// AgentTool first: agentToolUtils <-> AgentTool form an init cycle (see
// agentToolUtils.test.ts).
import 'src/tools/AgentTool/AgentTool.js'
import type { Tool, Tools } from 'src/tools/Tool.js'
import { resolveAgentTools } from 'src/tools/AgentTool/agentToolUtils.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { applyReadOnly } from 'src/tools/AgentTool/readOnlyAgent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

// Characterization net for the agent-messaging work: agent-to-agent messaging
// is an opt-in extra, so an agent that never messages must keep exactly the
// tool surface it had before. What each agent kind gets of the messaging tools
// (and of the tools around them) is pinned here; a change to any row is a
// behavior change for agents that never send a message.

const tool = (name: string): Tool => ({ name }) as unknown as Tool

// A fixed pool so the pin does not move with environment-dependent tools
// (embedded search, worktree mode, todo v2).
const POOL_NAMES = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'ListAgents',
  'NotebookEdit',
  'Patch',
  'Read',
  'RunTests',
  'SendMessage',
  'TaskOutput',
  'TaskStop',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
] as const
const pool: Tools = POOL_NAMES.map(tool)

const MESSAGING_AND_NEIGHBORS = ['Agent', 'Edit', 'ListAgents', 'SendMessage', 'ToolSearch', 'Write']

function surface(definition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>, isAsync: boolean): string[] {
  const { resolvedTools } = resolveAgentTools(definition, pool, isAsync, false)
  return resolvedTools.map(t => t.name).filter(name => MESSAGING_AND_NEIGHBORS.includes(name)).sort()
}

function allNames(definition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>, isAsync: boolean): string[] {
  return resolveAgentTools(definition, pool, isAsync, false)
    .resolvedTools.map(t => t.name)
    .sort()
}

describe('sub-agent tool surface — unchanged for agents that never message', () => {
  it('Code inline keeps every tool but the recursion guards, messaging included', () => {
    expect(surface(GENERAL_PURPOSE_AGENT, false)).toEqual([
      'Agent',
      'Edit',
      'ListAgents',
      'SendMessage',
      'ToolSearch',
      'Write',
    ])
  })

  it('Code in the background gets the async allowlist: messaging yes, Agent no', () => {
    expect(surface(GENERAL_PURPOSE_AGENT, true)).toEqual([
      'Edit',
      'ListAgents',
      'SendMessage',
      'ToolSearch',
      'Write',
    ])
  })

  it('a readOnly Code agent loses the write tools and Agent, not the messaging tools', () => {
    const readOnly = applyReadOnly(GENERAL_PURPOSE_AGENT, true, false)
    expect(surface(readOnly, false)).toEqual(['ListAgents', 'SendMessage', 'ToolSearch'])
    expect(surface(readOnly, true)).toEqual(['ListAgents', 'SendMessage', 'ToolSearch'])
  })

  it('Explore gets exactly its allowlist — no messaging, no ToolSearch', () => {
    const expected = (EXPLORE_AGENT.tools ?? []).filter(name =>
      (POOL_NAMES as readonly string[]).includes(name),
    )
    expect(allNames(EXPLORE_AGENT, false)).toEqual([...expected].sort())
    expect(allNames(EXPLORE_AGENT, true)).toEqual([...expected].sort())
    expect(surface(EXPLORE_AGENT, true)).toEqual([])
  })

  it('Plan keeps messaging through its denylist', () => {
    expect(surface(PLAN_AGENT, false)).toEqual(['ListAgents', 'SendMessage', 'ToolSearch'])
  })

  it('a custom agent with an explicit tools: list gets exactly that list', () => {
    const custom = { tools: ['Read', 'Grep'], source: 'projectSettings' as const }
    expect(allNames(custom, false)).toEqual(['Grep', 'Read'])
    expect(allNames(custom, true)).toEqual(['Grep', 'Read'])
  })

  it('a custom agent that lists SendMessage and ListAgents gets them', () => {
    const custom = {
      tools: ['Read', 'SendMessage', 'ListAgents'],
      source: 'projectSettings' as const,
    }
    expect(allNames(custom, false)).toEqual(['ListAgents', 'Read', 'SendMessage'])
    expect(allNames(custom, true)).toEqual(['ListAgents', 'Read', 'SendMessage'])
  })

  it('a custom agent without tools: is a wildcard, like Code', () => {
    const custom = { source: 'projectSettings' as const }
    expect(surface(custom, false)).toEqual(surface(GENERAL_PURPOSE_AGENT, false))
    expect(surface(custom, true)).toEqual(surface(GENERAL_PURPOSE_AGENT, true))
  })

  it('disallowedTools removes the messaging tools like any other', () => {
    const custom = {
      disallowedTools: ['SendMessage', 'ListAgents'],
      source: 'projectSettings' as const,
    }
    expect(surface(custom, true)).toEqual(['Edit', 'ToolSearch', 'Write'])
  })
})
