import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
// Define it globally so tests that import modules using MACRO don't crash.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { clearSystemPromptSections } from './systemPromptSections.js'
import { getSystemPrompt, DEFAULT_AGENT_PROMPT } from './prompts.js'
import { CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } from './system.js'
import { GEMINI_ADDENDUM } from './familyAddendums/gemini.js'
import { GLM_ADDENDUM } from './familyAddendums/glm.js'
import { KIMI_ADDENDUM } from './familyAddendums/kimi.js'
import { OPENAI_REASONING_ADDENDUM } from './familyAddendums/openaiReasoning.js'
import { CLAUDE_CODE_GUIDE_AGENT } from '../tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'
import { EXPLORE_AGENT } from '../tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from '../tools/AgentTool/built-in/planAgent.js'

// Provider isolation. The Claude-family recommendation + "Fast mode" env lines
// are gated on getAPIProvider() === 'firstParty'. A cross-file mock.module leak
// (or a stale activeProvider cache) that leaves a non-firstParty provider
// active silently drops those lines and fails the assertions below. Pin
// getActiveProviderProfile to undefined (→ firstParty) and drop the cache
// before each test so this file is immune to whatever ran before it.
const realProviderProfiles = { ...(await import('../utils/providerProfiles.js')) }
mock.module('../utils/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => undefined,
}))
const { invalidateActiveProviderCache } = await import(
  '../services/api/activeProvider.js'
)

const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE

beforeEach(() => {
  // Re-assert our mock so it wins over any later-loaded file's mock, and clear
  // the cached provider so getAPIProvider() recomputes as firstParty.
  mock.module('../utils/providerProfiles.js', () => ({
    ...realProviderProfiles,
    getActiveProviderProfile: () => undefined,
  }))
  invalidateActiveProviderCache()
})

afterEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  invalidateActiveProviderCache()
  clearSystemPromptSections()
})

afterAll(() => {
  mock.module('../utils/providerProfiles.js', () => realProviderProfiles)
  invalidateActiveProviderCache()
})

test('CLI identity prefixes describe Claudin instead of Claude Code', () => {
  expect(getCLISyspromptPrefix()).toContain('Claudin')
  expect(getCLISyspromptPrefix()).not.toContain('Claude Code')
  expect(getCLISyspromptPrefix()).not.toContain("Anthropic's official CLI for Claude")

  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    expect(prefix).toContain('Claudin')
    expect(prefix).not.toContain('Claude Code')
    expect(prefix).not.toContain("Anthropic's official CLI for Claude")
  }
})

test('simple mode identity describes Claudin instead of Claude Code', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'

  const prompt = await getSystemPrompt([], 'gpt-4o')

  expect(prompt[0]).toContain('Claudin')
  expect(prompt[0]).not.toContain('Claude Code')
  expect(prompt[0]).not.toContain("Anthropic's official CLI for Claude")
})

test('system prompt model identity updates when model changes mid-session', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  const firstPrompt = await getSystemPrompt([], 'old-test-model')
  const secondPrompt = await getSystemPrompt([], 'new-test-model')

  const firstText = firstPrompt.join('\n')
  const secondText = secondPrompt.join('\n')

  expect(firstText).toContain('You are powered by the model old-test-model.')
  expect(secondText).toContain('You are powered by the model new-test-model.')
  expect(secondText).not.toContain('You are powered by the model old-test-model.')
})

test('Claude model recommendations only ship for the anthropic family', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  // Test env has no provider profile → getAPIProvider() falls back to
  // 'firstParty', so family is decided by the model id alone here.
  const claudeText = (await getSystemPrompt([], 'claude-opus-4-8')).join('\n')
  clearSystemPromptSections()
  const otherText = (await getSystemPrompt([], 'gpt-4o')).join('\n')

  expect(claudeText).toContain('most capable Claude models')
  expect(claudeText).toContain('Fast mode for Claudin')
  expect(otherText).not.toContain('most capable Claude models')
  expect(otherText).not.toContain('Fast mode for Claudin')
})

test('Anthropic-family system prompt does not include any non-Anthropic family addendum', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  // In the test environment there is no active provider profile, so
  // getAPIProvider() falls back to 'firstParty'. A claude-* model on
  // firstParty MUST resolve to the 'anthropic' family, whose addendum is
  // null. We assert that none of the other families' content leaks into
  // the prompt — this protects Claude users from accidental regressions.
  const prompt = await getSystemPrompt([], 'claude-opus-4-8')
  const text = prompt.join('\n')

  const sentinels = [
    // First non-empty bullet of each non-Anthropic addendum
    GEMINI_ADDENDUM.split('\n').find(l => l.startsWith('- ')) ?? '',
    GLM_ADDENDUM.split('\n').find(l => l.startsWith('- ')) ?? '',
    KIMI_ADDENDUM.split('\n').find(l => l.startsWith('- ')) ?? '',
    OPENAI_REASONING_ADDENDUM.split('\n').find(l => l.startsWith('- ')) ?? '',
  ]

  for (const sentinel of sentinels) {
    expect(sentinel.length).toBeGreaterThan(20)
    expect(text).not.toContain(sentinel)
  }
})

test('built-in agent prompts describe Claudin instead of Claude Code', () => {
  expect(DEFAULT_AGENT_PROMPT).toContain('Claudin')
  expect(DEFAULT_AGENT_PROMPT).not.toContain('Claude Code')
  expect(DEFAULT_AGENT_PROMPT).not.toContain("Anthropic's official CLI for Claude")

  const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(generalPrompt).toContain('Claudin')
  expect(generalPrompt).not.toContain('Claude Code')
  expect(generalPrompt).not.toContain("Anthropic's official CLI for Claude")

  const explorePrompt = EXPLORE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(explorePrompt).toContain('Claudin')
  expect(explorePrompt).not.toContain('Claude Code')
  expect(explorePrompt).not.toContain("Anthropic's official CLI for Claude")

  const planPrompt = PLAN_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(planPrompt).toContain('Claudin')
  expect(planPrompt).not.toContain('Claude Code')

  const guidePrompt = CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
      } as never,
    },
  })
  expect(guidePrompt).toContain('Claudin')
  expect(guidePrompt).toContain('You are the Claudin guide agent.')
  expect(guidePrompt).toContain('**Claudin** (the CLI tool)')
  expect(guidePrompt).not.toContain('You are the Claude guide agent.')
})
