import { describe, expect, test } from 'bun:test'
import { getBuiltInAgents } from './builtInAgents.js'
import { WEB_RESEARCHER_AGENT_TYPE } from './built-in/webResearcherAgent.js'

describe('getBuiltInAgents', () => {
  test('includes WebResearcher in the default (non-coordinator) registry', () => {
    const agents = getBuiltInAgents()
    const types = agents.map((a) => a.agentType)
    expect(types).toContain(WEB_RESEARCHER_AGENT_TYPE)
  })
})
