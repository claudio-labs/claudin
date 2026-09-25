import { describe, expect, test } from 'bun:test'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import {
  EXPLORE_AGENT,
  EXPLORE_AGENT_TYPE,
} from 'src/tools/AgentTool/built-in/exploreAgent.js'

const PARAMS = { toolUseContext: { options: {} as never } }

// The report is what the parent edits from: an excerpt becomes a Patch hunk's
// context or an Edit's old_string, copied as-is. On 2026-08-16, with an
// earlier form of this contract, 29.4% of Explore calls were followed by a
// FULL re-read of a file the report covered, and the removal-era session that
// re-read 17 of 35 files was the summarizer outlining the report, not the
// agent (.claudin/memory/team/decisions/explore-agent-removed.md).
describe('Explore output contract', () => {
  const prompt = EXPLORE_AGENT.getSystemPrompt(PARAMS)

  test('anchors every finding on a full absolute path and the excerpt range', () => {
    // Patch and Edit take absolute paths. "Very thorough" E2E reports listed
    // 50 sites relative to a base named once, then shortened it to
    // `/tmp/.../repo/`, and labelled 19 of 50 excerpts with the enclosing
    // function's range while quoting only its first lines.
    expect(prompt).toContain('## Required Output')
    expect(prompt).toContain('`path:start-end` anchor: the full absolute path — never shortened with `...`')
    expect(prompt).toContain('A relative or shortened path, or a path with no line numbers, is an incomplete finding')
    expect(prompt).toContain('the excerpt itself, not of the function or class it sits in')
  })

  test('an overflow list still quotes each line verbatim', () => {
    expect(prompt).toContain(
      'list the rest one per line as an absolute `path:line` followed by that single line quoted verbatim in backticks',
    )
  })

  test('says the excerpt feeds Patch and Edit, so it must be copied whole', () => {
    expect(prompt).toContain(`${APPLY_PATCH_TOOL_NAME} hunk`)
    expect(prompt).toContain(`old_string of an ${FILE_EDIT_TOOL_NAME}`)
    expect(prompt).toContain('VERBATIM')
    expect(prompt).toContain('never paraphrased')
    expect(prompt).toContain('whole lines')
    expect(prompt).toContain('tabs stay tabs')
  })

  test('forbids the Read line-number prefix and elision inside an excerpt', () => {
    expect(prompt).toContain('line-number prefix')
    expect(prompt).toContain('never put `...` inside an excerpt')
  })

  test('bounds the excerpts and the report', () => {
    // The agent's value is compression (13.2x median in 2026-08); "quote
    // verbatim" without a bound would undo it, and the summarizer no longer
    // cuts this report.
    expect(prompt).toContain('minimum that supports the finding')
    expect(prompt).toContain('8,000 characters')
    expect(prompt).toContain('20,000')
  })

  test('demands an explicit not-found section', () => {
    expect(prompt).toContain('## Not found / not checked')
  })

  test('names the three thoroughness levels it adapts to', () => {
    for (const level of ['"quick"', '"medium"', '"very thorough"']) {
      expect(prompt).toContain(level)
    }
  })
})

describe('EXPLORE_AGENT definition', () => {
  test('is registered under the Explore type', () => {
    expect(EXPLORE_AGENT.agentType).toBe(EXPLORE_AGENT_TYPE)
    expect(EXPLORE_AGENT.source).toBe('built-in')
  })

  test('allowlists exactly the search, read, shell and web tools', () => {
    expect([...(EXPLORE_AGENT.tools ?? [])].sort()).toEqual(
      [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        BASH_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ].sort(),
    )
  })

  test('defaults to sonnet', () => {
    expect(EXPLORE_AGENT.model).toBe('sonnet')
  })

  test('drops the context a read-only brief does not need', () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true)
    expect(EXPLORE_AGENT.omitGitStatus).toBe(true)
    expect(EXPLORE_AGENT.omitGitInstructions).toBe(true)
  })
})

describe('EXPLORE_AGENT.whenToUse', () => {
  const { whenToUse } = EXPLORE_AGENT

  test('advertises the multi-hop case and the excerpt contract', () => {
    expect(whenToUse).toContain('dependent searches')
    expect(whenToUse).toContain('`path:start-end`')
    expect(whenToUse).toContain('verbatim')
  })

  test('sends a directed lookup back to a direct search', () => {
    // 0 of 77 organic calls in 2026-08 were LOCATE-SYMBOL or READ-ONE-THING.
    expect(whenToUse).toContain('search directly instead')
  })

  test('lists the thoroughness levels callers pass', () => {
    for (const level of ['quick', 'medium', 'very thorough']) {
      expect(whenToUse).toContain(level)
    }
  })
})
