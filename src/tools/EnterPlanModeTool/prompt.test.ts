import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEnterPlanModeToolPrompt } from 'src/tools/EnterPlanModeTool/prompt.js'

const SAVED_EXPLORE_ENV = process.env.CLAUDIN_EXPLORE_AGENT
beforeEach(() => {
  delete process.env.CLAUDIN_EXPLORE_AGENT
})
afterAll(() => {
  if (SAVED_EXPLORE_ENV === undefined) delete process.env.CLAUDIN_EXPLORE_AGENT
  else process.env.CLAUDIN_EXPLORE_AGENT = SAVED_EXPLORE_ENV
})

// The "when NOT to use" line pointed research at an "explore agent" for five
// weeks after that agent was removed. It names one now only when the registry
// has it.
describe('EnterPlanMode prompt — the research lane', () => {
  test('without the Explore agent it names only the Agent tool', () => {
    process.env.CLAUDIN_EXPLORE_AGENT = '0'
    const text = getEnterPlanModeToolPrompt()
    expect(text).toContain('- Pure research/exploration tasks (use the Agent tool instead)')
    expect(text).not.toMatch(/explore agent/i)
  })

  test('with the Explore agent registered (the default) it names it', () => {
    expect(getEnterPlanModeToolPrompt()).toContain(
      '- Pure research/exploration tasks (use the Agent tool with the `Explore` agent instead)',
    )
  })
})
