import { describe, expect, test } from 'bun:test'

import {
  aggregate,
  isNoopCommand,
  parseLines,
  tallySession,
  type TranscriptLine,
} from './measure-noop-tool-calls.ts'

describe('isNoopCommand', () => {
  for (const command of ['true', ':', 'true # comment', '  true  ', '\t:\t', ': # noop']) {
    test(`${JSON.stringify(command)} is a no-op`, () => {
      expect(isNoopCommand(command)).toBe(true)
    })
  }

  // The rate this script exists to move is "round-trips spent on nothing".
  // A command that also does real work is not one, however trivial it looks.
  for (const command of [
    'true && ls',
    'ls',
    'echo hi',
    '[ -f x ]',
    'truect',
    'sudo true',
    'true; rm -rf /',
    '',
  ]) {
    test(`${JSON.stringify(command)} is not a no-op`, () => {
      expect(isNoopCommand(command)).toBe(false)
    })
  }
})

/** One assistant message with a tool_use, as the transcript records it. */
function assistant(
  id: string,
  blocks: Array<{ name: string; input?: Record<string, unknown> }>,
  usage?: { cache_read_input_tokens?: number; thinking?: number },
): TranscriptLine {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    message: {
      id,
      model: 'claude-sonnet-5',
      content: blocks.map(b => ({
        type: 'tool_use',
        name: b.name,
        input: b.input ?? {},
      })),
      usage: {
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        output_tokens_details: { thinking_tokens: usage?.thinking ?? 0 },
      },
    },
  }
}

function user(permissionMode?: string): TranscriptLine {
  return {
    type: 'user',
    uuid: `uuid-user-${permissionMode ?? 'none'}`,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    message: { content: 'go' },
  }
}

describe('tallySession', () => {
  test('counts no-ops, tool turns and the cache-read they burned', () => {
    const lines: TranscriptLine[] = [
      user('auto'),
      assistant('m1', [{ name: 'Grep', input: { pattern: 'x' } }]),
      assistant('m2', [{ name: 'Bash', input: { command: 'true' } }], {
        cache_read_input_tokens: 139_406,
        thinking: 376,
      }),
      assistant('m3', [{ name: 'Bash', input: { command: 'true && ls' } }]),
      assistant('m4', [{ name: 'Read', input: { file_path: 'a.ts' } }]),
    ]

    const tally = tallySession('sess', lines, null)
    expect(tally).not.toBeNull()
    expect(tally!.noops).toBe(1)
    expect(tally!.toolTurns).toBe(4)
    expect(tally!.cacheReadWasted).toBe(139_406)
    expect(tally!.thinkingOnNoops).toBe(376)
    expect(tally!.model).toBe('claude-sonnet-5')
  })

  test('a message split across lines counts as ONE tool turn and is charged once', () => {
    // The real transcripts split a streamed message: thinking on one line, the
    // tool_use on the next, both under the same message.id. Counting lines
    // would double-charge the cache read.
    const split: TranscriptLine = {
      type: 'assistant',
      uuid: 'uuid-m1-b',
      message: {
        id: 'm1',
        model: 'claude-sonnet-5',
        content: [{ type: 'thinking' }],
        usage: { cache_read_input_tokens: 1000 },
      },
    }
    const lines: TranscriptLine[] = [
      user('auto'),
      split,
      assistant('m1', [{ name: 'Bash', input: { command: 'true' } }], {
        cache_read_input_tokens: 1000,
      }),
      assistant('m1', [{ name: 'Bash', input: { command: 'true' } }], {
        cache_read_input_tokens: 1000,
      }),
    ]

    const tally = tallySession('sess', lines, null)!
    expect(tally.toolTurns).toBe(1)
    expect(tally.cacheReadWasted).toBe(1000)
    // Both blocks are real no-op CALLS even on one message — only the context
    // charge is per message.
    expect(tally.noops).toBe(2)
  })

  test('attributes a no-op to plan mode from the permissionMode of the last user entry', () => {
    const planLines: TranscriptLine[] = [
      user('plan'),
      assistant('m1', [{ name: 'Bash', input: { command: 'true' } }]),
    ]
    const autoLines: TranscriptLine[] = [
      user('auto'),
      assistant('m1', [{ name: 'Bash', input: { command: 'true' } }]),
    ]

    expect(tallySession('a', planLines, null)!.planNoops).toBe(1)
    expect(tallySession('b', autoLines, null)!.planNoops).toBe(0)
  })

  test('EnterPlanMode covers the window the permissionMode field cannot see', () => {
    // Entering plan mode mid-turn is invisible to permissionMode until the next
    // user message, so the tool call has to flip it — and ExitPlanMode back.
    const lines: TranscriptLine[] = [
      user('auto'),
      assistant('m1', [{ name: 'EnterPlanMode' }]),
      assistant('m2', [{ name: 'Bash', input: { command: 'true' } }]),
      assistant('m3', [{ name: 'ExitPlanMode' }]),
      assistant('m4', [{ name: 'Bash', input: { command: ':' } }]),
    ]

    const tally = tallySession('sess', lines, null)!
    expect(tally.noops).toBe(2)
    expect(tally.planNoops).toBe(1)
  })

  test('sidechain (sub-agent) lines are excluded', () => {
    const lines: TranscriptLine[] = [
      user('auto'),
      assistant('m1', [{ name: 'Grep', input: { pattern: 'x' } }]),
      { ...assistant('m2', [{ name: 'Bash', input: { command: 'true' } }]), isSidechain: true },
    ]
    const tally = tallySession('sess', lines, null)!
    expect(tally.noops).toBe(0)
    expect(tally.toolTurns).toBe(1)
  })

  test('model filter drops messages from other models', () => {
    const lines: TranscriptLine[] = [
      user('auto'),
      assistant('m1', [{ name: 'Bash', input: { command: 'true' } }]),
      {
        type: 'assistant',
        uuid: 'uuid-m2',
        message: {
          id: 'm2',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }],
        },
      },
    ]

    expect(tallySession('sess', lines, 'sonnet')!.noops).toBe(1)
    expect(tallySession('sess', lines, 'opus')!.noops).toBe(1)
    expect(tallySession('sess', lines, null)!.noops).toBe(2)
  })

  test('a session with no assistant message yields no row', () => {
    expect(tallySession('sess', [user('auto')], null)).toBeNull()
  })
})

describe('parseLines', () => {
  test('counts malformed lines instead of swallowing them', () => {
    const tally = { malformed: 0 }
    const lines = parseLines('{"type":"user"}\nnot json\n\n{"type":"assistant"}', tally)
    expect(lines).toHaveLength(2)
    expect(tally.malformed).toBe(1)
  })
})

describe('aggregate', () => {
  test('sums per model and sorts by no-ops', () => {
    const rows = aggregate([
      {
        sessionId: 'a',
        model: 'claude-sonnet-5',
        noops: 9,
        toolTurns: 186,
        cacheReadWasted: 1_033_325,
        thinkingOnNoops: 100,
        planNoops: 4,
      },
      {
        sessionId: 'b',
        model: 'claude-sonnet-5',
        noops: 1,
        toolTurns: 103,
        cacheReadWasted: 139_406,
        thinkingOnNoops: 376,
        planNoops: 0,
      },
      {
        sessionId: 'c',
        model: 'claude-opus-5',
        noops: 0,
        toolTurns: 50,
        cacheReadWasted: 0,
        thinkingOnNoops: 0,
        planNoops: 0,
      },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]!.model).toBe('claude-sonnet-5')
    expect(rows[0]!.noops).toBe(10)
    expect(rows[0]!.toolTurns).toBe(289)
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.cacheReadWasted).toBe(1_172_731)
    expect(rows[0]!.planNoops).toBe(4)
    expect(rows[1]!.model).toBe('claude-opus-5')
    expect(rows[1]!.noops).toBe(0)
  })
})
