/**
 * Characterization of reading a transcript file for a resume, pinned before
 * the clean-base rewrite of `sessions/resume`: which lines become messages and
 * which become session metadata, what is validated, how legacy shapes are
 * bridged, which entries count as conversation tips, and what a transcript
 * over 5 MiB loads. Also the snapshot-chain builders that turn the loaded
 * snapshots into what a resume restores.
 *
 * The inputs are JSONL files in temp directories: two committed fixtures (one
 * recorded through the session persistence module, one assembled to hold every
 * other kind of line) and files built by the suite.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  compactBoundary,
  id,
  type Line,
  notice,
  prompt,
  reply,
  scratchDirs,
  SESSION,
  writeJsonl,
} from 'src/sessions/__testutils__/resumeTranscripts.js'
import {
  buildAttributionSnapshotChain,
  buildFileHistorySnapshotChain,
  loadTranscriptFile,
} from 'src/sessions/sessionStorage.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const RECORDED = join(FIXTURES, 'recorded-session.jsonl')
const ASSORTED = join(FIXTURES, 'assorted-entries.jsonl')
const RECORDED_SESSION = '5e55104e-0000-4000-8000-000000000001'
const PERSISTED_OUTPUT = join(import.meta.dir, '..', '__fixtures__', 'rewrite', 'persisted-output.input.jsonl')

const dirs = scratchDirs('resume-load-')
afterEach(() => {
  dirs.cleanup()
  delete process.env.CLAUDIN_DISABLE_PRECOMPACT_SKIP
})

const plain = <K, V>(map: Map<K, V>) => Object.fromEntries(map)
const keysOf = (map: Map<UUID, unknown>) => [...map.keys()]
const ids = (...numbers: number[]) => numbers.map(id)

function fileOf(lines: Array<Line | string>, name = 'session.jsonl'): string {
  return writeJsonl(join(dirs.make(), name), lines)
}

// --- a recorded session -------------------------------------------------------

describe('loadTranscriptFile — a session recorded by the CLI', () => {
  test('messages, keyed by uuid in file order, and the latest exchange as the only tip', async () => {
    const loaded = await loadTranscriptFile(RECORDED)
    const recorded = ['101', '102', '103'].map(n => `0000c0de-0000-4000-8000-000000000${n}`)
    expect(keysOf(loaded.messages) as unknown[]).toEqual(recorded)
    expect([...loaded.leafUuids] as unknown[]).toEqual([recorded[2]])
  })

  test('session metadata, keyed by session id, the later line winning', async () => {
    const loaded = await loadTranscriptFile(RECORDED)
    const s = RECORDED_SESSION
    expect({
      customTitles: plain(loaded.customTitles),
      tags: plain(loaded.tags),
      agentNames: plain(loaded.agentNames),
      agentColors: plain(loaded.agentColors),
      agentSettings: plain(loaded.agentSettings),
      prNumbers: plain(loaded.prNumbers),
      prUrls: plain(loaded.prUrls),
      prRepositories: plain(loaded.prRepositories),
      modes: plain(loaded.modes),
      summaries: plain(loaded.summaries),
    }).toEqual({
      customTitles: { [s]: 'Parser rewrite' },
      tags: { [s]: 'parser' },
      agentNames: { [s]: 'Ada' },
      agentColors: { [s]: 'cyan' },
      agentSettings: { [s]: 'reviewer' },
      prNumbers: { [s]: 42 },
      prUrls: { [s]: 'https://github.com/acme/shop/pull/42' },
      prRepositories: { [s]: 'acme/shop' },
      modes: {},
      summaries: {},
    })
    expect(loaded.worktreeStates.get(s as UUID)).toEqual({
      originalCwd: '/work/app',
      worktreePath: '/work/app/.claudin/worktrees/parser',
      worktreeName: 'parser',
      worktreeBranch: 'parser',
      originalBranch: 'main',
      sessionId: 'x',
    })
  })

  test('the cost line comes back whole, and the file-history snapshot under the message it belongs to', async () => {
    const loaded = await loadTranscriptFile(RECORDED)
    const lines = readFileSync(RECORDED, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(loaded.costStates.get(RECORDED_SESSION as UUID)).toEqual(lines.find(l => l.type === 'cost-state'))
    expect(plain(loaded.fileHistorySnapshots)).toEqual({
      '0000c0de-0000-4000-8000-000000000101': lines.find(l => l.type === 'file-history-snapshot'),
    })
    expect(loaded.attributionSnapshots.size).toBe(0)
    expect(loaded.contextCollapseCommits).toEqual([])
    expect(loaded.contextCollapseSnapshot).toBeUndefined()
  })
})

// --- every other kind of line ---------------------------------------------------

describe('loadTranscriptFile — legacy, collapse and unknown lines', () => {
  test('only user, assistant, attachment and system lines become messages', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect(keysOf(loaded.messages)).toEqual(ids(201, 202, 203, 204, 205, 206))
  })

  test('a reply written under old progress entries is re-parented to the message before them', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect(loaded.messages.get(id(202))!.parentUuid).toBe(id(201))
  })

  test('collapse commits before a compact boundary are dropped, the later snapshot wins', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect(loaded.contextCollapseCommits.map(c => c.collapseId)).toEqual(['0000000000000002'])
    expect(loaded.contextCollapseSnapshot).toMatchObject({ lastSpawnTokens: 200, staged: [] })
  })

  test('summaries are keyed by the tip they describe, the mode and the last tag by session', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect(plain(loaded.summaries)).toEqual({ [id(205)]: 'Migration finished' })
    expect(plain(loaded.modes)).toEqual({ [SESSION]: 'coordinator' })
    expect(plain(loaded.tags)).toEqual({ [SESSION]: 'second-tag' })
    expect(loaded.customTitles.size).toBe(0)
  })

  test('attribution snapshots are keyed by message id, and all of them reach the chain builder', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect(keysOf(loaded.attributionSnapshots)).toEqual(ids(204, 205))
    const chain = buildAttributionSnapshotChain(loaded.attributionSnapshots, [])
    expect(chain.map(s => s.fileStates['src/a.ts']!.contentHash)).toEqual(['aa', 'bb'])
  })

  test('a terminal hook attachment makes its reply a tip; the reply before a plain boundary stays one too', async () => {
    const loaded = await loadTranscriptFile(ASSORTED)
    expect([...loaded.leafUuids].sort()).toEqual(ids(202, 205))
  })

  test('the raw output of a tool result saved to disk is not loaded; an ordinary one is', async () => {
    const loaded = await loadTranscriptFile(PERSISTED_OUTPUT)
    const result = (n: number) =>
      (loaded.messages.get(`c0ffee00-0000-4000-8000-00000000000${n}` as UUID) as { toolUseResult?: unknown })
        .toolUseResult
    expect(result(3)).toBeUndefined()
    expect(result(5)).toMatchObject({ type: 'text' })
  })
})

describe('loadTranscriptFile — cost lines are validated', () => {
  const valid = {
    type: 'cost-state',
    sessionId: SESSION,
    totalCostUSD: 1.5,
    totalAPIDuration: 10,
    totalAPIDurationWithoutRetries: 9,
    totalToolDuration: 3,
    totalLinesAdded: 4,
    totalLinesRemoved: 2,
    totalDuration: 30,
    startTime: 1_790_000_000_000,
    modelUsage: {
      'model-a': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 1.5,
      },
    },
  }
  const later = (change: Record<string, unknown>) => ({ ...valid, totalCostUSD: 2, ...change })
  const usage = valid.modelUsage['model-a']
  const cases: Array<{ name: string; second: Record<string, unknown>; wins: boolean }> = [
    { name: 'a valid later line', second: later({}), wins: true },
    { name: 'the unknown-cost flag', second: later({ hasUnknownModelCost: true }), wins: true },
    { name: 'a cost of exactly 1e9', second: later({ totalCostUSD: 1e9 }), wins: true },
    { name: 'a negative cost', second: later({ totalCostUSD: -1 }), wins: false },
    { name: 'a cost over 1e9', second: later({ totalCostUSD: 1e9 + 1 }), wins: false },
    { name: 'a negative duration', second: later({ totalToolDuration: -5 }), wins: false },
    { name: 'a missing field', second: later({ totalLinesAdded: undefined }), wins: false },
    { name: 'a cost given as text', second: later({ totalCostUSD: '2' }), wins: false },
    { name: 'a model name with a control character', second: later({ modelUsage: { 'model\u001b[2J': usage } }), wins: false },
    { name: 'a model name with a format character', second: later({ modelUsage: { 'model\u202e': usage } }), wins: false },
    { name: 'an empty model name', second: later({ modelUsage: { '': usage } }), wins: false },
    { name: 'negative tokens for a model', second: later({ modelUsage: { 'model-a': { ...usage, inputTokens: -1 } } }), wins: false },
    { name: 'a non-boolean unknown-cost flag', second: later({ hasUnknownModelCost: 'yes' }), wins: false },
  ]
  for (const c of cases) {
    test(`${c.name}: ${c.wins ? 'replaces' : 'leaves'} the earlier cost`, async () => {
      const loaded = await loadTranscriptFile(fileOf([valid, c.second]))
      expect(loaded.costStates.get(SESSION)?.totalCostUSD).toBe(c.wins ? (c.second.totalCostUSD as number) : 1.5)
    })
  }

  test('an invalid line alone leaves no cost at all', async () => {
    const loaded = await loadTranscriptFile(fileOf([later({ totalCostUSD: -3 })]))
    expect(loaded.costStates.size).toBe(0)
  })
})

describe('loadTranscriptFile — files that are missing or odd', () => {
  test('a missing file loads as an empty transcript', async () => {
    const loaded = await loadTranscriptFile(join(dirs.make(), 'gone.jsonl'))
    expect(loaded.messages.size).toBe(0)
    expect(loaded.leafUuids.size).toBe(0)
    expect(loaded.customTitles.size).toBe(0)
  })

  test('a directory where the file should be loads as an empty transcript', async () => {
    const loaded = await loadTranscriptFile(dirs.make())
    expect(loaded.messages.size).toBe(0)
  })

  test('entries with no user or assistant ancestor are not tips, and a parent loop does not hang', async () => {
    const loaded = await loadTranscriptFile(
      fileOf([
        notice(id(1), 'a lone notice'),
        notice(id(2), 'loop a', { parent: id(3) }),
        notice(id(3), 'loop b', { parent: id(2) }),
        notice(id(4), 'into the loop', { parent: id(2) }),
        prompt(id(5), 'a real prompt'),
        notice(id(6), 'after the prompt', { parent: id(5) }),
      ]),
    )
    expect([...loaded.leafUuids]).toEqual(ids(5))
  })

  test('snip removals are replayed on load', async () => {
    const loaded = await loadTranscriptFile(
      fileOf([
        prompt(id(1), 'one'),
        reply(id(2), 'two', { parent: id(1) }),
        prompt(id(3), 'three', { parent: id(2) }),
        notice(id(4), 'snipped', { parent: id(3), more: { snipMetadata: { removedUuids: [id(2)] } } }),
      ]),
    )
    expect(keysOf(loaded.messages)).toEqual(ids(1, 3, 4))
    expect(loaded.messages.get(id(3))!.parentUuid).toBe(id(1))
  })

  test('a preserved segment that cannot be walked keeps only what follows the boundary', async () => {
    const loaded = await loadTranscriptFile(
      fileOf([
        prompt(id(1), 'old'),
        reply(id(2), 'old answer', { parent: id(1) }),
        compactBoundary(id(3), { preserved: { headUuid: id(1), anchorUuid: id(4), tailUuid: id(70) } }),
        prompt(id(4), 'summary', { parent: id(3) }),
      ]),
    )
    expect(keysOf(loaded.messages)).toEqual(ids(3, 4))
  })
})

// --- transcripts over 5 MiB ----------------------------------------------------

const BULK = 'x'.repeat(5.5 * 1024 * 1024)

const metadataBeforeTheCut = [
  { type: 'custom-title', sessionId: SESSION, customTitle: 'Before the cut' },
  { type: 'tag', sessionId: SESSION, tag: 'early' },
  { type: 'agent-name', sessionId: SESSION, agentName: 'Bea' },
  { type: 'agent-color', sessionId: SESSION, agentColor: 'green' },
  { type: 'agent-setting', sessionId: SESSION, agentSetting: 'planner' },
  { type: 'mode', sessionId: SESSION, mode: 'normal' },
  { type: 'worktree-state', sessionId: SESSION, worktreeSession: null },
  { type: 'pr-link', sessionId: SESSION, prNumber: 7, prUrl: 'https://example.test/pr/7', prRepository: 'acme/app', timestamp: '2026-09-30T09:00:00.000Z' },
  { type: 'summary', summary: 'early summary', leafUuid: id(302) },
]

function largeCompacted(): string {
  return fileOf([
    ...metadataBeforeTheCut,
    prompt(id(301), BULK, { at: 1 }),
    reply(id(302), 'bulk read', { parent: id(301), at: 2 }),
    { type: 'attribution-snapshot', messageId: id(302), surface: 'cli', fileStates: {} },
    { type: 'cost-state', sessionId: SESSION, totalCostUSD: -1 },
    compactBoundary(id(303), { at: 3 }),
    prompt(id(304), 'after the cut', { parent: id(303), at: 4 }),
    { type: 'attribution-snapshot', messageId: id(304), surface: 'cli', fileStates: {} },
    reply(id(305), 'still here', { parent: id(304), at: 5 }),
    { type: 'attribution-snapshot', messageId: id(305), surface: 'cli', fileStates: {} },
  ])
}

function largeForked(): string {
  return fileOf([
    prompt(id(401), 'start', { at: 1 }),
    reply(id(402), 'started', { parent: id(401), at: 2 }),
    prompt(id(403), BULK, { parent: id(402), at: 3 }),
    reply(id(404), 'abandoned answer', { parent: id(403), at: 4 }),
    { type: 'custom-title', sessionId: SESSION, customTitle: 'Forked' },
    prompt(id(405), 'kept', { parent: id(402), at: 5 }),
    reply(id(406), 'kept answer', { parent: id(405), at: 6 }),
  ])
}

describe('loadTranscriptFile — a transcript over 5 MiB', () => {
  test('starts at the last compact boundary, and still reads the session metadata written before it', async () => {
    const loaded = await loadTranscriptFile(largeCompacted())
    expect(keysOf(loaded.messages)).toEqual(ids(303, 304, 305))
    expect({
      title: loaded.customTitles.get(SESSION),
      tag: loaded.tags.get(SESSION),
      name: loaded.agentNames.get(SESSION),
      color: loaded.agentColors.get(SESSION),
      setting: loaded.agentSettings.get(SESSION),
      mode: loaded.modes.get(SESSION),
      worktree: loaded.worktreeStates.get(SESSION),
      pr: [loaded.prNumbers.get(SESSION), loaded.prUrls.get(SESSION), loaded.prRepositories.get(SESSION)],
      summary: loaded.summaries.get(id(302)),
      cost: loaded.costStates.has(SESSION),
    }).toEqual({
      title: 'Before the cut',
      tag: 'early',
      name: 'Bea',
      color: 'green',
      setting: 'planner',
      mode: 'normal',
      worktree: null,
      pr: [7, 'https://example.test/pr/7', 'acme/app'],
      summary: 'early summary',
      cost: false,
    })
  })

  test('keeps only the last attribution snapshot after the boundary', async () => {
    const loaded = await loadTranscriptFile(largeCompacted())
    expect(keysOf(loaded.attributionSnapshots)).toEqual(ids(305))
  })

  test('drops an abandoned branch that holds most of the bytes before parsing, and keeps metadata lines', async () => {
    const loaded = await loadTranscriptFile(largeForked())
    expect(keysOf(loaded.messages)).toEqual(ids(401, 402, 405, 406))
    expect(loaded.customTitles.get(SESSION)).toBe('Forked')
  })

  test('keeps every branch when the caller asks for all tips', async () => {
    const loaded = await loadTranscriptFile(largeForked(), { keepAllLeaves: true })
    expect(keysOf(loaded.messages)).toEqual(ids(401, 402, 403, 404, 405, 406))
    expect([...loaded.leafUuids].sort()).toEqual(ids(404, 406))
  })

  test('CLAUDIN_DISABLE_PRECOMPACT_SKIP loads everything: every branch, and what precedes the boundary', async () => {
    process.env.CLAUDIN_DISABLE_PRECOMPACT_SKIP = '1'
    const forked = await loadTranscriptFile(largeForked())
    expect(keysOf(forked.messages)).toEqual(ids(401, 402, 403, 404, 405, 406))
    const compacted = await loadTranscriptFile(largeCompacted())
    expect(keysOf(compacted.messages)).toEqual(ids(301, 302, 303, 304, 305))
    expect(keysOf(compacted.attributionSnapshots)).toEqual(ids(302, 304, 305))
  })

  test('with a preserved segment nothing is skipped before parsing, and the segment is spliced in', async () => {
    const loaded = await loadTranscriptFile(
      fileOf([
        prompt(id(1), BULK),
        reply(id(2), 'old answer', { parent: id(1) }),
        prompt(id(3), 'kept question', { parent: id(2) }),
        reply(id(4), 'kept answer', { parent: id(3) }),
        prompt(id(9), 'a dead branch', { parent: id(2) }),
        compactBoundary(id(5), { preserved: { headUuid: id(3), anchorUuid: id(6), tailUuid: id(4) } }),
        prompt(id(6), 'summary', { parent: id(5) }),
        prompt(id(7), 'next', { parent: id(6) }),
      ]),
    )
    expect(keysOf(loaded.messages)).toEqual(ids(3, 4, 5, 6, 7))
    expect(loaded.messages.get(id(3))!.parentUuid).toBe(id(6))
    expect(loaded.messages.get(id(7))!.parentUuid).toBe(id(4))
  })
})

// --- snapshot chains ----------------------------------------------------------

describe('buildFileHistorySnapshotChain', () => {
  type Snap = { messageId: UUID; trackedFileBackups: Record<string, unknown>; timestamp: Date }
  const snap = (of: number, version: number): Snap => ({
    messageId: id(of),
    trackedFileBackups: { '/work/app/a.ts': { backupFileName: `a@v${version}`, version, backupTime: new Date(0) } },
    timestamp: new Date(version),
  })
  const entry = (under: number, snapshot: Snap, isSnapshotUpdate: boolean) =>
    [id(under), { type: 'file-history-snapshot', messageId: id(under), snapshot, isSnapshotUpdate }] as const
  const conversation = (...numbers: number[]) => numbers.map(n => ({ uuid: id(n) }) as TranscriptMessage)
  const versions = (chain: Array<{ trackedFileBackups: Record<string, { version?: number }> }>) =>
    chain.map(s => s.trackedFileBackups['/work/app/a.ts']!.version)

  const cases = [
    {
      name: 'one snapshot per message, in conversation order',
      entries: [entry(2, snap(2, 2), false), entry(1, snap(1, 1), false)],
      conversation: conversation(1, 2, 3),
      versions: [1, 2],
    },
    {
      name: 'an update replaces the snapshot of the message it names, in place',
      entries: [entry(1, snap(1, 1), false), entry(2, snap(2, 2), false), entry(3, snap(1, 3), true)],
      conversation: conversation(1, 2, 3),
      versions: [3, 2],
    },
    {
      name: 'an update for a message with no snapshot yet is appended',
      entries: [entry(1, snap(1, 1), false), entry(3, snap(9, 4), true)],
      conversation: conversation(1, 3),
      versions: [1, 4],
    },
    {
      name: 'a non-update for the same message is appended, not merged',
      entries: [entry(1, snap(1, 1), false), entry(2, snap(1, 5), false)],
      conversation: conversation(1, 2),
      versions: [1, 5],
    },
    {
      name: 'snapshots of messages off the conversation are left out',
      entries: [entry(1, snap(1, 1), false), entry(8, snap(8, 8), false)],
      conversation: conversation(1, 2),
      versions: [1],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const chain = buildFileHistorySnapshotChain(new Map(c.entries) as never, c.conversation)
      expect(versions(chain as never)).toEqual(c.versions)
    })
  }
})
