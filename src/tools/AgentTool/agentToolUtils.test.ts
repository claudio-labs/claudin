import { describe, expect, it } from 'bun:test'
// Import AgentTool first: agentToolUtils <-> AgentTool form an init cycle
// (AgentTool builds eagerly and references agentToolResultSchema, defined in
// agentToolUtils). Loading AgentTool first orders the graph so the schema is
// initialized before the eager build runs.
import './AgentTool.js'
import type { Tool, Tools } from '../../Tool.js'
import { WEB_FETCH_TOOL_NAME } from '../WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../WebSearchTool/prompt.js'
import {
  resolveAgentTools,
  scopeChildAgentDefinitions,
} from './agentToolUtils.js'
import { WEB_RESEARCHER_AGENT_TYPE } from './built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT } from './built-in/webResearcherManagerAgent.js'
import { AGENT_TOOL_NAME } from './constants.js'

// Only `name` is read by filterToolsForAgent/resolveAgentTools.
const tool = (name: string): Tool => ({ name }) as unknown as Tool

const availableTools: Tools = [
  tool(AGENT_TOOL_NAME),
  tool(WEB_SEARCH_TOOL_NAME),
  tool(WEB_FETCH_TOOL_NAME),
]

const hasAgentTool = (resolved: Tools): boolean =>
  resolved.some(t => t.name === AGENT_TOOL_NAME)

describe('resolveAgentTools — Agent spec for sub-agents', () => {
  const agentSpec = `${AGENT_TOOL_NAME}(WebResearcher)`

  it('resolves the Agent tool for a SYNC BUILT-IN orchestrator and tracks allowedAgentTypes', () => {
    const result = resolveAgentTools(
      { tools: [agentSpec, WEB_SEARCH_TOOL_NAME], source: 'built-in' },
      availableTools,
      /* isAsync */ false,
      /* isMainThread */ false,
    )
    expect(hasAgentTool(result.resolvedTools)).toBe(true)
    expect(result.allowedAgentTypes).toEqual(['WebResearcher'])
  })

  it('does NOT resolve the Agent tool for an ASYNC built-in agent (recursion guard), but still tracks allowedAgentTypes', () => {
    const result = resolveAgentTools(
      { tools: [agentSpec, WEB_SEARCH_TOOL_NAME], source: 'built-in' },
      availableTools,
      /* isAsync */ true,
      /* isMainThread */ false,
    )
    expect(hasAgentTool(result.resolvedTools)).toBe(false)
    expect(result.allowedAgentTypes).toEqual(['WebResearcher'])
  })

  it('does NOT resolve the Agent tool for a CUSTOM sync agent (only built-in orchestrators may spawn)', () => {
    const result = resolveAgentTools(
      { tools: [agentSpec, WEB_SEARCH_TOOL_NAME], source: 'userSettings' },
      availableTools,
      /* isAsync */ false,
      /* isMainThread */ false,
    )
    expect(hasAgentTool(result.resolvedTools)).toBe(false)
    expect(result.allowedAgentTypes).toEqual(['WebResearcher'])
  })

  it('still resolves the non-Agent web tools the orchestrator declares', () => {
    const result = resolveAgentTools(
      { tools: [agentSpec, WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME], source: 'built-in' },
      availableTools,
      false,
      false,
    )
    expect(result.resolvedTools.some(t => t.name === WEB_SEARCH_TOOL_NAME)).toBe(true)
    expect(result.resolvedTools.some(t => t.name === WEB_FETCH_TOOL_NAME)).toBe(true)
  })
})

describe('scopeChildAgentDefinitions — recursion-cap threading', () => {
  // Mirrors the shape runAgent.ts passes: the child inherits activeAgents but
  // its spawn allowlist is scoped to what it declared via Agent(types).
  const parent = {
    activeAgents: [{ agentType: 'general-purpose' }, { agentType: 'WebResearcher' }],
    allowedAgentTypes: undefined as string[] | undefined,
  }

  it('scopes allowedAgentTypes to the declared set, preserving activeAgents', () => {
    const child = scopeChildAgentDefinitions(parent, ['WebResearcher'])
    expect(child.allowedAgentTypes).toEqual(['WebResearcher'])
    // The pool the parent can see is preserved — only the spawn allowlist narrows.
    expect(child.activeAgents).toBe(parent.activeAgents)
    // Critically: an orchestrator scoped to WebResearcher cannot spawn itself or
    // general-purpose, since AgentTool filters spawnable agents by this set.
    expect(child.allowedAgentTypes).not.toContain('WebResearcherManager')
    expect(child.allowedAgentTypes).not.toContain('general-purpose')
  })

  it('inherits the parent scope unchanged when nothing was declared', () => {
    const child = scopeChildAgentDefinitions(parent, undefined)
    // Identity: no restriction is fabricated for ordinary agents (no regression).
    expect(child).toBe(parent)
    expect(child.allowedAgentTypes).toBeUndefined()
  })

  it('overrides an inherited restriction with the child-declared one', () => {
    const restrictedParent = { ...parent, allowedAgentTypes: ['Explore'] }
    const child = scopeChildAgentDefinitions(restrictedParent, ['WebResearcher'])
    expect(child.allowedAgentTypes).toEqual(['WebResearcher'])
  })
})

describe('WebResearcherManager — end-to-end resolution of the real definition', () => {
  // Feeds the ACTUAL shipped agent definition through resolveAgentTools so a
  // regression in its tools array (e.g. dropping the `(WebResearcher)` arg, or
  // removing the Agent spec entirely) is caught here — not just in the
  // hand-built specs above.
  it('resolves the Agent tool and scopes spawning to WebResearcher only', () => {
    const result = resolveAgentTools(
      WEB_RESEARCHER_MANAGER_AGENT,
      availableTools,
      /* isAsync */ false,
      /* isMainThread */ false,
    )
    // The orchestrator must actually get the Agent tool to fan out.
    expect(hasAgentTool(result.resolvedTools)).toBe(true)
    // ...restricted to spawning the worker, nothing else.
    expect(result.allowedAgentTypes).toEqual([WEB_RESEARCHER_AGENT_TYPE])
    // ...and it keeps its web tools.
    expect(result.resolvedTools.some(t => t.name === WEB_SEARCH_TOOL_NAME)).toBe(true)
    expect(result.resolvedTools.some(t => t.name === WEB_FETCH_TOOL_NAME)).toBe(true)
  })
})
