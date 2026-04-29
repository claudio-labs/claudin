import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
  suppressNextBashGitInstructions,
} from './attachments.js'
import type { ToolUseContext } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'

// Build the smallest ToolUseContext shape getBashGitInstructionsAttachment
// touches. Anything outside of `options.tools` and `agentId` is ignored by
// this code path, so we cast through unknown to keep the surface area tiny.
function makeContext(
  toolNames: string[],
  agentId?: string,
): ToolUseContext {
  return {
    agentId,
    options: {
      tools: toolNames.map(name => ({ name })),
    },
  } as unknown as ToolUseContext
}

describe('getBashGitInstructionsAttachment', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalInject = process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
  const originalDisable = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalUserType = process.env.USER_TYPE

  beforeEach(() => {
    // Bypass the NODE_ENV=test early return so we exercise the real branches.
    process.env.NODE_ENV = 'production'
    delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = 'false'
    delete process.env.USER_TYPE
    if (!process.env.ANTHROPIC_API_KEY) {
      // Non-key-shaped value avoids tripping secret-scanners on this file.
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
    // Module-scope set tracks per-agent emission; clear between tests so
    // ordering doesn't matter and "first call returns the body" stays true.
    resetSentBashGitInstructions()
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalInject === undefined) {
      delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = originalInject
    }
    if (originalDisable === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
    } else {
      process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = originalDisable
    }
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
  })

  it('returns [] when NODE_ENV is test', async () => {
    process.env.NODE_ENV = 'test'
    const result = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    expect(result).toEqual([])
  })

  it('returns [] when injection is disabled via env', async () => {
    process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = 'false'
    const result = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    expect(result).toEqual([])
  })

  it('returns [] when Bash tool is absent from the context tools', async () => {
    const result = await getBashGitInstructionsAttachment(
      makeContext(['Read', 'Edit']),
    )
    expect(result).toEqual([])
  })

  it('returns [] when git instructions are disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = 'true'
    const result = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    expect(result).toEqual([])
  })

  it('returns one bash_git_instructions attachment when all conditions are met', async () => {
    const result = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'bash_git_instructions',
    })
    // Anchor against silent regression: a future refactor that breaks
    // getBashGitInstructionsBody() into emptiness would slip past a bare
    // length>0 check. The body is the external git/PR protocol — these
    // anchor strings live in BashTool/prompt.ts and would change loudly.
    const content = (
      result[0] as { type: 'bash_git_instructions'; content: string }
    ).content
    expect(content.length).toBeGreaterThan(1000)
    expect(content).toMatch(/# Committing changes with git|# Git operations/)
  })

  it('emits the attachment exactly once per agent across the agentic loop', async () => {
    const ctx = makeContext([BASH_TOOL_NAME])
    const first = await getBashGitInstructionsAttachment(ctx)
    const second = await getBashGitInstructionsAttachment(ctx)
    const third = await getBashGitInstructionsAttachment(ctx)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(third).toEqual([])
  })

  it('tracks emission state per agentId so subagents get their own copy', async () => {
    const main = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    const subagentA = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME], 'subagent-a'),
    )
    const subagentAAgain = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME], 'subagent-a'),
    )
    const subagentB = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME], 'subagent-b'),
    )
    expect(main).toHaveLength(1)
    expect(subagentA).toHaveLength(1)
    expect(subagentAAgain).toEqual([])
    expect(subagentB).toHaveLength(1)
  })

  it('re-emits after resetSentBashGitInstructions()', async () => {
    const ctx = makeContext([BASH_TOOL_NAME])
    const first = await getBashGitInstructionsAttachment(ctx)
    const second = await getBashGitInstructionsAttachment(ctx)
    resetSentBashGitInstructions()
    const third = await getBashGitInstructionsAttachment(ctx)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(third).toHaveLength(1)
  })

  it('suppresses the next emission when the resume latch is armed', async () => {
    const ctx = makeContext([BASH_TOOL_NAME])
    suppressNextBashGitInstructions()
    const first = await getBashGitInstructionsAttachment(ctx)
    // Latch consumed; subsequent calls also dedupe via the sent set.
    const second = await getBashGitInstructionsAttachment(ctx)
    expect(first).toEqual([])
    expect(second).toEqual([])
  })

  it('suppress latch is per-process, not per-agent (consumed on first emission attempt)', async () => {
    suppressNextBashGitInstructions()
    const main = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME]),
    )
    // Second agent gets the regular emission — the latch was one-shot.
    const subagent = await getBashGitInstructionsAttachment(
      makeContext([BASH_TOOL_NAME], 'subagent-x'),
    )
    expect(main).toEqual([])
    expect(subagent).toHaveLength(1)
  })

  it('reset clears both the sent set and the suppress latch', async () => {
    const ctx = makeContext([BASH_TOOL_NAME])
    suppressNextBashGitInstructions()
    resetSentBashGitInstructions()
    // Latch should be cleared by reset, so the next call emits.
    const result = await getBashGitInstructionsAttachment(ctx)
    expect(result).toHaveLength(1)
  })
})
