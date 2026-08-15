import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  getAttachments,
  getAttachmentMessages,
  getQueuedCommandAttachments,
} from 'src/agent/attachments/attachments.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'

// The claude_md_delta attachment reads getUserContext().claudeMd, which is
// discovered from the cwd's CLAUDE.md/AGENTS.md. That doc is present in a dev
// checkout but absent on a fresh CI clone (AGENTS.md is git-ignored), so the
// "delta must fire" control tests below would flake on the environment rather
// than the omit gate they mean to exercise. Pin a non-empty project doc via a
// scoped getUserContext mock so the gate is what's under test, not the repo.
const realContext = { ...(await import('src/agent/context.js')) }
const HERMETIC_CLAUDE_MD = '# Test project doc\nHermetic claude_md content.\n'

// Minimal context skeleton — the disabled path uses none of these fields,
// they exist to satisfy the type at the call site.
function makeContext(): ToolUseContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({ toolPermissionContext: {}, mcp: { commands: [] } }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

function makeQueuedCommand(value: string, uuid?: string): QueuedCommand {
  return {
    value,
    mode: 'prompt',
    uuid: uuid as QueuedCommand['uuid'],
  } as QueuedCommand
}

describe('getAttachments — disabled-attachments early-exit', () => {
  const originalDisable = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  const originalSimple = process.env.CLAUDE_CODE_SIMPLE

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    delete process.env.CLAUDE_CODE_SIMPLE
  })

  afterEach(() => {
    if (originalDisable === undefined)
      delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    else process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = originalDisable
    if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = originalSimple
  })

  test('CLAUDE_CODE_DISABLE_ATTACHMENTS=1: only queued commands are returned', async () => {
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
    const queued = [
      makeQueuedCommand('hello', 'uuid-1'),
      makeQueuedCommand('world', 'uuid-2'),
    ]
    const out = await getAttachments(null, makeContext(), null, queued)
    expect(out).toHaveLength(2)
    expect(out.every(a => a.type === 'queued_command')).toBe(true)
  })

  test('CLAUDE_CODE_SIMPLE=1: same early-exit as disable flag', async () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'
    const queued = [makeQueuedCommand('hi', 'uuid-3')]
    const out = await getAttachments(null, makeContext(), null, queued)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('queued_command')
  })

  test('disabled + empty queue: returns []', async () => {
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
    const out = await getAttachments(null, makeContext(), null, [])
    expect(out).toEqual([])
  })
})

describe('getAttachments — subagent context-omission gates', () => {
  // runAgent mirrors AgentDefinition.omitClaudeMd/omitGitStatus onto the
  // subagent's ToolUseContext; the pipeline must honor them so the global
  // CLAUDE.md/rules/memory/gitStatus content isn't re-injected into agents
  // that deliberately stripped it (Explore, Plan, WebResearcher).
  beforeEach(() => {
    // Same env hygiene as the block above. Either of these turns getAttachments
    // into an early return, and both are process-global — a sibling file that
    // restores CLAUDE_CODE_SIMPLE by assigning an undefined variable leaves the
    // literal string "undefined" behind, which is truthy.
    delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    delete process.env.CLAUDE_CODE_SIMPLE
    mock.module('src/agent/context.js', () => ({
      ...realContext,
      getUserContext: async () => ({ claudeMd: HERMETIC_CLAUDE_MD }),
    }))
  })

  afterAll(() => {
    // mock.module is process-global and mock.restore() does not revert it;
    // re-install the real module so the stub never bleeds into sibling files.
    mock.module('src/agent/context.js', () => realContext)
  })

  function makeSubagentContext(
    omitClaudeMd: boolean,
    omitGitStatus: boolean = omitClaudeMd,
  ): ToolUseContext {
    return {
      ...makeContext(),
      agentId: 'agent-omit-test',
      agentType: 'Explore',
      omitClaudeMdAttachments: omitClaudeMd,
      omitGitStatusAttachments: omitGitStatus,
    } as unknown as ToolUseContext
  }

  test('omit flags suppress claude_md_delta / nested_memory / git_status_delta', async () => {
    const out = await getAttachments(null, makeSubagentContext(true), null, [])
    const types = out.map(a => a.type)
    expect(types).not.toContain('claude_md_delta')
    expect(types).not.toContain('nested_memory')
    expect(types).not.toContain('git_status_delta')
  })

  test('control: without omit flags the subagent still gets claude_md_delta', async () => {
    // This repo has a CLAUDE.md, so the initial delta must fire — proving
    // the gate (not the environment) is what removed it above.
    const out = await getAttachments(null, makeSubagentContext(false), null, [])
    expect(out.map(a => a.type)).toContain('claude_md_delta')
  })

  test('flags are independent: omitGitStatus alone must not suppress claude_md_delta', async () => {
    // Catches a transposition of the two flag reads in pipeline.ts — agents
    // like WebResearcherManager could set one flag without the other, and the
    // paired tests above cannot distinguish claudeMd↔gitStatus swaps.
    const out = await getAttachments(
      null,
      makeSubagentContext(false, true),
      null,
      [],
    )
    expect(out.map(a => a.type)).toContain('claude_md_delta')
  })
})

describe('getQueuedCommandAttachments — direct producer', () => {
  test('returns [] for empty queue', async () => {
    expect(await getQueuedCommandAttachments([])).toEqual([])
  })

  test('filters out non-inline modes (only prompt + task-notification)', async () => {
    const queue: QueuedCommand[] = [
      { value: 'p', mode: 'prompt' } as QueuedCommand,
      { value: 't', mode: 'task-notification' } as QueuedCommand,
      { value: 'i', mode: 'instruction' as unknown as string } as QueuedCommand,
    ]
    const out = await getQueuedCommandAttachments(queue)
    expect(out).toHaveLength(2)
  })

  test('preserves uuid and commandMode on each attachment', async () => {
    const queue: QueuedCommand[] = [
      makeQueuedCommand('hello', 'abc'),
      { value: 'world', mode: 'task-notification', uuid: 'xyz' } as unknown as QueuedCommand,
    ]
    const out = await getQueuedCommandAttachments(queue)
    expect(out[0]).toMatchObject({
      type: 'queued_command',
      source_uuid: 'abc',
      commandMode: 'prompt',
    })
    expect(out[1]).toMatchObject({
      type: 'queued_command',
      source_uuid: 'xyz',
      commandMode: 'task-notification',
    })
  })
})

describe('getAttachmentMessages — generator wraps each attachment with createAttachmentMessage', () => {
  const originalDisable = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS

  beforeEach(() => {
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  })

  afterEach(() => {
    if (originalDisable === undefined)
      delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    else process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = originalDisable
  })

  async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
    const out: T[] = []
    for await (const item of gen) out.push(item)
    return out
  }

  test('preserves input order across multiple queued commands', async () => {
    const queue = [
      makeQueuedCommand('first', 'u1'),
      makeQueuedCommand('second', 'u2'),
      makeQueuedCommand('third', 'u3'),
    ]
    const messages = await collect(
      getAttachmentMessages(null, makeContext(), null, queue),
    )
    expect(messages).toHaveLength(3)
    expect(messages.map(m => (m.attachment as { source_uuid?: string }).source_uuid)).toEqual([
      'u1',
      'u2',
      'u3',
    ])
    for (const m of messages) {
      expect(m.type).toBe('attachment')
      expect(typeof m.uuid).toBe('string')
      expect(typeof m.timestamp).toBe('string')
    }
  })

  test('yields nothing when there is nothing to attach', async () => {
    const messages = await collect(
      getAttachmentMessages(null, makeContext(), null, []),
    )
    expect(messages).toEqual([])
  })
})
