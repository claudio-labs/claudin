// The AgentDefinition.omitGitInstructions skip in
// getBashGitInstructionsAttachment, and the createSubagentContext inheritance
// that carries it into a runForkedAgent fork (the 30s background summary) —
// the one child of an agent that runAgent does not configure itself.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
  suppressNextBashGitInstructions,
} from 'src/agent/attachments/skill-bash-gates.js'
import { createSubagentContext } from 'src/agent/coordinator/forkedAgent.js'
import { enableConfigs } from 'src/platform/config/config.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const PINNED_ENV = [
  'NODE_ENV',
  'CLAUDIN_BASH_GIT_IN_MESSAGES',
  'CLAUDIN_DISABLE_GIT_INSTRUCTIONS',
  'ANTHROPIC_API_KEY',
  'USER_TYPE',
] as const

// Every field createSubagentContext reads from its parent, plus the two the
// producer reads (options.tools, agentId). A Bash tool is present, so the
// omission is the only gate left that can say no.
function makeAgentContext(
  fields: Partial<ToolUseContext> = {},
): ToolUseContext {
  return {
    agentId: 'agent-under-test',
    options: { tools: [{ name: BASH_TOOL_NAME }] },
    readFileState: createFileStateCacheWithSizeLimit(10),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: { shouldAvoidPermissionPrompts: true },
    }),
    setAppState: () => {},
    setResponseLength: () => {},
    updateAttributionState: () => {},
    messages: [],
    ...fields,
  } as unknown as ToolUseContext
}

describe('getBashGitInstructionsAttachment — omitGitInstructionsAttachments', () => {
  const saved: Partial<Record<(typeof PINNED_ENV)[number], string>> = {}

  beforeEach(() => {
    for (const key of PINNED_ENV) saved[key] = process.env[key]
    // Leave the NODE_ENV=test early return so the real gates run.
    process.env.NODE_ENV = 'production'
    enableConfigs()
    delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'
    delete process.env.USER_TYPE
    // getAttributionTexts() resolves settings, which wants a key; this one is
    // deliberately not key-shaped.
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
    resetSentBashGitInstructions()
  })

  afterEach(() => {
    for (const key of PINNED_ENV) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSentBashGitInstructions()
  })

  test('an agent that never commits gets no bash_git_instructions', async () => {
    const result = await getBashGitInstructionsAttachment(
      makeAgentContext({ omitGitInstructionsAttachments: true }),
    )
    expect(result).toEqual([])
  })

  test('without the omission the attachment is still produced', async () => {
    for (const omit of [undefined, false]) {
      resetSentBashGitInstructions()
      const result = await getBashGitInstructionsAttachment(
        makeAgentContext({ omitGitInstructionsAttachments: omit }),
      )
      expect({ omit, types: result.map(a => a.type) }).toEqual({
        omit,
        types: ['bash_git_instructions'],
      })
    }
  })

  test('the omission leaves the resume latch to the agent that owns it', async () => {
    // A resumed main thread already holds the block in its transcript, so the
    // latch must suppress ITS next emission. An omitting agent reaching the
    // producer first must not spend it, or the main thread is sent the block
    // a second time.
    suppressNextBashGitInstructions()
    expect(
      await getBashGitInstructionsAttachment(
        makeAgentContext({
          agentId: 'read-only' as ToolUseContext['agentId'],
          omitGitInstructionsAttachments: true,
        }),
      ),
    ).toEqual([])
    expect(
      await getBashGitInstructionsAttachment(
        makeAgentContext({ agentId: undefined }),
      ),
    ).toEqual([])
    // Spent there: the next agent gets its regular copy.
    expect(
      await getBashGitInstructionsAttachment(
        makeAgentContext({ agentId: 'code' as ToolUseContext['agentId'] }),
      ),
    ).toHaveLength(1)
  })

  test('a fork of an agent that never commits inherits the omission', async () => {
    // runForkedAgent → createSubagentContext(agentContext, overrides) with no
    // word on this field, and a fresh agentId, so nothing else stops the fork
    // from receiving the block its parent's transcript never had.
    const agent = makeAgentContext({ omitGitInstructionsAttachments: true })
    const fork = createSubagentContext(agent)
    expect(fork.agentId).not.toBe(agent.agentId)
    expect(fork.omitGitInstructionsAttachments).toBe(true)
    expect(await getBashGitInstructionsAttachment(fork)).toEqual([])
  })

  test('an explicit override wins over the parent, as runAgent passes one per agent', async () => {
    const omitting = createSubagentContext(makeAgentContext(), {
      omitGitInstructionsAttachments: true,
    })
    expect(await getBashGitInstructionsAttachment(omitting)).toEqual([])

    // `false` is a value, not an absence: an agent whose own definition does
    // not omit gets the block even when spawned by one that does.
    const committing = createSubagentContext(
      makeAgentContext({ omitGitInstructionsAttachments: true }),
      { omitGitInstructionsAttachments: false },
    )
    expect(committing.omitGitInstructionsAttachments).toBe(false)
    expect(await getBashGitInstructionsAttachment(committing)).toHaveLength(1)
  })
})
