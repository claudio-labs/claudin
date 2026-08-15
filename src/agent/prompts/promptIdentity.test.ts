import { afterEach, expect, test } from 'bun:test'

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

import { clearSystemPromptSections } from 'src/agent/prompts/systemPromptSections.js'
import {
  ACT_ON_WHAT_YOU_KNOW_SECTION,
  CORRECTIONS_SECTION,
  DEFAULT_AGENT_PROMPT,
  DELIVERING_WORK_SECTION,
  PRONOUNS_SECTION,
  getSystemPrompt,
} from 'src/agent/prompts/prompts.js'
import { CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } from 'src/agent/prompts/system.js'
import { GEMINI_ADDENDUM } from 'src/agent/prompts/familyAddendums/gemini.js'
import { GLM_ADDENDUM } from 'src/agent/prompts/familyAddendums/glm.js'
import { KIMI_ADDENDUM } from 'src/agent/prompts/familyAddendums/kimi.js'
import { OPENAI_REASONING_ADDENDUM } from 'src/agent/prompts/familyAddendums/openaiReasoning.js'
import { CLAUDE_CODE_GUIDE_AGENT } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'

// Provider isolation — and why this file no longer pins one.
//
// The Claude-family recommendation + "Fast mode" env lines are gated on
// getAPIProvider() === 'firstParty', so this file used to mock.module
// 'src/utils/model/providers.js' to 'firstParty' before every test, on the
// theory that doing so would win over whatever leaked from a file that ran
// earlier.
//
// It does not win. Bun keys mock.module by SPECIFIER for the whole run, and the
// first file to register a factory for a specifier owns it — a later
// mock.module on the same specifier from another file is ignored, even by a
// consumer re-imported with a cache-busting query string. So the pin could
// never defend against a leak; all it did was make this file the aggressor,
// forcing 'firstParty' onto every other file reaching providers.js (measured:
// it took out 4 assertions in src/providers/transport/withRetry.test.ts as soon as
// both sides resolved to the same specifier).
//
// With no provider profile configured, getAPIProvider() returns 'firstParty' on
// its own, which is exactly the environment these tests want.
const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE

afterEach(() => {
  // `process.env.X = undefined` stores the STRING "undefined", which is truthy —
  // it would leave simple mode on for every file that runs after this one.
  if (originalSimpleEnv === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  clearSystemPromptSections()
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

test('the system prompt opens by naming Claudin', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  const [intro] = await getSystemPrompt([], 'claude-opus-4-8')

  // First block, not merely somewhere in the prompt: the point of the line
  // is that identity arrives before anything else, and the env section (the
  // only other place that names the product) is provider-conditional.
  expect(intro).toContain('You are Claudin, an open-source coding agent and CLI.')
  expect(intro).not.toContain('Claude Code')
  // Same wording as DEFAULT_AGENT_PROMPT, asserted below — a subagent that
  // reads a different identity than its parent has to reconcile the two.
  expect(DEFAULT_AGENT_PROMPT).toContain('Claudin, an open-source coding agent and CLI')
})

test('the pronoun default ships regardless of the WORK_CONTRACT gate', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  // The test preload stubs feature() to false, so this render is the
  // WORK_CONTRACT-off path — exactly the A/B configuration in which the
  // pronoun rule must still be present while the gated sections are not.
  const text = (await getSystemPrompt([], 'claude-opus-4-8')).join('\n')

  expect(text).toContain(PRONOUNS_SECTION)
  expect(text).not.toContain(DELIVERING_WORK_SECTION)
  expect(text).not.toContain(CORRECTIONS_SECTION)
  expect(text).not.toContain(ACT_ON_WHAT_YOU_KNOW_SECTION)
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
