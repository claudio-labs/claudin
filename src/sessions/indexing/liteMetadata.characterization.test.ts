// Characterization of `sessions/liteMetadata`, part one: the exports that
// shape a session record without listing a directory, and how a record is
// built from messages (seen through `loadTranscriptFromFile`). Names the
// session-storage barrel re-exports are imported through it; the others come
// straight from the module.

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'

import { deduplicateLogsBySessionId } from 'src/sessions/indexing/liteMetadata.js'
import {
  getNodeEnv,
  getSessionIdFromLog,
  INITIAL_ENRICH_COUNT,
  isCustomTitleEnabled,
  isLiteLog,
  loadTranscriptFromFile,
} from 'src/sessions/sessionStorage.js'
import type { LogOption, TranscriptMessage } from 'src/shared/types/logs.js'
import { envSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  at,
  chat,
  type Line,
  meta,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  uid,
  useLiteWorld,
} from 'src/sessions/indexing/__testutils__/liteWorld.js'

const world = useLiteWorld()

const asMessages = (lines: Line[]) => lines as unknown as TranscriptMessage[]

function record(fields: Partial<LogOption>): LogOption {
  return {
    date: at(0),
    messages: [],
    value: 99,
    created: new Date(at(0)),
    modified: new Date(at(0)),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    ...fields,
  }
}

describe('constants and switches', () => {
  test('the picker enriches fifty sessions up front, and custom titles are always on', () => {
    expect({ INITIAL_ENRICH_COUNT, titles: isCustomTitleEnabled() }).toEqual({ INITIAL_ENRICH_COUNT: 50, titles: true })
  })

  test('getNodeEnv reads NODE_ENV at call time and falls back to development when it is unset or empty', () => {
    const env = envSnapshot(['NODE_ENV'])
    try {
      const seen: Record<string, string> = {}
      for (const value of ['production', 'test', '', undefined]) {
        if (value === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = value
        seen[String(value)] = getNodeEnv()
      }
      expect(seen).toEqual({ production: 'production', test: 'test', '': 'development', undefined: 'development' })
    } finally {
      env.restore()
    }
  })
})

describe('messageCount: what counts as a turn on screen', () => {
  // Read through a .json export, which is taken as it is: no chain, no filter.
  async function countOf(messages: Line[]): Promise<number> {
    const file = join(world.root, 'count.json')
    const stamped = messages.map((m, i) => ({ uuid: uid(i + 1), timestamp: at(i), ...m }))
    writeFileSync(file, JSON.stringify(stamped))
    return (await loadTranscriptFromFile(file)).messageCount
  }

  const cases: Array<[string, Line, number]> = [
    ['a user prompt as a string', { type: 'user', message: { content: 'fix it' } }, 1],
    ['a user prompt of whitespace only', { type: 'user', message: { content: '  \n ' } }, 0],
    ['a meta user message', { type: 'user', isMeta: true, message: { content: 'caveat' } }, 0],
    ['a user message with no content', { type: 'user', message: {} }, 0],
    ['a user text block (even an empty one)', { type: 'user', message: { content: [{ type: 'text', text: '' }] } }, 1],
    ['a user image block', { type: 'user', message: { content: [{ type: 'image', source: {} }] } }, 1],
    ['a user document block', { type: 'user', message: { content: [{ type: 'document', source: {} }] } }, 1],
    ['a user message of tool results only', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }, 0],
    ['an assistant text', { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }, 1],
    ['an assistant text of whitespace', { type: 'assistant', message: { content: [{ type: 'text', text: ' \t' }] } }, 0],
    ['an assistant tool call only', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }, 0],
    ['an assistant thinking block only', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }, 0],
    ['an assistant whose content is a plain string', { type: 'assistant', message: { content: 'done' } }, 0],
    ['a system message', { type: 'system', content: 'note' }, 0],
    ['an attachment', { type: 'attachment', attachment: {} }, 0],
    ['a progress entry', { type: 'progress', data: {} }, 0],
  ]
  for (const [name, message, expected] of cases) {
    test(`${name}: ${expected}`, async () => {
      expect(await countOf([message])).toBe(expected)
    })
  }

  test('counts add up across a transcript', async () => {
    expect(await countOf(cases.map(c => c[1]))).toBe(5)
  })
})

describe('a record built from messages as given (a .json export)', () => {
  const chain = chat(
    [
      { kind: 'user', content: 'Why does the\nqueue hang?', extra: { teamName: 'blue', agentName: 'lead' } },
      { kind: 'assistant', content: 'Looking.', t: 7 },
      { kind: 'assistant', content: [{ type: 'tool_use', id: 't1' }], t: 9, extra: { gitBranch: 'fix/queue' } },
    ],
    { cwd: '/srv/shop' },
  )

  async function exported(lines: Line[]): Promise<LogOption> {
    const file = join(world.root, 'export.json')
    writeFileSync(file, JSON.stringify(lines))
    return loadTranscriptFromFile(file)
  }

  test('reads dates, title, counts and identity off the first and last messages', async () => {
    const out = await exported(chain)
    expect(out).toEqual({
      date: at(9),
      messages: expect.any(Array),
      fullPath: join(world.root, 'export.json'),
      value: 0,
      created: new Date(at(0)),
      modified: new Date(at(9)),
      firstPrompt: 'Why does the queue hang?',
      messageCount: 2,
      isSidechain: false,
      teamName: 'blue',
      agentName: 'lead',
      agentSetting: undefined,
      leafUuid: uid(3),
      summary: undefined,
      customTitle: undefined,
      tag: undefined,
      fileHistorySnapshots: undefined,
      attributionSnapshots: undefined,
      gitBranch: 'fix/queue',
      projectPath: '/srv/shop',
    })
  })

  test('the messages come back without parentUuid and isSidechain', async () => {
    const out = await exported(chain)
    expect(out.messages.map(m => Object.keys(m).filter(k => k === 'parentUuid' || k === 'isSidechain'))).toEqual([[], [], []])
    expect(out.messages.map(m => m.uuid)).toEqual([uid(1), uid(2), uid(3)])
  })

  test('a transcript with no user prompt is titled "No prompt"', async () => {
    expect((await exported(chat([{ kind: 'assistant', content: 'hello' }]))).firstPrompt).toBe('No prompt')
  })
})

describe('reading a record', () => {
  const rows: Array<[string, Partial<LogOption>, string | undefined, boolean]> = [
    ['a lite record', { sessionId: SESSION_A }, SESSION_A, true],
    ['a lite record with messages too', { sessionId: SESSION_B, messages: asMessages(chat([{ kind: 'user', content: 'x' }], { sessionId: SESSION_C })) as never }, SESSION_B, false],
    ['a full record (no sessionId member)', { messages: asMessages(chat([{ kind: 'user', content: 'x' }], { sessionId: SESSION_C })) as never }, SESSION_C, false],
    ['an empty record', {}, undefined, false],
  ]
  for (const [name, fields, id, lite] of rows) {
    test(`${name}: id ${id ?? 'none'}, lite ${lite}`, () => {
      const log = record(fields)
      expect([getSessionIdFromLog(log), isLiteLog(log)]).toEqual([id as never, lite])
    })
  }
})

describe('deduplicateLogsBySessionId', () => {
  test('keeps the newest record per session, drops records without an id, sorts newest first and renumbers', () => {
    const logs = [
      record({ sessionId: SESSION_A, modified: new Date(at(5)), firstPrompt: 'a-old' }),
      record({ sessionId: SESSION_B, modified: new Date(at(8)), firstPrompt: 'b' }),
      record({ sessionId: SESSION_A, modified: new Date(at(9)), firstPrompt: 'a-new' }),
      record({ modified: new Date(at(30)), firstPrompt: 'anonymous' }),
      record({ sessionId: SESSION_C, modified: new Date(at(8)), created: new Date(at(7)), firstPrompt: 'c' }),
    ]
    const out = deduplicateLogsBySessionId(logs)
    expect(out.map(l => [l.firstPrompt, l.value])).toEqual([
      ['a-new', 0],
      ['c', 1],
      ['b', 2],
    ])
    // fresh objects: the inputs keep their old index
    expect(logs[2]!.value).toBe(99)
  })

  test('on a tie in modified time the first record seen stays', () => {
    const out = deduplicateLogsBySessionId([
      record({ sessionId: SESSION_A, firstPrompt: 'first' }),
      record({ sessionId: SESSION_A, firstPrompt: 'second' }),
    ])
    expect(out.map(l => l.firstPrompt)).toEqual(['first'])
  })
})

describe('loadTranscriptFromFile', () => {
  test('a .jsonl transcript: the newest leaf, its chain and the metadata of its session', async () => {
    const lines = [
      ...chat([
        { kind: 'user', content: 'Start here' },
        { kind: 'assistant', content: 'Branch one', t: 3 },
        { kind: 'assistant', content: 'Branch two', n: 3, parent: 1, t: 6 },
      ]),
      meta.title('Queue work'),
      meta.tag('bug'),
      meta.summary('about branch two', 3),
      meta.worktree({ worktreePath: '/w', worktreeName: 'w' }),
      { type: 'marble-origami-commit', sessionId: SESSION_A, collapseId: 'c1' },
      { type: 'marble-origami-commit', sessionId: SESSION_B, collapseId: 'c2' },
      { type: 'marble-origami-snapshot', sessionId: SESSION_A, staged: [] },
    ]
    const file = world.write(SESSION_A, lines)
    const out = await loadTranscriptFromFile(file)
    expect(out.messages.map(m => m.uuid)).toEqual([uid(1), uid(3)])
    expect(out).toMatchObject({
      fullPath: file,
      customTitle: 'Queue work',
      tag: 'bug',
      summary: 'about branch two',
      leafUuid: uid(3),
      worktreeSession: { worktreePath: '/w', worktreeName: 'w' },
      contextCollapseSnapshot: { sessionId: SESSION_A },
    })
    expect(out.contextCollapseCommits?.map(c => (c as { collapseId: string }).collapseId)).toEqual(['c1'])
  })

  test('a .jsonl transcript whose session has no worktree or collapse snapshot leaves them unset', async () => {
    const file = world.write(SESSION_A, [
      ...chat([{ kind: 'user', content: 'hi' }]),
      { type: 'marble-origami-snapshot', sessionId: SESSION_B, staged: [] },
    ])
    const out = await loadTranscriptFromFile(file)
    expect([out.worktreeSession, out.contextCollapseSnapshot, out.contextCollapseCommits]).toEqual([undefined, undefined, []])
  })

  const refusals: Array<[string, string, string]> = [
    ['an empty .jsonl file', 'empty.jsonl', 'No messages found in JSONL file'],
    ['a .jsonl file that is missing', 'missing.jsonl', 'No messages found in JSONL file'],
    ['a .jsonl file with only system messages', 'system.jsonl', 'No valid conversation chain found in JSONL file'],
    ['a .json file that is not JSON', 'broken.json', 'Invalid JSON in transcript file: '],
    ['a .json object whose messages is not a list', 'object.json', 'Transcript messages must be an array'],
    ['a .json scalar', 'scalar.json', 'Transcript must be an array of messages or an object with a messages array'],
    ['a .json empty list', 'none.json', 'Cannot build session metadata from an empty transcript'],
  ]
  const contents: Record<string, string> = {
    'empty.jsonl': '',
    'system.jsonl': chat([{ kind: 'system', content: 'a' }, { kind: 'system', content: 'b' }]).map(l => JSON.stringify(l)).join('\n'),
    'broken.json': '{"messages": [',
    'object.json': '{"messages": {"0": {}}}',
    'scalar.json': '42',
    'none.json': '[]',
  }
  for (const [name, fileName, message] of refusals) {
    test(`${name} is refused: ${message}`, async () => {
      const file = join(world.root, fileName)
      if (contents[fileName] !== undefined) writeFileSync(file, contents[fileName]!)
      await expect(loadTranscriptFromFile(file)).rejects.toThrow(message)
    })
  }

  test('a missing .json file rejects with the read error', async () => {
    await expect(loadTranscriptFromFile(join(world.root, 'gone.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  const shapes: Array<[string, (lines: Line[]) => unknown]> = [
    ['a list of messages', lines => lines],
    ['an object with a messages list', lines => ({ messages: lines, title: 'ignored' })],
  ]
  for (const [name, wrap] of shapes) {
    test(`a .json transcript as ${name} is taken in file order, without chain building`, async () => {
      const lines = chat([
        { kind: 'user', content: 'Exported prompt' },
        { kind: 'assistant', content: 'Exported reply', t: 4 },
        { kind: 'user', content: 'Unrelated root', parent: null, t: 2 },
      ])
      const file = join(world.root, 'export.json')
      writeFileSync(file, JSON.stringify(wrap(lines)))
      const out = await loadTranscriptFromFile(file)
      expect(out.messages.map(m => m.uuid)).toEqual([uid(1), uid(2), uid(3)])
      expect(out).toMatchObject({ fullPath: file, firstPrompt: 'Exported prompt', date: at(2), leafUuid: uid(3), messageCount: 3 })
      expect([out.customTitle, out.tag, out.summary]).toEqual([undefined, undefined, undefined])
    })
  }
})
