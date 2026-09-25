import { describe, expect, test } from 'bun:test'
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { EXPLORE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { UNSUMMARIZED_AGENT_TYPES } from 'src/tools/AgentTool/constants.js'

function completed(agentType: string | undefined): never {
  return {
    status: 'completed',
    agentId: 'agent-1',
    agentType,
    content: [{ type: 'text', text: 'report' }],
    totalToolUseCount: 1,
    totalDurationMs: 1,
    totalTokens: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as never
}

// Explore's report is the list of excerpts the parent edits from; the
// summarizer's head/tail cut would drop the middle ones. Every other agent's
// report still goes through it.
describe('AgentTool.skipsResultSummarizer', () => {
  test('holds exactly the Explore report type', () => {
    expect([...UNSUMMARIZED_AGENT_TYPES]).toEqual([EXPLORE_AGENT_TYPE])
  })

  test('skips a completed Explore report', () => {
    expect(AgentTool.skipsResultSummarizer?.(completed(EXPLORE_AGENT_TYPE))).toBe(true)
  })

  test('keeps summarizing every other report', () => {
    for (const agentType of ['Code', 'Plan', 'WebResearcher', undefined]) {
      expect(AgentTool.skipsResultSummarizer?.(completed(agentType))).toBe(false)
    }
  })

  test('does not apply to a launch notice', () => {
    const launched = {
      status: 'async_launched',
      agentId: 'agent-1',
      description: 'x',
      prompt: 'x',
      outputFile: '/tmp/x',
    } as never
    expect(AgentTool.skipsResultSummarizer?.(launched)).toBe(false)
  })
})
