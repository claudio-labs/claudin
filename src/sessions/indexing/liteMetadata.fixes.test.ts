// The four "fix" decisions of the sessions/liteMetadata spec, each driven
// through the public functions on real files.

import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { switchSession } from 'src/platform/bootstrap/state.js'
import {
  enrichLogs,
  getLastSessionLog,
  getSessionFilesLite,
  loadFullLog,
  loadTranscriptFromFile,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'
import {
  chat,
  type Line,
  meta,
  padding,
  SESSION_A,
  SESSION_C,
  uid,
  useLiteWorld,
} from 'src/sessions/indexing/__testutils__/liteWorld.js'

const world = useLiteWorld()

async function listedAs(lines: ReadonlyArray<Line | string>): Promise<LogOption | null> {
  world.write(SESSION_A, lines)
  const lite = await getSessionFilesLite(world.sessionsDir, undefined, '/listed/from')
  return (await enrichLogs(lite, 0, 1)).logs[0] ?? null
}

const uuids = (log: LogOption | null) => log?.messages.map(m => m.uuid) ?? null

describe('finding 1: on a timestamp tie the message written later anchors the chain', () => {
  const tied = chat([
    { kind: 'user', content: 'prompt', t: 4 },
    { kind: 'assistant', content: 'first reply', t: 4 },
    { kind: 'assistant', content: 'second reply', t: 4 },
    { kind: 'system', content: 'closing note', t: 4 },
  ])

  test('--resume <session id> keeps every message, closing note included', async () => {
    world.write(SESSION_A, tied)
    const log = await getLastSessionLog(SESSION_A as never)
    expect([uuids(log), log!.leafUuid, log!.messageCount]).toEqual([[uid(1), uid(2), uid(3), uid(4)], uid(4), 3])
  })

  test('the full load and the file load anchor on the later of two tied branch ends', async () => {
    const lines = chat([
      { kind: 'user', content: 'p', t: 0 },
      { kind: 'assistant', content: 'older branch', t: 5 },
      { kind: 'assistant', content: 'newer branch', parent: 1, t: 5 },
    ])
    const file = world.write(SESSION_A, lines)
    const lite = await getSessionFilesLite(world.sessionsDir)
    const full = await loadFullLog((await enrichLogs(lite, 0, 1)).logs[0]!)
    expect([uuids(full), uuids(await loadTranscriptFromFile(file))]).toEqual([
      [uid(1), uid(3)],
      [uid(1), uid(3)],
    ])
  })

  test('a strictly newer message still wins over a later-written older one', async () => {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'p', t: 0 }, { kind: 'assistant', content: 'new', t: 9 }, { kind: 'assistant', content: 'old', parent: 1, t: 3 }]))
    expect(uuids(await getLastSessionLog(SESSION_A as never))).toEqual([uid(1), uid(2)])
  })
})

describe('finding 2: the listing reads only the top-level fields of the lines that carry them', () => {
  const toolInput = { tag: 'v2', teamName: 'intruder', isSidechain: true, customTitle: 'fake', aiTitle: 'fake', agentSetting: 'fake', lastPrompt: 'fake', cwd: '/fake', gitBranch: 'fake', prUrl: 'fake' }
  const quotedIn = (kind: 'call' | 'result') =>
    kind === 'call'
      ? { kind: 'assistant' as const, content: [{ type: 'tool_use', id: 't1', name: 'mcp__x', input: toolInput }] }
      : { kind: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], ...toolInput }] }

  for (const kind of ['call', 'result'] as const) {
    test(`members named like session fields inside a tool ${kind} are ignored`, async () => {
      const shown = await listedAs(
        chat([{ kind: 'user', content: 'Real prompt' }, quotedIn(kind)], { cwd: '/real', branch: 'real-branch' }),
      )
      expect(shown).not.toBeNull()
      expect(shown).toMatchObject({ firstPrompt: 'Real prompt', projectPath: '/real', gitBranch: 'real-branch', isSidechain: false })
      expect([shown!.tag, shown!.teamName, shown!.customTitle, shown!.agentSetting, shown!.prUrl]).toEqual([undefined, undefined, undefined, undefined, undefined])
    })
  }

  test('a metadata entry of another type does not lend its members', async () => {
    const shown = await listedAs([...chat([{ kind: 'user', content: 'p' }]), { type: 'mode', mode: 'normal', tag: 'not-a-tag', customTitle: 'not-a-title', sessionId: SESSION_A }])
    expect([shown!.tag, shown!.customTitle]).toEqual([undefined, undefined])
  })

  test('a first line cut by the head window still hides a sidechain from its leading members', async () => {
    const long = chat([{ kind: 'user', content: padding(70), extra: { isSidechain: true } }])
    expect(await listedAs([...long, ...chat([{ kind: 'assistant', content: 'r', n: 2, parent: 1 }])])).toBeNull()
  })

  test('a metadata entry carrying message fields does not lend them', async () => {
    const stray = { type: 'custom-title', customTitle: 'Named', sessionId: SESSION_A, cwd: '/fake', gitBranch: 'fake', teamName: 'intruder', isSidechain: true }
    const shown = await listedAs([stray, ...chat([{ kind: 'user', content: 'p' }], { cwd: '/real', branch: 'real' })])
    expect(shown).toMatchObject({ customTitle: 'Named', projectPath: '/real', gitBranch: 'real', isSidechain: false })
    expect(shown!.teamName).toBeUndefined()
  })

  test('the cut first line of the tail window is not read, even when the cut lands on a nested object', async () => {
    const TAIL_WINDOW = 64 * 1024
    const lineWith = (fill: number) =>
      JSON.stringify(
        chat([{ kind: 'user', content: [{ type: 'text', text: padding(70) }, { type: 'tag', tag: 'fragment' }, { type: 'text', text: 'x'.repeat(fill) }] }])[0],
      )
    const unfilled = lineWith(0)
    const fromNested = unfilled.length + 1 - unfilled.indexOf('{"type":"tag"')
    // The newline the writer appends counts: the tail window then starts exactly at the nested `{`.
    const line = lineWith(TAIL_WINDOW - fromNested)
    expect(line.length + 1 - line.indexOf('{"type":"tag"')).toBe(TAIL_WINDOW)
    expect((await listedAs([line]))!.tag).toBeUndefined()
  })
})

describe('the project path is the cwd of the first message', () => {
  const moved = chat([
    { kind: 'user', content: 'p' },
    { kind: 'assistant', content: 'r', extra: { cwd: '/moved/later' } },
  ], { cwd: '/started/here' })

  test('in the listing', async () => {
    expect((await listedAs(moved))!.projectPath).toBe('/started/here')
  })

  test('in a record built from messages', async () => {
    const file = join(world.root, 'moved.json')
    await Bun.write(file, JSON.stringify(moved))
    expect((await loadTranscriptFromFile(file)).projectPath).toBe('/started/here')
  })
})

describe('enrichLogs passes a record that is not lite through, even with a file', () => {
  test('the same object comes back', async () => {
    const file = world.write(SESSION_A, chat([{ kind: 'user', content: 'p' }]))
    const full = { date: 'd', messages: [], value: 0, created: new Date(0), modified: new Date(0), firstPrompt: 'kept', messageCount: 0, isSidechain: false, fullPath: file } as LogOption
    expect((await enrichLogs([full], 0, 1)).logs[0]).toBe(full)
  })
})

describe('finding 3: the agent setting is read like the branch', () => {
  const opening = chat([{ kind: 'user', content: 'Opening prompt' }])
  const middle = chat([{ kind: 'user', content: padding(70), n: 2 }, { kind: 'assistant', content: padding(70), n: 3 }])

  const cases: Array<[string, Line[], string | undefined]> = [
    ['only at the end of a large file, where the writer appends it', [...opening, ...middle, meta.agentSetting('late')], 'late'],
    ['changed later: the tail beats the head', [...opening, meta.agentSetting('first'), ...middle, meta.agentSetting('second')], 'second'],
    ['only in the head', [...opening, meta.agentSetting('first'), ...middle], 'first'],
    ['the last of several in a small file', [...opening, meta.agentSetting('one'), meta.agentSetting('two')], 'two'],
  ]
  for (const [name, lines, expected] of cases) {
    test(`${name}: ${expected}`, async () => {
      expect((await listedAs(lines))!.agentSetting).toBe(expected)
    })
  }
})

describe('finding 4: getLastSessionLog reports the file it read', () => {
  test('after a cross-project resume, another session id is read from and reported in the current directory', async () => {
    const elsewhere = join(world.root, 'home', 'projects', '-elsewhere')
    const file = world.write(SESSION_A, chat([{ kind: 'user', content: 'over there' }]), { dir: elsewhere })
    switchSession(asSessionId(SESSION_C), elsewhere)
    expect(await getLastSessionLog(SESSION_A as never)).toMatchObject({ firstPrompt: 'over there', fullPath: file })
  })
})
