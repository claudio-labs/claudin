import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  getBuiltInAgents,
  isExploreAgentEnabled,
  isExploreAgentRegistered,
} from 'src/tools/AgentTool/builtInAgents.js'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { EXPLORE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { WEB_RESEARCHER_AGENT_TYPE } from 'src/tools/AgentTool/built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT_TYPE } from 'src/tools/AgentTool/built-in/webResearcherManagerAgent.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

// The Explore gate is process env: clear it before every test so a value from
// the developer's shell or an earlier file cannot pick the registry, and hand
// back whatever was there when the file loaded.
const SAVED_EXPLORE_ENV = process.env.CLAUDIN_EXPLORE_AGENT
beforeEach(() => {
  delete process.env.CLAUDIN_EXPLORE_AGENT
})
afterAll(() => {
  if (SAVED_EXPLORE_ENV === undefined) delete process.env.CLAUDIN_EXPLORE_AGENT
  else process.env.CLAUDIN_EXPLORE_AGENT = SAVED_EXPLORE_ENV
})

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
  test('registers Code, WebResearcher, WebResearcherManager and the guide', () => {
    const types = getBuiltInAgents().map(a => a.agentType)
    expect(types).toEqual([
      GENERAL_PURPOSE_AGENT.agentType,
      WEB_RESEARCHER_AGENT_TYPE,
      WEB_RESEARCHER_MANAGER_AGENT_TYPE,
      CLAUDE_CODE_GUIDE_AGENT_TYPE,
    ])
  })

  test('registers no agent twice', () => {
    const types = getBuiltInAgents().map(a => a.agentType)
    expect(new Set(types).size).toBe(types.length)
  })
})

describe('the Explore gate (CLAUDIN_EXPLORE_AGENT, opt-in)', () => {
  test('unset: Explore is not registered', () => {
    expect(isExploreAgentEnabled()).toBe(false)
    expect(isExploreAgentRegistered()).toBe(false)
    expect(getBuiltInAgents().map(a => a.agentType)).not.toContain(
      EXPLORE_AGENT_TYPE,
    )
  })

  test('=0: Explore is not registered', () => {
    process.env.CLAUDIN_EXPLORE_AGENT = '0'
    expect(isExploreAgentRegistered()).toBe(false)
  })

  test('=1: Explore is registered once, right after the Plan slot', () => {
    process.env.CLAUDIN_EXPLORE_AGENT = '1'
    expect(isExploreAgentRegistered()).toBe(true)
    // Plan's feature() reads false under bun test, so Explore follows Code.
    expect(getBuiltInAgents().map(a => a.agentType)).toEqual([
      GENERAL_PURPOSE_AGENT.agentType,
      EXPLORE_AGENT_TYPE,
      WEB_RESEARCHER_AGENT_TYPE,
      WEB_RESEARCHER_MANAGER_AGENT_TYPE,
      CLAUDE_CODE_GUIDE_AGENT_TYPE,
    ])
  })

  test('the SDK blank slate wins over the gate', () => {
    // isExploreAgentRegistered reads the registry, not the env, so a prompt
    // asking it cannot name an agent the blank slate dropped.
    process.env.CLAUDIN_EXPLORE_AGENT = '1'
    const savedBlank = process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
    const savedInteractive = getIsInteractive()
    process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1'
    // The blank slate applies to non-interactive (SDK/-p) sessions only.
    setIsInteractive(false)
    try {
      expect(isExploreAgentEnabled()).toBe(true)
      expect(getBuiltInAgents()).toEqual([])
      expect(isExploreAgentRegistered()).toBe(false)
    } finally {
      setIsInteractive(savedInteractive)
      if (savedBlank === undefined) delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
      else process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = savedBlank
    }
  })
})

describe('the Code agent is slim, not blind', () => {
  // 43% of everything a fresh Code agent read in the 2026-09-10 census was
  // orientation injected at its first tool call. It keeps AGENTS.md and the
  // rules — it edits code — and drops the two memory INDEXES plus the
  // parent's git snapshot. `omitClaudeMd` would take the conventions too.
  test('drops the memory indexes and git status, keeps CLAUDE.md', () => {
    expect(GENERAL_PURPOSE_AGENT.omitMemoryIndexes).toBe(true)
    expect(GENERAL_PURPOSE_AGENT.omitGitStatus).toBe(true)
    expect(GENERAL_PURPOSE_AGENT.omitClaudeMd).toBeUndefined()
  })
})

describe('the built-in agent gate (source-asserted)', () => {
  const src = readFileSync(new URL('./builtInAgents.ts', import.meta.url), 'utf8')

  test('the Plan gate registers Plan and nothing else', () => {
    // It used to push `EXPLORE_AGENT, PLAN_AGENT` together — the two rode one
    // flag, so neither could be registered without the other. Explore has its
    // own gate now; this pins that the Plan gate did not become a bucket again.
    expect(src).toMatch(/if \(isPlanAgentEnabled\(\)\) \{\s*agents\.push\(PLAN_AGENT\)\s*\}/)
    expect(src).toMatch(/if \(isExploreAgentEnabled\(\)\) \{\s*agents\.push\(EXPLORE_AGENT\)\s*\}/)
  })

  test('feature() sits directly in the if condition', () => {
    // scripts/build/build.ts only folds `feature('X')` in an if/ternary
    // condition; an `&&` form throws under `bun test` and folds to a literal in
    // the build, so only a test catches it.
    expect(src).toContain("if (feature('BUILTIN_PLAN_AGENT'))")
    expect(src).not.toMatch(/feature\('BUILTIN_PLAN_AGENT'\)\s*&&/)
  })
})
