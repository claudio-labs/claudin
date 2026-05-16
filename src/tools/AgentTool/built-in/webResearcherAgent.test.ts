import { describe, expect, test } from 'bun:test'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from '../constants.js'
import {
  WEB_RESEARCHER_AGENT,
  WEB_RESEARCHER_AGENT_TYPE,
} from './webResearcherAgent.js'

// The WebResearcher's getSystemPrompt is a static, context-independent string —
// it never reads its argument. We type the stub via the function's own parameter
// type so this stays valid if the signature ever changes.
type SystemPromptArg = Parameters<
  typeof WEB_RESEARCHER_AGENT.getSystemPrompt
>[0]
const PROMPT_STUB_ARG = {} as SystemPromptArg

describe('WEB_RESEARCHER_AGENT', () => {
  test('agentType is the stable identifier "WebResearcher"', () => {
    expect(WEB_RESEARCHER_AGENT_TYPE).toBe('WebResearcher')
    expect(WEB_RESEARCHER_AGENT.agentType).toBe('WebResearcher')
  })

  test('allowlist is exactly [WebSearch, WebFetch] — no Bash/Read/Edit/Write leak', () => {
    expect(WEB_RESEARCHER_AGENT.tools).toEqual([
      WEB_SEARCH_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
    ])
  })

  test('uses allowlist (tools), not denylist (disallowedTools)', () => {
    expect(WEB_RESEARCHER_AGENT.disallowedTools).toBeUndefined()
  })

  test('uses haiku model for cheap/fast research', () => {
    expect(WEB_RESEARCHER_AGENT.model).toBe('haiku')
  })

  test('skips CLAUDE.md — research does not need commit/lint rules', () => {
    expect(WEB_RESEARCHER_AGENT.omitClaudeMd).toBe(true)
  })

  test('skips gitStatus — web research never touches local repo', () => {
    expect(WEB_RESEARCHER_AGENT.omitGitStatus).toBe(true)
  })

  test('is registered as one-shot so parent skips SendMessage trailer', () => {
    expect(ONE_SHOT_BUILTIN_AGENT_TYPES.has(WEB_RESEARCHER_AGENT_TYPE)).toBe(
      true,
    )
  })

  test('source/baseDir mark it as built-in', () => {
    expect(WEB_RESEARCHER_AGENT.source).toBe('built-in')
    expect(WEB_RESEARCHER_AGENT.baseDir).toBe('built-in')
  })

  test('whenToUse describes multi-page research and steers away from single fetches', () => {
    const text = WEB_RESEARCHER_AGENT.whenToUse
    expect(text).toContain('multi-page')
    expect(text).toContain(WEB_FETCH_TOOL_NAME)
    expect(text).toContain(WEB_SEARCH_TOOL_NAME)
    expect(text).toContain('Do NOT use')
  })

  test('system prompt mentions WebSearch, WebFetch and citation rule', () => {
    const prompt = WEB_RESEARCHER_AGENT.getSystemPrompt(PROMPT_STUB_ARG)
    expect(prompt.length).toBeGreaterThan(200)
    expect(prompt).toContain(WEB_SEARCH_TOOL_NAME)
    expect(prompt).toContain(WEB_FETCH_TOOL_NAME)
    expect(prompt.toLowerCase()).toContain('cite')
  })

  test('system prompt forbids local file access and shell', () => {
    const prompt = WEB_RESEARCHER_AGENT.getSystemPrompt(PROMPT_STUB_ARG)
    expect(prompt).toContain('NO access')
    expect(prompt).toMatch(/no Bash|No Bash/)
  })
})
