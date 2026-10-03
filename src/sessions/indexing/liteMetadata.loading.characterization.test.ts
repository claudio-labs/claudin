// Characterization of `sessions/liteMetadata`, part three: loading sessions
// in full. `loadFullLog` completes a listed record, `getLastSessionLog` is
// what `--resume <session id>` reads, `loadAllLogsFromSessionFile` and
// `getLogsWithoutIndex` give one record per branch, and
// `findUnresolvedToolUse` looks a pending tool call up in the current session.

import { describe, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import { switchSession } from 'src/platform/bootstrap/state.js'
import { getLogsWithoutIndex } from 'src/sessions/indexing/liteMetadata.js'
import {
  clearSessionMessagesCache,
  doesMessageExistInSession,
  enrichLogs,
  findUnresolvedToolUse,
  getLastSessionLog,
  getSessionFilesLite,
  getSessionIdFromLog,
  loadAllLogsFromSessionFile,
  loadFullLog,
  loadMessageLogs,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'
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
const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const WRITTEN_ID = 'd1c2b3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const uuids = (log: LogOption | null) => log?.messages.map(m => m.uuid) ?? null

async function listedRecord(id = SESSION_A): Promise<LogOption> {
  const lite = await getSessionFilesLite(world.sessionsDir, undefined, world.project)
  const { logs } = await enrichLogs(lite.filter(l => l.sessionId === id), 0, 1)
  return logs[0]!
}

/** A session with one fork: 1 → 2 → 3, and 1 → 4 → 5 (newer), plus the metadata a session carries. */
function forkedSession(): Line[] {
  return [
    ...chat([
      { kind: 'user', content: 'Plan the release' },
      { kind: 'assistant', content: 'Plan A' },
      { kind: 'user', content: 'Go with A' },
      { kind: 'assistant', content: 'Plan B', n: 4, parent: 1, t: 10 },
      { kind: 'user', content: 'Go with B', t: 11, extra: { gitBranch: 'release/b' } },
    ]),
    meta.title('Release plan'),
    meta.aiTitle('ignored by a full load'),
    meta.tag('ship'),
    meta.agentName('planner'),
    meta.agentColor('green'),
    meta.agentSetting('architect'),
    meta.mode('coordinator'),
    meta.pr(7),
    meta.cost(2.5),
    meta.summary('summary of A', 3),
    meta.summary('summary of B', 5),
    { type: 'file-history-snapshot', messageId: uid(1), snapshot: { messageId: uid(1), v: 1 }, isSnapshotUpdate: false },
    { type: 'file-history-snapshot', messageId: uid(4), snapshot: { messageId: uid(1), v: 2 }, isSnapshotUpdate: true },
    { type: 'file-history-snapshot', messageId: uid(2), snapshot: { messageId: uid(2), v: 9 }, isSnapshotUpdate: false },
    { type: 'attribution-snapshot', messageId: uid(90), surface: 'cli', fileStates: {} },
    { type: 'marble-origami-commit', sessionId: SESSION_A, collapseId: 'mine' },
    { type: 'marble-origami-commit', sessionId: SESSION_B, collapseId: 'theirs' },
    { type: 'marble-origami-snapshot', sessionId: SESSION_A, staged: [] },
  ]
}

// --- loadFullLog --------------------------------------------------------------

describe('loadFullLog', () => {
  test('completes a listed record from the newest branch of its file', async () => {
    world.write(SESSION_A, forkedSession())
    const listed = await listedRecord()
    const full = await loadFullLog(listed)
    expect(uuids(full)).toEqual([uid(1), uid(4), uid(5)])
    expect(full.messages.some(m => 'parentUuid' in m || 'isSidechain' in m)).toBe(false)
    expect(full).toMatchObject({
      firstPrompt: 'Plan the release',
      messageCount: 3,
      summary: 'summary of B',
      customTitle: 'Release plan',
      tag: 'ship',
      agentName: 'planner',
      agentColor: 'green',
      agentSetting: 'architect',
      mode: 'coordinator',
      prNumber: 7,
      prUrl: 'https://github.com/acme/shop/pull/7',
      prRepository: 'acme/shop',
      gitBranch: 'release/b',
      isSidechain: false,
      leafUuid: uid(5),
      costState: { totalCostUSD: 2.5 },
      contextCollapseSnapshot: { sessionId: SESSION_A },
    })
    expect(full.contextCollapseCommits!.map(c => (c as { collapseId: string }).collapseId)).toEqual(['mine'])
    // snapshots follow the chain, and an update replaces the snapshot it updates
    expect(full.fileHistorySnapshots).toEqual([{ messageId: uid(1), v: 2 }] as never)
    expect(full.attributionSnapshots!.map(a => a.messageId)).toEqual([uid(90)] as never)
  })

  test('keeps what the listing knew and the full load does not touch', async () => {
    world.write(SESSION_A, [...forkedSession(), meta.cost(4)])
    const listed = await listedRecord()
    const full = await loadFullLog(listed)
    for (const key of ['sessionId', 'fullPath', 'value', 'date', 'created', 'modified', 'fileSize', 'projectPath', 'isLite', 'costUSD'] as const) {
      expect([key, full[key]]).toEqual([key, listed[key]])
    }
    expect(full).not.toBe(listed)
    expect(listed.messages).toEqual([])
  })

  test('drops the AI title the listing showed: only a user title survives a full load', async () => {
    world.write(SESSION_A, [...chat([{ kind: 'user', content: 'p' }]), meta.aiTitle('Machine name')])
    const listed = await listedRecord()
    expect(listed.customTitle).toBe('Machine name')
    expect((await loadFullLog(listed)).customTitle).toBeUndefined()
  })

  test('replaces listing metadata the file has no entry for with nothing, but keeps a worktree it has no entry for', async () => {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'p' }]))
    const listed = { ...(await listedRecord()), tag: 'from list', summary: 'from list', worktreeSession: { worktreePath: '/kept' } } as LogOption
    const full = await loadFullLog(listed)
    expect([full.tag, full.summary, full.worktreeSession]).toEqual([undefined, undefined, { worktreePath: '/kept' }] as never)
  })

  test('a worktree-state entry of null clears the worktree', async () => {
    world.write(SESSION_A, [...chat([{ kind: 'user', content: 'p' }]), meta.worktree({ worktreePath: '/w' }), meta.worktree(null)])
    const listed = { ...(await listedRecord()), worktreeSession: { worktreePath: '/old' } } as LogOption
    expect((await loadFullLog(listed)).worktreeSession).toBeNull()
  })

  test('a fork carries its source session on the first messages: metadata is looked up by the newest message', async () => {
    const source = chat([{ kind: 'user', content: 'Copied prompt' }], { sessionId: SESSION_B })
    const own = chat([{ kind: 'assistant', content: 'Fork reply', n: 2, parent: 1, t: 5 }], { sessionId: SESSION_A })
    world.write(SESSION_A, [...source, ...own, meta.title('Fork title', SESSION_A), meta.title('Source title', SESSION_B)])
    const full = await loadFullLog(await listedRecord())
    expect([full.customTitle, uuids(full)]).toEqual(['Fork title', [uid(1), uid(2)]] as never)
    // a full record names the session of its first message
    expect(getSessionIdFromLog({ ...full, sessionId: undefined })).toBe(SESSION_B as never)
  })

  test('a system message after the last reply is not part of the loaded chain', async () => {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'p' }, { kind: 'assistant', content: 'r' }, { kind: 'system', content: 'took 3s' }]))
    expect(uuids(await loadFullLog(await listedRecord()))).toEqual([uid(1), uid(2)])
  })

  test('the first of the chain decides sidechain and team', async () => {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'p', extra: { teamName: 'red', isSidechain: true } }, { kind: 'assistant', content: 'r' }]))
    const record = { ...(await getSessionFilesLite(world.sessionsDir))[0]!, isSidechain: false }
    expect(await loadFullLog(record)).toMatchObject({ teamName: 'red', isSidechain: true })
  })

  test('returns the very record it was given when there is nothing to load', async () => {
    world.write(SESSION_B, chat([{ kind: 'system', content: 'only a note' }]))
    const lite = (fullPath?: string, sessionId: string | undefined = SESSION_A) =>
      ({ date: 'd', messages: [], value: 0, created: new Date(0), modified: new Date(0), firstPrompt: '', messageCount: 0, isSidechain: false, sessionId, fullPath }) as LogOption
    const records: Array<[string, LogOption]> = [
      ['a full record', { ...lite('/x'), messages: [{ uuid: uid(1) }] as never }],
      ['a record without a session id', lite('/x', undefined)],
      ['a lite record without a path', lite(undefined)],
      ['a lite record whose file is missing', lite(join(world.root, 'gone.jsonl'))],
      ['a lite record whose file has no user or assistant message', lite(join(world.sessionsDir, `${SESSION_B}.jsonl`))],
    ]
    for (const [name, record] of records) {
      expect([name, (await loadFullLog(record)) === record]).toEqual([name, true])
    }
  })
})

// --- getLastSessionLog ----------------------------------------------------------

describe('getLastSessionLog: what --resume <session id> reads', () => {
  test('builds the record from the newest message of the session file in the original cwd project', async () => {
    const file = world.write(SESSION_A, [
      ...chat([
        { kind: 'user', content: 'Resume me', extra: { teamName: 'blue', agentName: 'lead' } },
        { kind: 'assistant', content: 'Resumed', extra: { gitBranch: 'topic' } },
      ]),
      meta.title('By id'),
      meta.tag('t'),
      meta.agentSetting('reviewer'),
      meta.summary('the summary', 2),
      meta.cost(1.5),
      meta.worktree({ worktreePath: '/w' }),
      { type: 'marble-origami-commit', sessionId: SESSION_A, collapseId: 'mine' },
      { type: 'marble-origami-commit', sessionId: SESSION_B, collapseId: 'theirs' },
      { type: 'file-history-snapshot', messageId: uid(2), snapshot: { messageId: uid(2), v: 1 }, isSnapshotUpdate: false },
      { type: 'file-history-snapshot', messageId: uid(77), snapshot: { messageId: uid(77), v: 1 }, isSnapshotUpdate: false },
      { type: 'attribution-snapshot', messageId: uid(91), surface: 'cli', fileStates: {} },
    ])
    const log = await getLastSessionLog(SESSION_A as never)
    expect(log!.fileHistorySnapshots).toEqual([{ messageId: uid(2), v: 1 }] as never)
    expect(log!.attributionSnapshots!.map(a => a.messageId)).toEqual([uid(91)])
    expect(uuids(log)).toEqual([uid(1), uid(2)])
    expect(log).toMatchObject({
      fullPath: file,
      date: at(1),
      created: new Date(at(0)),
      modified: new Date(at(1)),
      value: 0,
      firstPrompt: 'Resume me',
      messageCount: 2,
      customTitle: 'By id',
      tag: 't',
      agentSetting: 'reviewer',
      summary: 'the summary',
      gitBranch: 'topic',
      projectPath: '/home/dev/shop',
      teamName: 'blue',
      agentName: 'lead',
      leafUuid: uid(2),
      worktreeSession: { worktreePath: '/w' },
      costState: { totalCostUSD: 1.5 },
    })
    expect(log!.contextCollapseCommits!.map(c => (c as { collapseId: string }).collapseId)).toEqual(['mine'])
    expect([log!.sessionId, log!.isLite, getSessionIdFromLog(log!)]).toEqual([undefined, undefined, SESSION_A] as never)
  })

  test('a session with no file, or with only sidechain messages, gives null', async () => {
    world.write(SESSION_B, chat([{ kind: 'user', content: 'p', extra: { isSidechain: true } }], { sessionId: SESSION_B }))
    expect([await getLastSessionLog(SESSION_A as never), await getLastSessionLog(SESSION_B as never)]).toEqual([null, null])
  })

  test('the newest message of any kind anchors the chain, sidechain messages aside', async () => {
    world.write(
      SESSION_A,
      chat([
        { kind: 'user', content: 'p' },
        { kind: 'assistant', content: 'r' },
        { kind: 'system', content: 'took 3s' },
        { kind: 'assistant', content: 'side', parent: 2, t: 9, extra: { isSidechain: true } },
      ]),
    )
    expect(uuids(await getLastSessionLog(SESSION_A as never))).toEqual([uid(1), uid(2), uid(3)])
  })

  test('reads from the current session project directory when one is set', async () => {
    const elsewhere = join(world.root, 'home', 'projects', '-elsewhere')
    const file = world.write(SESSION_A, chat([{ kind: 'user', content: 'over there' }]), { dir: elsewhere })
    switchSession(asSessionId(SESSION_A), elsewhere)
    expect(await getLastSessionLog(SESSION_A as never)).toMatchObject({ firstPrompt: 'over there', fullPath: file })
  })

  test('primes the persisted-message cache of the session, but never overwrites an entry already there', async () => {
    const file = world.write(SESSION_A, chat([{ kind: 'user', content: 'p' }]))
    const late = (n: number) => `${JSON.stringify(chat([{ kind: 'assistant', content: 'late', n, parent: 1, t: 30 + n }])[0])}\n`

    await getLastSessionLog(SESSION_A as never)
    appendFileSync(file, late(2))
    expect(await doesMessageExistInSession(SESSION_A as never, uid(2) as never)).toBe(false)

    clearSessionMessagesCache()
    expect(await doesMessageExistInSession(SESSION_A as never, uid(2) as never)).toBe(true)
    appendFileSync(file, late(3))
    expect(uuids(await getLastSessionLog(SESSION_A as never))).toEqual([uid(1), uid(3)])
    expect(await doesMessageExistInSession(SESSION_A as never, uid(3) as never)).toBe(false)
  })
})

// --- messages that share a timestamp (finding 1) --------------------------------

describe('messages that share a timestamp', () => {
  // The real writer stamps a quick exchange with one timestamp; this fixture is
  // its output for a prompt and two replies.
  function writtenSession(): string {
    mkdirSync(world.sessionsDir, { recursive: true })
    const file = join(world.sessionsDir, `${WRITTEN_ID}.jsonl`)
    copyFileSync(join(FIXTURES, 'written-session.jsonl'), file)
    return file
  }
  const all = [uid(1), uid(2), uid(3)]

  test('DEFECT, finding 1 (decision: fix): getLastSessionLog keeps every message of the tie, anchored on the last written', async () => {
    writtenSession()
    const log = await getLastSessionLog(WRITTEN_ID as never)
    expect([uuids(log), log!.leafUuid, log!.messageCount]).toEqual([all, uid(3), 3])
  })

  test('the listing path (--continue, the picker) loads every message of the tie', async () => {
    writtenSession()
    const [latest] = await loadMessageLogs()
    expect(uuids(await loadFullLog(latest!))).toEqual(all)
  })

  test('loadAllLogsFromSessionFile loads every message of the tie', async () => {
    const file = writtenSession()
    expect((await loadAllLogsFromSessionFile(file)).map(uuids)).toEqual([all])
  })

  test('DEFECT, finding 1 (decision: fix): between two branches that end at the same time, the last written wins', async () => {
    world.write(
      SESSION_A,
      chat([
        { kind: 'user', content: 'p', t: 0 },
        { kind: 'assistant', content: 'first branch', t: 5 },
        { kind: 'assistant', content: 'second branch', parent: 1, t: 5 },
      ]),
    )
    expect(uuids(await loadFullLog(await listedRecord()))).toEqual([uid(1), uid(3)])
  })
})

// --- one record per branch --------------------------------------------------------

describe('loadAllLogsFromSessionFile', () => {
  test('one record per branch end, each with its chain, the messages hanging off its end, and its metadata', async () => {
    const file = world.write(SESSION_A, [
      ...forkedSession(),
      ...chat([
        { kind: 'system', content: 'late note', n: 21, parent: 5, t: 40 },
        { kind: 'attachment', n: 20, parent: 5, t: 30 },
      ]),
    ])
    const logs = await loadAllLogsFromSessionFile(file)
    expect(logs.map(uuids)).toEqual([
      [uid(1), uid(2), uid(3)],
      [uid(1), uid(4), uid(5), uid(20), uid(21)],
    ])
    expect(logs[1]).toMatchObject({
      date: at(11),
      fullPath: file,
      value: 0,
      created: new Date(at(0)),
      modified: new Date(at(11)),
      firstPrompt: 'Plan the release',
      messageCount: 3,
      isSidechain: false,
      sessionId: SESSION_A,
      leafUuid: uid(5),
      summary: 'summary of B',
      customTitle: 'Release plan',
      tag: 'ship',
      agentName: 'planner',
      agentColor: 'green',
      agentSetting: 'architect',
      mode: 'coordinator',
      prNumber: 7,
      gitBranch: 'release/b',
      projectPath: '/home/dev/shop',
      fileHistorySnapshots: [{ messageId: uid(1), v: 2 }],
    })
    expect([logs[0]!.summary, logs[0]!.leafUuid, logs[0]!.isLite]).toEqual(['summary of A', uid(3), undefined])
    expect(logs[1]!.messages.some(m => 'parentUuid' in m)).toBe(false)
  })

  test('a project path given by the caller replaces the cwd of the first message', async () => {
    const file = world.write(SESSION_A, chat([{ kind: 'user', content: 'p' }]))
    expect((await loadAllLogsFromSessionFile(file, '/caller/says'))[0]!.projectPath).toBe('/caller/says')
  })

  test('a missing or message-less file gives no records', async () => {
    const empty = world.write(SESSION_B, [meta.title('only a title')])
    expect([await loadAllLogsFromSessionFile(join(world.root, 'gone.jsonl')), await loadAllLogsFromSessionFile(empty)]).toEqual([[], []])
  })
})

describe('getLogsWithoutIndex', () => {
  function threeFiles() {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'a' }, { kind: 'assistant', content: 'a2' }, { kind: 'assistant', content: 'a-fork', parent: 1 }]), { mtime: 1_790_000_100 })
    world.write(SESSION_B, chat([{ kind: 'user', content: 'b' }], { sessionId: SESSION_B }), { mtime: 1_790_000_300 })
    world.write(SESSION_C, chat([{ kind: 'user', content: 'c' }], { sessionId: SESSION_C }), { mtime: 1_790_000_200 })
  }

  test('every branch of every session file of a directory', async () => {
    threeFiles()
    const logs = await getLogsWithoutIndex(world.sessionsDir)
    expect(logs.map(l => `${l.firstPrompt}:${l.leafUuid?.slice(-1)}`).sort()).toEqual(['a:2', 'a:3', 'b:1', 'c:1'])
  })

  test('a limit keeps the files modified last, newest first', async () => {
    threeFiles()
    const logs = await getLogsWithoutIndex(world.sessionsDir, 2)
    expect(logs.map(l => l.sessionId)).toEqual([SESSION_B, SESSION_C])
  })

  test('a directory that does not exist gives nothing', async () => {
    expect(await getLogsWithoutIndex(join(world.root, 'nowhere'), 3)).toEqual([])
  })
})

// --- findUnresolvedToolUse -------------------------------------------------------

describe('findUnresolvedToolUse: a pending tool call of the current session', () => {
  function currentSession(lines: Line[]) {
    switchSession(asSessionId(SESSION_C))
    world.write(SESSION_C, lines)
  }
  const call = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } })
  const answer = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

  test('the assistant message that made a call nothing answered yet', async () => {
    currentSession(
      chat(
        [
          { kind: 'user', content: 'p' },
          { kind: 'assistant', content: [call('toolu_done')] },
          { kind: 'user', content: [answer('toolu_done')] },
          { kind: 'assistant', content: [{ type: 'text', text: 'and' }, call('toolu_open')] },
        ],
        { sessionId: SESSION_C },
      ),
    )
    const found = await findUnresolvedToolUse('toolu_open')
    expect(found).toMatchObject({ uuid: uid(4), parentUuid: uid(3), type: 'assistant' })
    expect([await findUnresolvedToolUse('toolu_done'), await findUnresolvedToolUse('toolu_never')]).toEqual([null, null])
  })

  test('nothing when the current session has no transcript', async () => {
    switchSession(asSessionId(SESSION_C))
    expect(await findUnresolvedToolUse('toolu_open')).toBeNull()
  })

  test('a call in another session file is not found', async () => {
    switchSession(asSessionId(SESSION_C))
    world.write(SESSION_A, chat([{ kind: 'assistant', content: [call('toolu_x')] }]))
    expect(await findUnresolvedToolUse('toolu_x')).toBeNull()
  })
})
