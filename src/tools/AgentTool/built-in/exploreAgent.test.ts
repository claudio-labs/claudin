import { describe, expect, test } from 'bun:test'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'

const PARAMS = { toolUseContext: { options: {} as never } }

// Measured on 99 local sessions (91 Explore calls): 29% of Explore calls were
// followed by a FULL re-read of a file the report already covered, because the
// prompt only asked to "report your findings clearly" — no anchors, no
// excerpts. FileReadTool's prompt meanwhile promises the caller that Explore
// "returns excerpts in one turn". These pin the contract that makes that true.
describe('Explore output contract', () => {
  const prompt = EXPLORE_AGENT.getSystemPrompt(PARAMS)

  test('demands a path:line anchor on every finding', () => {
    expect(prompt).toContain('## Required Output')
    expect(prompt).toContain('`path:line` anchor')
    expect(prompt).toContain('incomplete finding')
  })

  test('demands verbatim excerpts, not paraphrase', () => {
    expect(prompt).toContain('VERBATIM')
    expect(prompt).toContain('never paraphrased')
  })

  test('caps excerpt size so the report keeps compressing', () => {
    // The agent's whole value is 13.2x median compression (82k chars consumed
    // vs 6.5k returned). "Quote verbatim" without a bound would undo it.
    expect(prompt).toContain('minimum that supports the finding')
  })

  test('demands an explicit not-found section', () => {
    expect(prompt).toContain('## Not found / not checked')
  })
})

// Only 22.7% of the Reads Explore issued were targeted (outline/symbol); the
// rest pulled whole files across a median of 29 tool calls per run.
describe('reading order in the bulk-reading agents', () => {
  for (const agent of [EXPLORE_AGENT, PLAN_AGENT, GENERAL_PURPOSE_AGENT]) {
    test(`${agent.agentType} prefers outline/symbol over a full read`, () => {
      const prompt = agent.getSystemPrompt(PARAMS)
      expect(prompt).toContain("view='outline'")
      expect(prompt).toContain("symbol='name'")
      expect(prompt).toContain('offset/limit')
      expect(prompt).toContain('Read a file in full only when')
    })
  }

  test('Explore states the order, not just the options', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt(PARAMS)
    expect(prompt).toContain('## Reading order')
    expect(prompt.indexOf("view='outline'")).toBeLessThan(
      prompt.indexOf("symbol='name'"),
    )
  })
})

describe('EXPLORE_AGENT.whenToUse', () => {
  const { whenToUse } = EXPLORE_AGENT

  test('does not advertise itself as a file-pattern search', () => {
    // 0 of 77 organic calls were LOCATE-SYMBOL or READ-ONE-THING, and Glob was
    // 102 of its ~2650 internal tool calls — it is not a locator.
    expect(whenToUse).not.toContain('find files by patterns')
    // src/components/ is one of the seven buckets the reorg retired.
    expect(whenToUse).not.toContain('src/components')
  })

  test('advertises the multi-hop case and the excerpt contract', () => {
    expect(whenToUse).toContain('dependent searches')
    expect(whenToUse).toContain('file:line')
    expect(whenToUse).toContain('without re-opening the files')
  })

  test('keeps the thoroughness levels callers actually pass', () => {
    for (const level of ['quick', 'medium', 'very thorough']) {
      expect(whenToUse).toContain(level)
    }
  })
})
