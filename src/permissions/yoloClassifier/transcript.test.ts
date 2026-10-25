import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { Tools } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import {
  classifierTranscriptBudget,
  MAX_CLASSIFIER_TRANSCRIPT_CHARS,
  serializeTranscriptForClassifier,
} from 'src/permissions/yoloClassifier/transcript.js'

const KILLSWITCH = 'CLAUDIN_CLASSIFIER_STABLE_CUT'
const savedKillswitch = process.env[KILLSWITCH]

function restoreKillswitch(): void {
  if (savedKillswitch === undefined) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = savedKillswitch
}

const tools = [
  {
    name: 'Bash',
    aliases: ['Shell'],
    toAutoClassifierInput(input: Record<string, unknown>) {
      return String(input.command ?? '')
    },
  },
  {
    name: 'Read',
    aliases: [],
    toAutoClassifierInput() {
      return ''
    },
  },
  {
    name: 'Write',
    aliases: [],
    toAutoClassifierInput(input: Record<string, unknown>) {
      if (input.explode) throw new Error('bad input')
      return { file_path: input.file_path }
    },
  },
] as unknown as Tools

function user(text: string): Message {
  return { type: 'user', message: { role: 'user', content: text } } as unknown as Message
}

function bash(...commands: string[]): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: commands.map(command => ({ type: 'tool_use', name: 'Bash', input: { command } })),
    },
  } as unknown as Message
}

function texts(messages: Message[], maxChars: number): string[] {
  return serializeTranscriptForClassifier(messages, tools, maxChars).userContentBlocks.map(
    b => b.text,
  )
}

// The newest-first fill: what `CLAUDIN_CLASSIFIER_STABLE_CUT=0` restores, and
// what the stable cut falls back to when not even its newest chunk fits.
describe('serializeTranscriptForClassifier, newest-first fill (=0)', () => {
  beforeAll(() => {
    process.env[KILLSWITCH] = '0'
  })
  afterAll(restoreKillswitch)

  test('under the budget every entry is kept, oldest first, one block per entry block', () => {
    const messages = [user('first'), bash('ls'), user('second'), bash('pwd', 'git status')]
    const result = serializeTranscriptForClassifier(messages, tools, 10_000)

    expect(result.userContentBlocks.map(b => b.text)).toEqual([
      'User: first\n',
      'Bash ls\n',
      'User: second\n',
      'Bash pwd\n',
      'Bash git status\n',
    ])
    expect(result.truncated).toBe(false)
    expect(result.transcriptEntries).toBe(4)
    expect(result.promptLengths).toEqual({
      userPrompts: 'User: first\n'.length + 'User: second\n'.length,
      toolCalls: 'Bash ls\n'.length + 'Bash pwd\n'.length + 'Bash git status\n'.length,
    })
  })

  test('over the budget the newest entries are kept and the oldest dropped', () => {
    const messages = [bash('a'.repeat(50)), bash('b'.repeat(50)), bash('c'.repeat(50))]
    const result = serializeTranscriptForClassifier(messages, tools, 120)

    expect(result.userContentBlocks.map(b => b.text)).toEqual([
      `Bash ${'b'.repeat(50)}\n`,
      `Bash ${'c'.repeat(50)}\n`,
    ])
    expect(result.truncated).toBe(true)
    expect(result.transcriptEntries).toBe(2)
  })

  test('the oldest kept entry moves on every append once past the budget', () => {
    // The behaviour behind the 10-24 census: each call's kept window starts one
    // entry later, so nothing after the CLAUDE.md block is a cacheable prefix.
    const history = Array.from({ length: 8 }, (_, i) => bash(`${i}`.repeat(40)))
    const first = texts(history.slice(0, 6), 140)[0]
    const second = texts(history.slice(0, 7), 140)[0]
    const third = texts(history.slice(0, 8), 140)[0]

    expect(new Set([first, second, third]).size).toBe(3)
  })

  test('an entry that lands exactly on the budget stops the walk', () => {
    const block = `Bash ${'x'.repeat(10)}\n`
    const messages = [bash('old'), bash('x'.repeat(10)), bash('x'.repeat(10))]
    const result = serializeTranscriptForClassifier(messages, tools, block.length * 2)

    expect(result.userContentBlocks.map(b => b.text)).toEqual([block, block])
    expect(result.truncated).toBe(true)
  })

  test('filling the budget exactly with nothing older is not a truncation', () => {
    const block = `Bash ${'x'.repeat(10)}\n`
    const messages = [bash('x'.repeat(10)), bash('x'.repeat(10))]
    const result = serializeTranscriptForClassifier(messages, tools, block.length * 2)

    expect(result.userContentBlocks.map(b => b.text)).toEqual([block, block])
    expect(result.truncated).toBe(false)
  })

  test('a lone entry bigger than the budget keeps its newest blocks that fit', () => {
    const messages = [user('before'), bash('a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30))]
    const result = serializeTranscriptForClassifier(messages, tools, 80)

    expect(result.userContentBlocks.map(b => b.text)).toEqual([
      `Bash ${'b'.repeat(30)}\n`,
      `Bash ${'c'.repeat(30)}\n`,
    ])
    expect(result.truncated).toBe(true)
    expect(result.transcriptEntries).toBe(1)
  })

  test('a lone entry with no block that fits leaves the transcript empty', () => {
    const messages = [bash('z'.repeat(200))]
    const result = serializeTranscriptForClassifier(messages, tools, 50)

    expect(result.userContentBlocks).toEqual([])
    expect(result.truncated).toBe(true)
    expect(result.transcriptEntries).toBe(0)
  })

  test("a tool that encodes to '' and an unknown tool are skipped, assistant text never enters", () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will now read the file' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
            { type: 'tool_use', name: 'Nope', input: { x: 1 } },
          ],
        },
      } as unknown as Message,
      bash('ls'),
    ]

    expect(texts(messages, 10_000)).toEqual(['Bash ls\n'])
  })

  test('aliases resolve, a throwing projection falls back to the raw input as JSON', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Shell', input: { command: 'echo hi' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/f', explode: true } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/g' } },
          ],
        },
      } as unknown as Message,
    ]

    expect(texts(messages, 10_000)).toEqual([
      'Shell echo hi\n',
      'Write {"file_path":"/f","explode":true}\n',
      'Write {"file_path":"/g"}\n',
    ])
  })

  test('user text blocks in an array are kept; tool_result blocks are not', () => {
    const messages = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'secret output' },
            { type: 'text', text: 'follow-up' },
          ],
        },
      } as unknown as Message,
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'x' }] },
      } as unknown as Message,
    ]

    expect(texts(messages, 10_000)).toEqual(['User: follow-up\n'])
  })

  test('a queued command with block content keeps only its text; one with no text is dropped', () => {
    const messages = [
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: [
            { type: 'text', text: 'line one' },
            { type: 'image', source: {} },
            { type: 'text', text: 'line two' },
          ],
        },
      } as unknown as Message,
      {
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: [{ type: 'image', source: {} }] },
      } as unknown as Message,
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 42 } } as unknown as Message,
      { type: 'attachment', attachment: { type: 'todo_reminder_delta' } } as unknown as Message,
    ]

    expect(texts(messages, 10_000)).toEqual(['User: line one\nline two\n'])
  })
})

// Entries of exactly 10,000 chars: the 25k chunk closes after every third
// entry, so the chunk starts are 0, 3, 6, … and a 100k budget keeps 8-10.
const ENTRY_CHARS = 10_000
const BUDGET = 100_000

function entry(i: number): Message {
  return bash(`e${i}:`.padEnd(ENTRY_CHARS - 'Bash \n'.length, 'x'))
}

function history(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => entry(i))
}

function firstKeptIndex(blocks: string[]): number {
  return Number(/^Bash e(\d+):/.exec(blocks[0] ?? '')?.[1] ?? -1)
}

describe('serializeTranscriptForClassifier, stable cut (default)', () => {
  afterEach(restoreKillswitch)

  test('past the budget the cut sits on a chunk boundary counted from the first entry', () => {
    for (let n = 11; n <= 40; n++) {
      const result = serializeTranscriptForClassifier(history(n), tools, BUDGET)
      const blocks = result.userContentBlocks.map(b => b.text)
      const kept = blocks.reduce((sum, b) => sum + b.length, 0)

      expect(firstKeptIndex(blocks) % 3).toBe(0)
      expect(kept).toBeLessThanOrEqual(BUDGET)
      expect(kept).toBeGreaterThan(BUDGET - 3 * ENTRY_CHARS)
      expect(blocks.at(-1)).toStartWith(`Bash e${n - 1}:`)
      expect(result.truncated).toBe(true)
    }
  })

  test('appending keeps every kept block byte-identical until the cut moves, once per chunk', () => {
    let moves = 0
    for (let n = 12; n < 40; n++) {
      const before = texts(history(n), BUDGET)
      const after = texts(history(n + 1), BUDGET)
      if (firstKeptIndex(before) === firstKeptIndex(after)) {
        expect(after.slice(0, before.length)).toEqual(before)
      } else {
        moves++
      }
    }
    // 28 appends, one move per three entries: the newest-first fill moves 28 times.
    expect(moves).toBeLessThanOrEqual(10)
    expect(moves).toBeGreaterThanOrEqual(9)
  })

  test('=0 brings back the window that slides on every append', () => {
    expect(firstKeptIndex(texts(history(13), BUDGET))).toBe(firstKeptIndex(texts(history(12), BUDGET)))

    process.env[KILLSWITCH] = '0'

    expect(firstKeptIndex(texts(history(12), BUDGET))).toBe(2)
    expect(firstKeptIndex(texts(history(13), BUDGET))).toBe(3)
  })

  test('under the budget both modes give the same transcript', () => {
    const messages = [user('do the thing'), ...history(5), user('and this')]
    const stable = serializeTranscriptForClassifier(messages, tools, BUDGET)
    process.env[KILLSWITCH] = '0'

    expect(serializeTranscriptForClassifier(messages, tools, BUDGET)).toEqual(stable)
    expect(stable.truncated).toBe(false)
  })

  test('a lone entry over the budget falls back to its newest blocks that fit', () => {
    const big = 'y'.repeat(30_000)
    const messages = [user('start'), bash(`a${big}`, `b${big}`, `c${big}`, `d${big}`)]
    const blocks = texts(messages, BUDGET)

    expect(blocks.map(b => b.slice(5, 6))).toEqual(['b', 'c', 'd'])
  })

  test('an empty history is an empty transcript', () => {
    expect(serializeTranscriptForClassifier([], tools, BUDGET)).toEqual({
      userContentBlocks: [],
      promptLengths: { toolCalls: 0, userPrompts: 0 },
      transcriptEntries: 0,
      truncated: false,
    })
  })

  test('an entry as large as a chunk opens its own, so the cut can land before it', () => {
    // Review finding: a 10k prompt, one turn of six ~30k parallel calls, then
    // 12k. With the big turn merged into the first chunk, the only boundary
    // that fit came after it and the cut kept 12k of a 200k budget.
    const messages = [
      user('i'.repeat(10_000)),
      bash(...Array.from({ length: 6 }, () => 'x'.repeat(30_000))),
      user('u'.repeat(6_000)),
      bash('y'.repeat(6_000)),
    ]
    const kept = texts(messages, MAX_CLASSIFIER_TRANSCRIPT_CHARS).reduce((n, b) => n + b.length, 0)

    expect(kept).toBeGreaterThan(MAX_CLASSIFIER_TRANSCRIPT_CHARS - 25_000)
  })
})

describe('classifierTranscriptBudget', () => {
  afterEach(restoreKillswitch)

  test('the stable cut gives the transcript the whole budget, whatever the action', () => {
    expect(classifierTranscriptBudget(0)).toBe(MAX_CLASSIFIER_TRANSCRIPT_CHARS)
    expect(classifierTranscriptBudget(31_000)).toBe(MAX_CLASSIFIER_TRANSCRIPT_CHARS)
  })

  test('=0 takes the action out of the budget, never below zero', () => {
    process.env[KILLSWITCH] = '0'

    expect(classifierTranscriptBudget(31_000)).toBe(MAX_CLASSIFIER_TRANSCRIPT_CHARS - 31_000)
    expect(classifierTranscriptBudget(MAX_CLASSIFIER_TRANSCRIPT_CHARS + 1)).toBe(0)
  })
})
