// What the first request stated twice, pointed at the wrong thing, or carried
// for nothing, and now says once (2026-09-29, team memory
// `claude-code-2.1.284-wire-diff`; measured as the `lean3` arm of the session
// A/B /tmp/session-cache-ab/20260929-231527, no regression). Each case pins
// the one place a rule is left in, and that the copy is gone.
import { afterEach, describe, expect, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/claudio-labs/claudin/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { getIsNonInteractiveSession, setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  buildAgentToolSection,
  computeSimpleEnvInfo,
  getSessionSpecificGuidanceSection,
} from 'src/agent/prompts/prompts.js'
import { formatAgentLine, renderCompactAgentPrompt } from 'src/tools/AgentTool/prompt.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { getCompactDescription } from 'src/tools/GrepTool/prompt.js'
import { getPrompt as getToolSearchPrompt } from 'src/tools/ToolSearchTool/prompt.js'

const TOOLS = new Set(['AskUserQuestion', 'Agent', 'Skill', 'Grep', 'Glob'])
const SKILL = { type: 'prompt', name: 's', description: 'd', source: 'bundled' } as never
const NO_DOUBLE_WORK = 'do not also perform the same searches yourself'

describe('session guidance', () => {
  test('the v2 guidance names no deferred tool, keeps only the delegation threshold and has no skill item', () => {
    const v2 = getSessionSpecificGuidanceSection(TOOLS, [SKILL], true)!
    expect(v2).toContain("If you don't know why a tool call was denied, ask the user.")
    expect(v2).not.toContain('AskUserQuestion')
    expect(v2).toContain('When the question needs more than 3 dependent searches, delegate it to the Agent tool.')
    expect(v2).not.toContain('directly for a directed lookup')
    expect(v2).not.toContain('/<skill-name>')
  })

  test('another family keeps each item: its Agent description is the full one, and it sends every tool inline', () => {
    const other = getSessionSpecificGuidanceSection(TOOLS, [SKILL], false)!
    expect(other).toContain('use the AskUserQuestion to ask them')
    expect(other).toContain('directly for a directed lookup')
    expect(other).toContain('/<skill-name> (e.g., /commit)')
  })
})

describe('environment', () => {
  const wasNonInteractive = getIsNonInteractiveSession()
  afterEach(() => setIsInteractive(!wasNonInteractive))

  test('no product line and no sentence repeating the heading', async () => {
    const env = await computeSimpleEnvInfo('claude-opus-5-5')
    expect(env).not.toContain('Claudin is available as a CLI')
    expect(env).not.toContain('You have been invoked')
    expect(env.split('\n')[0]).toBe('# Environment')
    expect(env).toContain('Primary working directory')
    expect(env).toContain('powered by the model')
  })

  test('the fast-mode line, about a TUI toggle, stays out of -p', async () => {
    setIsInteractive(false)
    expect(await computeSimpleEnvInfo('claude-opus-5-5')).not.toContain('/fast')
  })
})

describe('Agent description and listing', () => {
  test('the compact description leaves the no-double-work rule to the system prompt, which keeps it in every lane', () => {
    const description = renderCompactAgentPrompt(false, true)
    expect(description).not.toContain("don't also run it yourself")
    expect(description).toContain('search directly')
    expect(buildAgentToolSection(true, true)).toContain(NO_DOUBLE_WORK)
    expect(buildAgentToolSection(false, true)).toContain(NO_DOUBLE_WORK)
  })

  test("the compact description names Explore and leaves what it returns to Explore's listing line", () => {
    const description = renderCompactAgentPrompt(false, true)
    expect(description).toContain('subagent_type: "Explore"')
    expect(description).not.toContain('quotes what it finds verbatim')
    expect(EXPLORE_AGENT.whenToUse).toContain('`path:start-end` anchors with the lines quoted verbatim')
  })

  test('the Code and Explore listing lines leave search routing to the Agent description', () => {
    expect(GENERAL_PURPOSE_AGENT.whenToUse).toBe(
      'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
    )
    expect(EXPLORE_AGENT.whenToUse).not.toContain('search directly instead')
    expect(EXPLORE_AGENT.whenToUse).toContain('"very thorough"')
  })

  test('an agent whose denylist takes the edit tools away is listed as read-only', () => {
    expect(formatAgentLine(PLAN_AGENT)).toEndWith('(read-only)')
    expect(formatAgentLine({ ...GENERAL_PURPOSE_AGENT, whenToUse: 'x' })).toEndWith('(Tools: *)')
  })
})

describe('tool descriptions', () => {
  test('ToolSearch shows a select of deferred tools and no result-format paragraph', () => {
    const prompt = getToolSearchPrompt()
    expect(prompt).not.toContain('Result format:')
    expect(prompt).toContain('"select:WebFetch,WebSearch"')
    expect(prompt).not.toContain('select:Read,Edit,Grep')
    expect(prompt).toContain('<functions>')
  })

  test('the compact Grep description has no pointer to the Agent tool', () => {
    const description = getCompactDescription()
    expect(description).not.toContain('Agent tool')
    expect(description.trimEnd()).toEndWith('("utf-16le", "shift_jis").')
  })
})
