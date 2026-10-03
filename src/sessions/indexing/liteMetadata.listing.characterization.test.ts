// Characterization of `sessions/liteMetadata`, part two: listing a project's
// transcripts from file stats alone, and enriching that listing from the
// first and last 64 KiB of each file. This is the cheap pass behind
// `/resume`, `--continue` and title search. Every transcript is a real JSONL
// file in a fresh temp project.

import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { getSessionFilesLite, getSessionFilesWithMtime } from 'src/sessions/indexing/liteMetadata.js'
import {
  enrichLogs,
  fetchLogs,
  getLogByIndex,
  isLiteLog,
  loadMessageLogs,
} from 'src/sessions/sessionStorage.js'
import type { LogOption } from 'src/shared/types/logs.js'
import {
  billedReply,
  chat,
  type Line,
  meta,
  padding,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  uid,
  useLiteWorld,
} from 'src/sessions/indexing/__testutils__/liteWorld.js'

const world = useLiteWorld()
const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

/** List the project's one transcript and enrich it: the record `/resume` shows, or null when hidden. */
async function listedAs(lines: ReadonlyArray<Line | string>): Promise<LogOption | null> {
  world.write(SESSION_A, lines)
  const lite = await getSessionFilesLite(world.sessionsDir, undefined, '/listed/from')
  const { logs } = await enrichLogs(lite, 0, 1)
  return logs[0] ?? null
}

const prompt = (content: unknown) => chat([{ kind: 'user', content }])

// --- files on disk ------------------------------------------------------------

describe('getSessionFilesWithMtime', () => {
  test('a project directory that does not exist lists nothing', async () => {
    expect((await getSessionFilesWithMtime(join(world.root, 'nowhere'))).size).toBe(0)
  })

  test('only regular .jsonl files named by a UUID (any letter case) are sessions', async () => {
    const dir = world.sessionsDir
    const upper = SESSION_B.toUpperCase()
    const kept = [world.write(SESSION_A, prompt('a'), { mtime: 1_790_000_000 }), world.write(upper, prompt('bb'), { mtime: 1_790_000_500 })]
    world.write('not-a-session', prompt('x'))
    writeFileSync(join(dir, `${SESSION_C}.json`), '[]')
    mkdirSync(join(dir, `${uid(7)}.jsonl`))
    symlinkSync(kept[0]!, join(dir, `${uid(8)}.jsonl`))

    const found = await getSessionFilesWithMtime(dir)
    expect([...found.keys()].sort()).toEqual([upper, SESSION_A].sort())
    const expected = (file: string) => {
      const st = statSync(file)
      return { path: file, mtime: st.mtime.getTime(), ctime: st.birthtime.getTime(), size: st.size }
    }
    expect(found.get(SESSION_A)).toEqual(expected(kept[0]!))
    expect(found.get(upper)).toEqual(expected(kept[1]!))
    expect(found.get(SESSION_A)!.mtime).toBe(1_790_000_000_000)
  })
})

describe('getSessionFilesLite: the stat-only listing', () => {
  function threeSessions() {
    return {
      a: world.write(SESSION_A, prompt('alpha'), { mtime: 1_790_000_100 }),
      b: world.write(SESSION_B, prompt('bravo!'), { mtime: 1_790_000_300 }),
      c: world.write(SESSION_C, prompt('charlie'), { mtime: 1_790_000_200 }),
    }
  }

  test('newest file first, numbered from 0, with nothing read from the files', async () => {
    const files = threeSessions()
    const logs = await getSessionFilesLite(world.sessionsDir, undefined, '/as/given')
    expect(logs.map(l => [l.sessionId, l.value])).toEqual([
      [SESSION_B, 0],
      [SESSION_C, 1],
      [SESSION_A, 2],
    ])
    const st = statSync(files.b)
    expect(logs[0]).toEqual({
      date: new Date(1_790_000_300_000).toISOString(),
      messages: [],
      isLite: true,
      fullPath: files.b,
      value: 0,
      created: new Date(st.birthtime.getTime()),
      modified: new Date(1_790_000_300_000),
      firstPrompt: '',
      messageCount: 0,
      fileSize: st.size,
      isSidechain: false,
      sessionId: SESSION_B,
      projectPath: '/as/given',
    })
  })

  const limits: Array<[number | undefined, string[]]> = [
    [undefined, [SESSION_B, SESSION_C, SESSION_A]],
    [0, [SESSION_B, SESSION_C, SESSION_A]],
    [1, [SESSION_B]],
    [2, [SESSION_B, SESSION_C]],
    [5, [SESSION_B, SESSION_C, SESSION_A]],
  ]
  for (const [limit, ids] of limits) {
    test(`limit ${limit} keeps the ${ids.length} newest`, async () => {
      threeSessions()
      const logs = await getSessionFilesLite(world.sessionsDir, limit)
      expect(logs.map(l => l.sessionId)).toEqual(ids)
      expect(logs.every(l => l.projectPath === undefined)).toBe(true)
    })
  }

  test('a directory that does not exist gives an empty listing', async () => {
    expect(await getSessionFilesLite(join(world.root, 'nowhere'))).toEqual([])
  })
})

// --- enrichment ---------------------------------------------------------------

describe('enrichLogs on a transcript the real writer produced', () => {
  test('every field the session list shows is read from the head and tail', async () => {
    const file = join(world.sessionsDir, 'd1c2b3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d.jsonl')
    mkdirSync(world.sessionsDir, { recursive: true })
    copyFileSync(join(FIXTURES, 'written-session.jsonl'), file)
    const lite = await getSessionFilesLite(world.sessionsDir, undefined, world.project)
    const { logs, nextIndex } = await enrichLogs(lite, 0, 5)
    expect(nextIndex).toBe(1)
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'written-session.listed.json'), 'utf8')) as Record<string, unknown>
    const shown: Record<string, unknown> = Object.fromEntries(
      Object.keys(expected).map(key => [key, logs[0]![key as keyof LogOption] ?? null] as const),
    )
    expect(shown).toEqual(expected)
    expect(logs[0]).toMatchObject({ fullPath: file, isLite: false, messages: [], messageCount: 0 })
  })
})

describe('enrichLogs: what the head and tail of a small transcript say', () => {
  type Case = { name: string; lines: ReadonlyArray<Line | string>; shows: Partial<LogOption> }
  const cases: Case[] = [
    {
      name: 'the first real prompt titles the session, flattened, after meta lines and built-in commands',
      lines: chat([
        { kind: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>', extra: { isMeta: true } },
        { kind: 'user', content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' },
        { kind: 'user', content: 'Make the queue\nfair' },
      ]),
      shows: { firstPrompt: 'Make the queue fair' },
    },
    {
      name: 'the last last-prompt entry outranks the first prompt',
      lines: [...prompt('first thing'), meta.lastPrompt('older'), meta.lastPrompt('what I did last')],
      shows: { firstPrompt: 'what I did last' },
    },
    {
      name: 'an empty last-prompt entry falls back to the first prompt',
      lines: [...prompt('first thing'), meta.lastPrompt('')],
      shows: { firstPrompt: 'first thing' },
    },
    {
      name: 'with only commands typed, the first command names the session',
      lines: chat([
        { kind: 'user', content: '<command-name>/model</command-name>' },
        { kind: 'user', content: '<command-name>/clear</command-name>' },
      ]),
      shows: { firstPrompt: '/model' },
    },
    {
      name: 'with only a meta line, the start of its raw content is the title',
      lines: chat([{ kind: 'user', content: '<local-command-caveat>Caveat:\tread\nthis</local-command-caveat>', extra: { isMeta: true } }]),
      shows: { firstPrompt: '<local-command-caveat>Caveat: read this</local-command-caveat>' },
    },
    {
      name: 'no prompt and no title: "(session)"',
      lines: [{ type: 'file-history-snapshot', messageId: uid(1), snapshot: {}, isSnapshotUpdate: false }],
      shows: { firstPrompt: '(session)', customTitle: undefined },
    },
    {
      name: 'no prompt but a title: the title stands and the prompt stays empty',
      lines: [meta.title('Named only')],
      shows: { firstPrompt: '', customTitle: 'Named only' },
    },
    {
      name: 'the last custom title wins, and beats an AI title written after it',
      lines: [...prompt('p'), meta.title('First name'), meta.title('Second name'), meta.aiTitle('Machine name')],
      shows: { customTitle: 'Second name' },
    },
    {
      name: 'an AI title is shown as the custom title when the user never named the session',
      lines: [...prompt('p'), meta.aiTitle('Old guess'), meta.aiTitle('Machine name')],
      shows: { customTitle: 'Machine name' },
    },
    {
      name: 'a title value is decoded by JSON string rules',
      lines: [...prompt('p'), meta.title('Caf\u00e9 "quoted" \\ tab\there')],
      shows: { customTitle: 'Caf\u00e9 "quoted" \\ tab\there' },
    },
    {
      name: 'the last tag, the last branch, the head cwd and the head agent setting',
      lines: [
        ...chat([{ kind: 'user', content: 'p' }, { kind: 'assistant', content: 'r', extra: { gitBranch: 'feature/late' } }], { cwd: '/srv/app', branch: 'main' }),
        meta.tag('one'),
        meta.tag('two'),
        meta.agentSetting('reviewer'),
      ],
      shows: { tag: 'two', gitBranch: 'feature/late', projectPath: '/srv/app', agentSetting: 'reviewer' },
    },
    {
      name: 'no cwd anywhere: the project path the listing was given',
      lines: [meta.title('t')],
      shows: { projectPath: '/listed/from' },
    },
    {
      name: 'a numeric PR number, URL and repository from the last pr-link',
      lines: [...prompt('p'), meta.pr(3), meta.pr(42)],
      shows: { prNumber: 42, prUrl: 'https://github.com/acme/shop/pull/42', prRepository: 'acme/shop' },
    },
    {
      name: 'a PR number stored as a string is read as a number',
      lines: [...prompt('p'), meta.pr('17')],
      shows: { prNumber: 17 },
    },
    {
      name: 'a PR number written with a space after the colon is read too',
      lines: [...prompt('p'), '{"type":"pr-link","prNumber": 8,"prUrl":"u","prRepository":"r"}'],
      shows: { prNumber: 8, prUrl: 'u', prRepository: 'r' },
    },
    {
      name: 'a PR number of 0 or a non-number is no PR number',
      lines: [...prompt('p'), meta.pr(0)],
      shows: { prNumber: undefined },
    },
    {
      name: 'a non-numeric PR string is no PR number',
      lines: [...prompt('p'), meta.pr('abc')],
      shows: { prNumber: undefined },
    },
    {
      name: 'the cost of the last cost-state stamp',
      lines: [...prompt('p'), meta.cost(0.5), meta.cost(1.25)],
      shows: { costUSD: 1.25 },
    },
    {
      name: 'the text of the last summary entry, whatever leaf it names',
      lines: [...prompt('p'), meta.summary('older summary', 1), meta.summary('newer summary', 99)],
      shows: { summary: 'newer summary' },
    },
    {
      name: 'context size: all four token counts of the last reply that reports any',
      lines: chat([
        { kind: 'user', content: 'p' },
        billedReply('main', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 }),
        billedReply('synthetic', { input_tokens: 0, output_tokens: 0 }),
      ]),
      shows: { contextTokens: 3520 },
    },
    {
      name: 'context size with the cache counts missing or null',
      lines: chat([{ kind: 'user', content: 'p' }, billedReply('main', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null })]),
      shows: { contextTokens: 15 },
    },
    {
      name: 'no reply with usage: no context size, no cost',
      lines: chat([{ kind: 'user', content: 'p' }, { kind: 'assistant', content: 'r' }]),
      shows: { contextTokens: undefined, costUSD: undefined, summary: undefined, tag: undefined, prNumber: undefined },
    },
    {
      name: 'an empty file is listed as "(session)"',
      lines: [],
      shows: { firstPrompt: '(session)', isSidechain: false },
    },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      const shown = await listedAs(c.lines)
      expect(shown).not.toBeNull()
      for (const [key, value] of Object.entries(c.shows)) {
        expect([key, shown![key as keyof LogOption]]).toEqual([key, value])
      }
    })
  }

  test('an enriched record keeps the listing fields, is no longer flagged lite, and still loads in full on demand', async () => {
    const shown = await listedAs(prompt('p'))
    expect(shown).toMatchObject({ sessionId: SESSION_A, isLite: false, messages: [], messageCount: 0, value: 0 })
    expect(isLiteLog(shown!)).toBe(true)
  })

  test('a file that vanished after listing is shown as "(session)"', async () => {
    world.write(SESSION_A, prompt('p'))
    const lite = await getSessionFilesLite(world.sessionsDir)
    rmSync(lite[0]!.fullPath!)
    const { logs } = await enrichLogs(lite, 0, 1)
    expect(logs.map(l => l.firstPrompt)).toEqual(['(session)'])
  })
})

describe('enrichLogs: sessions that never reach the list', () => {
  const hidden: Array<[string, Line[]]> = [
    ['a sidechain transcript', chat([{ kind: 'user', content: 'p', extra: { isSidechain: true } }])],
    ['a teammate transcript', chat([{ kind: 'user', content: 'p', extra: { teamName: 'blue' } }])],
  ]
  for (const [name, lines] of hidden) {
    test(`${name} is dropped`, async () => {
      expect(await listedAs(lines)).toBeNull()
    })
  }

  test('a sidechain flag written with a space after the colon also hides the session', async () => {
    expect(await listedAs(['{"type":"user","isSidechain": true,"message":{"content":"p"}}'])).toBeNull()
  })

  test('scanning goes on past hidden sessions until enough are found, and reports where it stopped', async () => {
    const lines = (n: number, extra: Line = {}) => chat([{ kind: 'user', content: `prompt ${n}`, extra }])
    world.write(uid(1, 'aaaaaaaa'), lines(1), { mtime: 1_790_000_900 })
    world.write(uid(2, 'aaaaaaaa'), lines(2, { isSidechain: true }), { mtime: 1_790_000_800 })
    world.write(uid(3, 'aaaaaaaa'), lines(3, { teamName: 't' }), { mtime: 1_790_000_700 })
    world.write(uid(4, 'aaaaaaaa'), lines(4), { mtime: 1_790_000_600 })
    world.write(uid(5, 'aaaaaaaa'), lines(5), { mtime: 1_790_000_500 })
    const lite = await getSessionFilesLite(world.sessionsDir)

    const runs: Array<[number, number, string[], number]> = [
      [0, 2, ['prompt 1', 'prompt 4'], 4],
      [1, 1, ['prompt 4'], 4],
      [4, 9, ['prompt 5'], 5],
      [2, 0, [], 2],
      [7, 3, [], 7],
    ]
    for (const [start, count, prompts, next] of runs) {
      const { logs, nextIndex } = await enrichLogs(lite, start, count)
      expect([start, count, logs.map(l => l.firstPrompt), nextIndex]).toEqual([start, count, prompts, next])
    }
  })

  test('a record that is not lite, or has no file, is passed through as the same object', async () => {
    const full = { date: 'd', messages: [], value: 3, created: new Date(0), modified: new Date(0), firstPrompt: 'kept', messageCount: 1, isSidechain: true } as LogOption
    const pathless = { ...full, isLite: true, fullPath: undefined }
    const { logs } = await enrichLogs([full, pathless], 0, 5)
    expect(logs[0]).toBe(full)
    expect(logs[1]).toBe(pathless)
  })
})

describe('enrichLogs: a transcript larger than the two 64 KiB windows', () => {
  // A ~70 KiB line in the middle keeps head and tail apart.
  const middle = (extra: Line[] = []) => [...chat([{ kind: 'user', content: padding(70), n: 50, parent: 2, t: 30 }]), ...extra]
  const secondMiddle = chat([{ kind: 'assistant', content: padding(70), n: 51, parent: 50, t: 31 }])
  const opening = chat([{ kind: 'user', content: 'Opening prompt' }, { kind: 'assistant', content: 'ok' }], { branch: 'early' })
  const closing = chat([{ kind: 'assistant', content: 'closing', n: 60, parent: 50, t: 40 }], { branch: 'late' })

  type Case = { name: string; lines: ReadonlyArray<Line | string>; shows: Partial<LogOption> }
  const cases: Case[] = [
    {
      name: 'metadata in the middle is not seen',
      lines: [...opening, ...middle([meta.title('lost'), meta.tag('lost'), meta.summary('lost', 2), meta.cost(9)]), ...secondMiddle, ...closing],
      shows: { customTitle: undefined, tag: undefined, summary: undefined, costUSD: undefined, firstPrompt: 'Opening prompt' },
    },
    {
      name: 'a title only in the head is still found; a tag only in the head is not',
      lines: [...opening, meta.title('Head title'), meta.tag('head-tag'), ...middle(), ...closing],
      shows: { customTitle: 'Head title', tag: undefined },
    },
    {
      name: 'an AI title in the tail beats one in the head',
      lines: [...opening, meta.aiTitle('head guess'), ...middle(), ...closing, meta.aiTitle('tail guess')],
      shows: { customTitle: 'tail guess' },
    },
    {
      name: 'a custom title in the head beats an AI title in the tail',
      lines: [...opening, meta.title('Head title'), ...middle(), ...closing, meta.aiTitle('tail guess')],
      shows: { customTitle: 'Head title' },
    },
    {
      name: 'the branch is the last one in the tail',
      lines: [...opening, ...middle(), ...closing],
      shows: { gitBranch: 'late' },
    },
    {
      name: 'a last-prompt entry only in the head is not used',
      lines: [...opening, meta.lastPrompt('head last prompt'), ...middle(), ...closing],
      shows: { firstPrompt: 'Opening prompt' },
    },
    {
      name: 'context size skips a sidechain reply, which only the tail holds here',
      lines: [
        ...opening,
        ...middle(),
        ...chat([
          billedReply('main', { input_tokens: 1, output_tokens: 2 }),
          billedReply('side', { input_tokens: 7, output_tokens: 7 }, { isSidechain: true }),
        ]),
      ],
      shows: { contextTokens: 3, isSidechain: false },
    },
    {
      name: 'a sidechain flag beyond the head does not hide the session',
      lines: [...opening, ...middle(), ...chat([{ kind: 'user', content: 'late', n: 70, extra: { isSidechain: true } }])],
      shows: { isSidechain: false },
    },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      const shown = await listedAs(c.lines)
      for (const [key, value] of Object.entries(c.shows)) {
        expect([key, shown![key as keyof LogOption]]).toEqual([key, value])
      }
    })
  }

  test('with a branch nowhere in the tail, the first one in the head is used', async () => {
    const twoBranches = chat([
      { kind: 'user', content: 'Opening prompt', extra: { gitBranch: 'first' } },
      { kind: 'assistant', content: 'ok', extra: { gitBranch: 'second' } },
    ])
    const branchless = middle().map(line => {
      const { gitBranch: _dropped, ...rest } = line
      return rest
    })
    const shown = await listedAs([...twoBranches, ...branchless, meta.title('t'), meta.tag('x')])
    expect(shown!.gitBranch).toBe('first')
  })

  const truncated: Array<[string, unknown, string]> = [
    ['a string prompt', `First line\nsecond\tline ${padding(70)}`, `First line second line ${padding(70)}`.slice(0, 200).trim()],
    ['a prompt in text blocks', [{ type: 'text', text: `Block text ${padding(70)}` }], `Block text ${padding(70)}`.slice(0, 200).trim()],
  ]
  for (const [name, content, title] of truncated) {
    test(`a first line cut by the head window: the first 200 characters of ${name} title the session`, async () => {
      const shown = await listedAs([...chat([{ kind: 'user', content }]), ...closing])
      expect(shown!.firstPrompt).toBe(title)
    })
  }
})

// --- the project's own listing ------------------------------------------------

describe('fetchLogs, loadMessageLogs and getLogByIndex: the current project', () => {
  function project() {
    world.write(SESSION_A, chat([{ kind: 'user', content: 'oldest' }]), { mtime: 1_790_000_100 })
    world.write(SESSION_B, chat([{ kind: 'user', content: 'hidden', extra: { isSidechain: true } }]), { mtime: 1_790_000_300 })
    world.write(SESSION_C, chat([{ kind: 'user', content: 'newest' }]), { mtime: 1_790_000_400 })
    // another project's session is never listed
    world.write(uid(9), chat([{ kind: 'user', content: 'elsewhere' }]), { dir: join(world.root, 'home', 'projects', '-other') })
  }

  test('fetchLogs lists the stat-only records of the original cwd, tagged with that cwd', async () => {
    project()
    const logs = await fetchLogs()
    expect(logs.map(l => [l.sessionId, l.isLite, l.projectPath, l.value])).toEqual([
      [SESSION_C, true, world.project, 0],
      [SESSION_B, true, world.project, 1],
      [SESSION_A, true, world.project, 2],
    ])
    expect((await fetchLogs(1)).map(l => l.sessionId)).toEqual([SESSION_C])
  })

  test('loadMessageLogs enriches, drops hidden sessions and renumbers newest first', async () => {
    project()
    const logs = await loadMessageLogs()
    expect(logs.map(l => [l.firstPrompt, l.value, l.isLite])).toEqual([
      ['newest', 0, false],
      ['oldest', 1, false],
    ])
  })

  test('the limit counts files before hidden ones are dropped', async () => {
    project()
    expect((await loadMessageLogs(2)).map(l => l.firstPrompt)).toEqual(['newest'])
  })

  test('getLogByIndex picks from that list, and null past its end', async () => {
    project()
    const picked = await Promise.all([0, 1, 2].map(i => getLogByIndex(i)))
    expect(picked.map(l => l?.firstPrompt ?? null)).toEqual(['newest', 'oldest', null])
  })

  test('a project with no session directory lists nothing', async () => {
    expect([await fetchLogs(), await loadMessageLogs(), await getLogByIndex(0)]).toEqual([[], [], null])
  })
})
