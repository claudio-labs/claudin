import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clipForkHistory,
  forkClipKeepTurns,
  forkClipMinParentTokens,
  isForkClipHistoryEnabled,
  selectForkClipIds,
} from 'src/tools/AgentTool/forkSubagent.js'
import { isClipStubContent } from 'src/agent/compact/stableStubState.js'
import type { Message } from 'src/shared/types/message.js'

// Minimal message shapes: only the fields the selection and the rewrite read.
function assistant(
  toolUses: Array<{ id: string; name: string }>,
): Message {
  return {
    type: 'assistant',
    uuid: `a-${toolUses.map(t => t.id).join('-') || 'text'}`,
    timestamp: '2026-09-08T00:00:00.000Z',
    message: {
      id: 'msg',
      role: 'assistant',
      type: 'message',
      model: 'm',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: toolUses.map(t => ({
        type: 'tool_use' as const,
        id: t.id,
        name: t.name,
        input: {},
      })),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Message
}

function results(
  blocks: Array<{ id: string; content: unknown; is_error?: boolean }>,
): Message {
  return {
    type: 'user',
    uuid: `u-${blocks.map(b => b.id).join('-')}`,
    timestamp: '2026-09-08T00:00:00.000Z',
    message: {
      role: 'user',
      content: blocks.map(b => ({
        type: 'tool_result' as const,
        tool_use_id: b.id,
        content: b.content,
        ...(b.is_error ? { is_error: true } : {}),
      })),
    },
  } as unknown as Message
}

const big = 'x'.repeat(4000) // ~1000 tokens: well above the 100-token floor
const clearable = (name: string) => name === 'Read' || name === 'Bash'

/** turn N = assistant(tool_use tN) + user(tool_result tN) */
function turns(n: number, tool = 'Read'): Message[] {
  const out: Message[] = []
  for (let i = 1; i <= n; i++) {
    out.push(assistant([{ id: `t${i}`, name: tool }]))
    out.push(results([{ id: `t${i}`, content: big }]))
  }
  return out
}

describe('selectForkClipIds', () => {
  test('keeps the last N assistant turns and clips everything older', () => {
    const ids = selectForkClipIds(turns(6), 4, clearable)
    expect(ids).toEqual(['t1', 't2'])
  })

  test('a history shorter than the window clips nothing', () => {
    expect(selectForkClipIds(turns(3), 4, clearable)).toEqual([])
    expect(selectForkClipIds([], 4, clearable)).toEqual([])
  })

  test('only clearable tools are selected', () => {
    const messages: Message[] = [
      assistant([{ id: 'r', name: 'Read' }, { id: 'e', name: 'Edit' }]),
      results([
        { id: 'r', content: big },
        { id: 'e', content: big },
      ]),
      ...turns(4, 'Bash'),
    ]
    expect(selectForkClipIds(messages, 4, clearable)).toEqual(['r'])
  })

  test('skips errors, images, empty content, small results and existing stubs', () => {
    const messages: Message[] = [
      assistant([
        { id: 'err', name: 'Read' },
        { id: 'img', name: 'Read' },
        { id: 'empty', name: 'Read' },
        { id: 'small', name: 'Read' },
        { id: 'stub', name: 'Read' },
        { id: 'ok', name: 'Read' },
      ]),
      results([
        { id: 'err', content: big, is_error: true },
        { id: 'img', content: [{ type: 'image', source: {} }, { type: 'text', text: big }] },
        { id: 'empty', content: '' },
        { id: 'small', content: 'tiny' },
        { id: 'stub', content: '[clipped: ~900 tokens from Read]' },
        { id: 'ok', content: [{ type: 'text', text: big }] },
      ]),
      ...turns(4),
    ]
    expect(selectForkClipIds(messages, 4, clearable)).toEqual(['ok'])
  })
})

describe('clipForkHistory', () => {
  test('rewrites only the selected results, as new objects, leaving the input intact', () => {
    const messages = turns(3)
    const original = messages[1]!
    const originalContent = (original as { message: { content: unknown[] } })
      .message.content
    const out = clipForkHistory(messages, new Set(['t1']), 0)

    expect(out).toHaveLength(messages.length)
    // Untouched messages keep their identity; the touched one is a copy.
    expect(out[0]).toBe(messages[0])
    expect(out[3]).toBe(messages[3])
    expect(out[1]).not.toBe(original)
    const stubbed = (out[1] as { message: { content: Array<{ content: string }> } })
      .message.content[0]!
    expect(isClipStubContent(stubbed.content)).toBe(true)
    // The token count rides the active model's bytes-per-token ratio, so pin
    // the shape and the tool name rather than the number.
    expect(stubbed.content).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
    // The parent's array and block are byte-for-byte what they were.
    expect(
      (original as { message: { content: unknown[] } }).message.content,
    ).toBe(originalContent)
    expect((originalContent[0] as { content: string }).content).toBe(big)
  })

  test('keeps the head when the profile asks for it and the content is long enough', () => {
    const out = clipForkHistory(turns(2), new Set(['t1', 't2']), 200)
    const first = (out[1] as { message: { content: Array<{ content: string }> } })
      .message.content[0]!.content
    expect(first.startsWith('x'.repeat(200) + '\n[clipped: ~')).toBe(true)
    expect(first).toMatch(/\n\[clipped: ~\d+ tokens from Read — head preserved\]$/)
    expect(first.endsWith('— head preserved]')).toBe(true)
    expect(isClipStubContent(first)).toBe(true)
  })

  test('an empty id set returns a shallow copy with nothing rewritten', () => {
    const messages = turns(2)
    const out = clipForkHistory(messages, new Set(), 200)
    expect(out).not.toBe(messages)
    expect(out).toEqual(messages)
  })
})

describe('fork clip flag and thresholds', () => {
  const saved = {
    flag: process.env.CLAUDIN_FORK_CLIP_HISTORY,
    min: process.env.CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS,
    keep: process.env.CLAUDIN_FORK_CLIP_KEEP_TURNS,
  }
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeEach(() => {
    delete process.env.CLAUDIN_FORK_CLIP_HISTORY
    delete process.env.CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS
    delete process.env.CLAUDIN_FORK_CLIP_KEEP_TURNS
  })

  afterEach(() => {
    restore('CLAUDIN_FORK_CLIP_HISTORY', saved.flag)
    restore('CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS', saved.min)
    restore('CLAUDIN_FORK_CLIP_KEEP_TURNS', saved.keep)
  })

  test('is off unless CLAUDIN_FORK_CLIP_HISTORY is truthy', () => {
    expect(isForkClipHistoryEnabled()).toBe(false)
    process.env.CLAUDIN_FORK_CLIP_HISTORY = '1'
    expect(isForkClipHistoryEnabled()).toBe(true)
  })

  test('thresholds default to 100k / 4 and honor their env overrides', () => {
    expect(forkClipMinParentTokens()).toBe(100_000)
    expect(forkClipKeepTurns()).toBe(4)
    process.env.CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS = '50000'
    process.env.CLAUDIN_FORK_CLIP_KEEP_TURNS = '2'
    expect(forkClipMinParentTokens()).toBe(50_000)
    expect(forkClipKeepTurns()).toBe(2)
    process.env.CLAUDIN_FORK_CLIP_KEEP_TURNS = 'nope'
    expect(forkClipKeepTurns()).toBe(4)
  })
})
