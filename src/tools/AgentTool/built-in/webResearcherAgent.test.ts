import { describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from 'src/tools/AgentTool/constants.js'
import {
  WEB_RESEARCHER_AGENT,
  WEB_RESEARCHER_AGENT_TYPE,
} from 'src/tools/AgentTool/built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT } from 'src/tools/AgentTool/built-in/webResearcherManagerAgent.js'

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

  test('skips the commit/PR protocol — both web agents never commit', () => {
    expect(WEB_RESEARCHER_AGENT.omitGitInstructions).toBe(true)
    expect(WEB_RESEARCHER_MANAGER_AGENT.omitGitInstructions).toBe(true)
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

describe('WebResearcher descriptions — the "Do NOT use for" clause survives the lean cut', () => {
  // Each description rides the agent listing on every request with the Agent
  // tool. CLAUDIN_LEAN_AGENT_PROMPT swaps in `whenToUseLean`, about half the
  // length; what may not go is when to use each, and the exclusions — the
  // clause that keeps a question about the local repo away from a web agent.
  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex')
  const cases = [
    {
      agent: WEB_RESEARCHER_AGENT,
      use: ['multi-page', `3+ ${WEB_FETCH_TOOL_NAME}/${WEB_SEARCH_TOOL_NAME}`],
      exclusions: [WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME, 'local repo'],
    },
    {
      agent: WEB_RESEARCHER_MANAGER_AGENT,
      use: ['multi-angle', 'fact-checking', WEB_RESEARCHER_AGENT_TYPE],
      exclusions: [
        WEB_RESEARCHER_AGENT_TYPE,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
        'local repo',
      ],
    },
  ]

  for (const { agent, use, exclusions } of cases) {
    test(`${agent.agentType}: both texts say when to use it and what not to use it for`, () => {
      expect(agent.whenToUseLean).toBeDefined()
      for (const text of [agent.whenToUse, agent.whenToUseLean ?? '']) {
        for (const needle of use) {
          expect(text.toLowerCase()).toContain(needle.toLowerCase())
        }
        const clause = text.slice(text.indexOf('**Do NOT use for**'))
        expect(clause.length).toBeLessThan(text.length)
        for (const needle of exclusions) expect(clause).toContain(needle)
      }
    })

    test(`${agent.agentType}: the lean text is about half the default`, () => {
      expect(agent.whenToUseLean?.length ?? Infinity).toBeLessThanOrEqual(
        agent.whenToUse.length * 0.55,
      )
    })
  }

  test('the default texts are byte-identical to what shipped', () => {
    // Captured before the lean arm existed (2026-09-23).
    expect(sha256(WEB_RESEARCHER_AGENT.whenToUse)).toBe(
      '19d3b97875b0ba23c29fd6105a4228ecfc533e19f2118ab8342f09dcd793d186',
    )
    expect(sha256(WEB_RESEARCHER_MANAGER_AGENT.whenToUse)).toBe(
      '4bca006729e835c3ffc96dd31162050d6ddfa4e97016233e16376a9f1e41f252',
    )
  })
})
