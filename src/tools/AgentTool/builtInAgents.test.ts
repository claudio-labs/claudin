import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { getBuiltInAgents } from 'src/tools/AgentTool/builtInAgents.js'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
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

// The registry that `bun test` sees is the FLAG-OFF one: `feature()` resolves
// natively and reads false outside a build (see .claudin/rules/build-system.md),
// so nothing behind `feature('BUILTIN_…')` is registered here. That makes this
// suite blind to the gated agents by construction — the two describes below
// split the difference: the runtime one pins the agents that are ALWAYS
// registered, the source one pins the gate itself.
describe('ungated registry (the shape bun test can observe)', () => {
  const types = getBuiltInAgents().map(a => a.agentType)

  test('registers Code, WebResearcher, WebResearcherManager and the guide', () => {
    expect(types).toEqual([
      GENERAL_PURPOSE_AGENT.agentType,
      WEB_RESEARCHER_AGENT_TYPE,
      WEB_RESEARCHER_MANAGER_AGENT_TYPE,
      CLAUDE_CODE_GUIDE_AGENT_TYPE,
    ])
  })

  test('registers no agent twice', () => {
    expect(new Set(types).size).toBe(types.length)
  })
})

describe('the built-in agent gate (source-asserted)', () => {
  const src = readFileSync(new URL('./builtInAgents.ts', import.meta.url), 'utf8')

  test('the gate registers Plan and nothing else', () => {
    // It used to push `EXPLORE_AGENT, PLAN_AGENT` together — the two rode one
    // flag, so neither could be registered without the other. Explore is gone;
    // this pins that the gate did not become a bucket again.
    expect(src).toContain('agents.push(PLAN_AGENT)')
    expect(src).not.toContain('EXPLORE_AGENT')
  })

  test('feature() sits directly in the if condition', () => {
    // scripts/build/build.ts only folds `feature('X')` in an if/ternary
    // condition; an `&&` form throws under `bun test` and folds to a literal in
    // the build, so only a test catches it.
    expect(src).toContain("if (feature('BUILTIN_PLAN_AGENT'))")
    expect(src).not.toMatch(/feature\('BUILTIN_PLAN_AGENT'\)\s*&&/)
  })
})
