import { describe, expect, test } from 'bun:test'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { READ_ONLY_DISALLOWED_TOOLS } from 'src/tools/AgentTool/readOnlyAgent.js'

const PARAMS = { toolUseContext: { options: {} as never } }

// Mirrors resolveAgentTools (agentToolUtils.ts): the denylist always applies,
// and an allowlist other than ['*'] admits only what it names.
function canReach(agent: AgentDefinition, toolName: string): boolean {
  if ((agent.disallowedTools ?? []).includes(toolName)) return false
  const { tools } = agent
  if (tools === undefined || (tools.length === 1 && tools[0] === '*')) {
    return true
  }
  return tools.includes(toolName)
}

// The built-in Plan and Explore agents are contractually read-only ("you do
// NOT have access to file editing tools"). Patch is a mutating tool and must be
// excluded alongside edit/write — otherwise a read-only agent could write. Plan
// excludes them by denylist, Explore by allowlist; both must end up unable to
// reach any of them, or spawn another agent.
describe('read-only built-in agents cannot reach a write tool', () => {
  for (const agent of [PLAN_AGENT, EXPLORE_AGENT]) {
    test(`${agent.agentType} reaches none of ${READ_ONLY_DISALLOWED_TOOLS.join('/')}`, () => {
      const reachable = READ_ONLY_DISALLOWED_TOOLS.filter(name =>
        canReach(agent, name),
      )
      expect(reachable).toEqual([])
    })
  }
})

// Explore's reading order was replicated into Plan and Code; this loop covers
// all three copies. Measured motivation: across 99 sessions only 22.7% of the
// Reads these agents issued were targeted (outline/symbol), the rest pulled
// whole files.
describe('reading order in the bulk-reading agents', () => {
  for (const agent of [EXPLORE_AGENT, PLAN_AGENT, GENERAL_PURPOSE_AGENT]) {
    test(`${agent.agentType} prefers outline/symbol over a full read`, () => {
      const prompt = agent.getSystemPrompt(PARAMS)
      expect(prompt).toContain("view='outline'")
      expect(prompt).toContain("symbol='name'")
      expect(prompt).toContain('offset/limit')
      expect(prompt).toContain('Read a file in full only when')
    })

    test(`${agent.agentType} states the order, not just the options`, () => {
      const prompt = agent.getSystemPrompt(PARAMS)
      expect(prompt.indexOf("view='outline'")).toBeLessThan(
        prompt.indexOf("symbol='name'"),
      )
    })
  }
})
