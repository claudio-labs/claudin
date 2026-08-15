import { describe, expect, test } from 'bun:test'
import { getBuiltInAgents } from 'src/tools/AgentTool/builtInAgents.js'
import { WEB_RESEARCHER_AGENT_TYPE } from 'src/tools/AgentTool/built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT_TYPE } from 'src/tools/AgentTool/built-in/webResearcherManagerAgent.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

describe('getBuiltInAgents', () => {
  test('includes WebResearcher in the default (non-coordinator) registry', () => {
    const agents = getBuiltInAgents()
    const types = agents.map((a) => a.agentType)
    expect(types).toContain(WEB_RESEARCHER_AGENT_TYPE)
  })

  test('includes WebResearcherManager, restricted to spawning WebResearcher', () => {
    const agents = getBuiltInAgents()
    const manager = agents.find(
      (a) => a.agentType === WEB_RESEARCHER_MANAGER_AGENT_TYPE,
    )
    expect(manager).toBeDefined()
    // It must declare the Agent tool scoped to WebResearcher so the orchestrator
    // path resolves it and restricts the spawn target.
    expect(manager?.tools).toContain(
      `${AGENT_TOOL_NAME}(${WEB_RESEARCHER_AGENT_TYPE})`,
    )
  })
})
