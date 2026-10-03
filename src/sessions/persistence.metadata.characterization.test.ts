/**
 * Characterization of session metadata in the transcript
 * (`sessions/persistence`): the `save*` writers and their line shapes, the
 * per-session cache behind the `getCurrent*` getters, what is only cached
 * until the file exists, and the re-append of the cached metadata at the end
 * of the file (after compaction, on resume, at exit), which keeps it inside
 * the 64 KiB tail the session list reads.
 */
import { describe, expect, setSystemTime, test } from 'bun:test'
import type { UUID } from 'crypto'
import { appendFileSync, existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'

import { resetCostStateOwnerForTesting } from 'src/agent/cost-tracker.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getSessionId, setSessionPersistenceDisabled, switchSession } from 'src/platform/bootstrap/state.js'
import { runChild, usePersistenceSandbox } from 'src/sessions/__testutils__/persistenceSandbox.js'
import {
  adoptResumedSessionFile,
  cacheSessionTitle,
  clearSessionMetadata,
  flushSessionStorage,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  getProject,
  linkSessionToPR,
  reAppendSessionMetadata,
  recordSidechainTranscript,
  recordTranscript,
  resetProjectForTesting,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { PersistedWorktreeSession } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = usePersistenceSandbox()

const AT = '2026-03-14T09:26:53.000Z'
const FIXTURES = join(import.meta.dir, 'persistence', '__fixtures__', 'rewrite')

const current = (): UUID => getSessionId() as UUID

function uuidOf(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function prompt(n: number, content: Parameters<typeof createUserMessage>[0]['content'], extra = {}): Message {
  return createUserMessage({ content, uuid: uuidOf(n), timestamp: AT, ...extra })
}

/** Record one prompt, so the transcript file exists and is the open one. */
async function openTranscript(): Promise<void> {
  await recordTranscript([prompt(1, 'start')])
  await flushSessionStorage()
}

/** A new session whose transcript is open, with nothing cached. */
async function freshTranscript(): Promise<void> {
  switchSession(asSessionId(crypto.randomUUID()))
  resetProjectForTesting()
  await openTranscript()
  clearSessionMetadata()
}

/** The entries `act` appends to the current transcript. */
async function appendedBy(act: () => unknown): Promise<Array<Record<string, unknown>>> {
  const before = sandbox.entries().length
  await act()
  await flushSessionStorage()
  return sandbox.entries().slice(before)
}

const WORKTREE: PersistedWorktreeSession = {
  originalCwd: '/work/app',
  worktreePath: '/work/app/.claudin/worktrees/fix',
  worktreeName: 'fix',
  worktreeBranch: 'worktree-fix',
  originalBranch: 'main',
  originalHeadCommit: 'abc123',
  sessionId: 'worktree-session',
  tmuxSessionName: 'tmux-1',
  hookBased: false,
  attached: true,
}

describe('the save* writers', () => {
  test('each writes one line at once, in its own shape, creating a private file if needed', async () => {
    setSystemTime(new Date(AT))
    const id = asSessionId('5e551011-0000-4000-8000-00000000a7a7') as unknown as UUID
    switchSession(asSessionId(id))

    await saveCustomTitle(id, 'Parser fixes', undefined, 'auto')
    saveAiGeneratedTitle(id, 'Fix the parser')
    saveTaskSummary(id, 'Running the tests')
    await saveTag(id, 'bugfix')
    await linkSessionToPR(id, 42, 'https://github.test/o/r/pull/42', 'o/r')
    await saveAgentName(id, 'Scout')
    await saveAgentColor(id, 'blue')

    const expected = readFileSync(join(FIXTURES, 'metadata.jsonl'), 'utf8')
    expect(sandbox.normalize(sandbox.text())).toBe(expected)
  })

  test('a missing project directory is created private; a new file in an existing one is private too', async () => {
    await saveTag(current(), 'first')
    expect(statSync(dirname(sandbox.transcript())).mode & 0o777).toBe(0o700)

    const other = '0ddba11c-0000-4000-8000-0000000000ff' as UUID
    await saveTag(other, 'second')
    expect(statSync(join(dirname(sandbox.transcript()), `${other}.jsonl`)).mode & 0o777).toBe(0o600)
  })

  test('the current session also caches what the getters return', async () => {
    const id = current()
    await saveCustomTitle(id, 'Title')
    await saveTag(id, 'tag')
    await saveAgentColor(id, 'green')
    saveAiGeneratedTitle(id, 'Not cached')
    expect([getCurrentSessionTitle(asSessionId(id)), getCurrentSessionTag(id), getCurrentSessionAgentColor()]).toEqual([
      'Title',
      'tag',
      'green',
    ])
  })

  test('another session: its file in the current project is written, the cache is left alone', async () => {
    await saveCustomTitle(current(), 'Mine')
    const other = '0ddba11c-0000-4000-8000-000000000000' as UUID
    for (const save of [
      () => saveCustomTitle(other, 'Theirs'),
      () => saveTag(other, 'their-tag'),
      () => saveAgentName(other, 'Them'),
      () => saveAgentColor(other, 'red'),
      () => linkSessionToPR(other, 1, 'u', 'r'),
    ]) {
      await save()
    }
    const theirs = join(dirname(sandbox.transcript()), `${other}.jsonl`)
    expect(sandbox.entries(theirs).map(e => e.type)).toEqual(['custom-title', 'tag', 'agent-name', 'agent-color', 'pr-link'])
    expect([getCurrentSessionTitle(asSessionId(current())), getCurrentSessionTag(current()), getCurrentSessionAgentColor()]).toEqual([
      'Mine',
      undefined,
      undefined,
    ])
    expect([getCurrentSessionTitle(asSessionId(other)), getCurrentSessionTag(other)]).toEqual([undefined, undefined])
  })

  test('an explicit path is written instead of the computed one, and still caches for the current session', async () => {
    const elsewhere = join(sandbox.root, 'elsewhere', 'session.jsonl')
    const id = current()
    await saveCustomTitle(id, 'Here', elsewhere)
    await saveTag(id, 'here-tag', elsewhere)
    await saveAgentName(id, 'Here', elsewhere)
    await saveAgentColor(id, 'cyan', elsewhere)
    await linkSessionToPR(id, 3, 'u3', 'r3', elsewhere)
    expect(sandbox.entries(elsewhere).map(e => e.type)).toEqual(['custom-title', 'tag', 'agent-name', 'agent-color', 'pr-link'])
    expect(existsSync(sandbox.transcript())).toBe(false)
    expect(getCurrentSessionTitle(asSessionId(id))).toBe('Here')
    expect(getCurrentSessionTag(id)).toBe('here-tag')
  })

  test('a save lands at once, ahead of messages still waiting in the write queue', async () => {
    await openTranscript()
    await recordTranscript([prompt(1, 'start'), prompt(2, 'queued')])
    await saveTag(current(), 'now')
    await flushSessionStorage()
    expect(sandbox.entries().map(e => e.type)).toEqual(['user', 'tag', 'user'])
  })
})

describe('what is only cached until the file exists', () => {
  test('a title, an agent setting, a mode and a worktree write nothing until the first message, then lead the file', async () => {
    cacheSessionTitle('Named at launch')
    saveAgentSetting('reviewer')
    saveMode('coordinator')
    saveWorktreeState(WORKTREE)
    expect(existsSync(dirname(sandbox.transcript()))).toBe(false)
    expect(getCurrentSessionTitle(asSessionId(current()))).toBe('Named at launch')

    await openTranscript()
    expect(sandbox.entries().map(e => e.type)).toEqual(['custom-title', 'agent-setting', 'mode', 'worktree-state', 'user'])
  })

  test('saveWorktreeState keeps the ten persisted fields, and writes at once when the file exists', async () => {
    const extra = { ...WORKTREE, creationDurationMs: 812, usedSparsePaths: true }
    saveWorktreeState(extra)
    expect(getProject().currentSessionWorktree).toEqual(WORKTREE)

    await openTranscript()
    const appended = await appendedBy(() => saveWorktreeState(null))
    expect(appended).toEqual([{ type: 'worktree-state', worktreeSession: null, sessionId: current() }])
    expect(getProject().currentSessionWorktree).toBeNull()

    const line = sandbox.text().split('\n').find(l => l.includes('"worktreeName"'))!
    expect(line).toBe(`{"type":"worktree-state","worktreeSession":${JSON.stringify(WORKTREE)},"sessionId":"${current()}"}`)
  })

  test('no worktree touched: undefined, and nothing is written', async () => {
    expect(getProject().currentSessionWorktree).toBeUndefined()
    await openTranscript()
    expect(sandbox.entries().map(e => e.type)).toEqual(['user'])
  })
})

describe('the getters', () => {
  test('title and tag answer for the current session only; the color needs no id', async () => {
    restoreSessionMetadata({ customTitle: 'T', tag: 'g', agentColor: 'pink' })
    const cases: Array<[string, unknown, unknown]> = [
      ['title, current', getCurrentSessionTitle(asSessionId(current())), 'T'],
      ['title, other', getCurrentSessionTitle(asSessionId(uuidOf(5))), undefined],
      ['tag, current', getCurrentSessionTag(current()), 'g'],
      ['tag, other', getCurrentSessionTag(uuidOf(5)), undefined],
      ['color', getCurrentSessionAgentColor(), 'pink'],
    ]
    for (const [name, actual, wanted] of cases) expect({ name, actual }).toEqual({ name, actual: wanted })

    restoreSessionMetadata({ tag: '' })
    expect(getCurrentSessionTag(current())).toBeUndefined()
  })
})

describe('re-appending the metadata', () => {
  test('every cached field, in a fixed order, matching the fixture', async () => {
    setSystemTime(new Date(AT))
    switchSession(asSessionId('5e551011-0000-4000-8000-00000000beef'))
    await openTranscript()
    restoreSessionMetadata({
      customTitle: 'Parser fixes',
      tag: 'bugfix',
      agentName: 'Scout',
      agentColor: 'blue',
      agentSetting: 'reviewer',
      mode: 'normal',
      worktreeSession: WORKTREE,
      prNumber: 42,
      prUrl: 'https://github.test/o/r/pull/42',
      prRepository: 'o/r',
    })
    const before = sandbox.text()
    reAppendSessionMetadata()

    const expected = readFileSync(join(FIXTURES, 'reappended.jsonl'), 'utf8')
    expect(sandbox.normalize(sandbox.text().slice(before.length))).toBe(expected)
  })

  test('nothing is written before the file exists, or with nothing cached', async () => {
    restoreSessionMetadata({ customTitle: 'T' })
    reAppendSessionMetadata()
    expect(existsSync(dirname(sandbox.transcript()))).toBe(false)

    resetProjectForTesting()
    await openTranscript()
    clearSessionMetadata()
    expect(await appendedBy(() => reAppendSessionMetadata())).toEqual([])
  })

  test('a PR link is re-appended only with its number, URL and repository all set', async () => {
    await openTranscript()
    const cases: Array<{ meta: Parameters<typeof restoreSessionMetadata>[0]; written: boolean }> = [
      { meta: { prNumber: 0, prUrl: 'u', prRepository: 'r' }, written: true },
      { meta: { prNumber: 5, prUrl: 'u' }, written: false },
      { meta: { prNumber: 5, prRepository: 'r' }, written: false },
      { meta: { prUrl: 'u', prRepository: 'r' }, written: false },
    ]
    for (const { meta, written } of cases) {
      clearSessionMetadata()
      restoreSessionMetadata(meta)
      const types = (await appendedBy(() => reAppendSessionMetadata())).map(e => e.type)
      expect({ meta, types }).toEqual({ meta, types: written ? ['pr-link'] : [] })
    }
  })

  test('a title or tag written by another process into the tail wins over the cache, and an empty one clears it', async () => {
    await openTranscript()
    restoreSessionMetadata({ customTitle: 'Cached title', tag: 'cached-tag' })
    const cases: Array<{ name: string; external: string[]; title: unknown; tag: unknown }> = [
      { name: 'nothing external', external: [], title: 'Cached title', tag: 'cached-tag' },
      {
        name: 'fresher values',
        external: [
          `{"type":"custom-title","customTitle":"From the SDK","sessionId":"${current()}"}`,
          `{"type":"tag","tag":"sdk-tag","sessionId":"${current()}"}`,
        ],
        title: 'From the SDK',
        tag: 'sdk-tag',
      },
      {
        name: 'cleared',
        external: [
          `{"type":"custom-title","customTitle":"","sessionId":"${current()}"}`,
          `{"type":"tag","tag":"","sessionId":"${current()}"}`,
        ],
        title: undefined,
        tag: undefined,
      },
    ]
    for (const { name, external, title, tag } of cases) {
      clearSessionMetadata()
      restoreSessionMetadata({ customTitle: 'Cached title', tag: 'cached-tag' })
      for (const line of external) appendFileSync(sandbox.transcript(), `${line}\n`)
      const appended = await appendedBy(() => reAppendSessionMetadata())
      const titles = appended.filter(e => e.type === 'custom-title').map(e => e.customTitle)
      const tags = appended.filter(e => e.type === 'tag').map(e => e.tag)
      expect({ name, titles, tags, cache: [getCurrentSessionTitle(asSessionId(current())), getCurrentSessionTag(current())] } as unknown).toEqual({
        name,
        titles: title === undefined ? [] : [title],
        tags: tag === undefined ? [] : [tag],
        cache: [title, tag],
      })
    }
  })

  test('only whole lines that open with the compact type member count as external writes', async () => {
    await openTranscript()
    const ignored = [
      `{"type": "custom-title","customTitle":"spaced","sessionId":"${current()}"}`,
      ` {"type":"tag","tag":"indented","sessionId":"${current()}"}`,
      `{"sessionId":"${current()}","type":"tag","tag":"reordered"}`,
      `{"parentUuid":null,"input":{"type":"tag","tag":"nested"}}`,
    ]
    for (const line of ignored) appendFileSync(sandbox.transcript(), `${line}\n`)
    restoreSessionMetadata({ customTitle: 'Cached', tag: 'cached' })
    const appended = await appendedBy(() => reAppendSessionMetadata())
    expect(appended.filter(e => e.type !== 'last-prompt').map(e => e.customTitle ?? e.tag)).toEqual(['Cached', 'cached'])
  })

  test('an external write more than 64 KiB from the end is not seen', async () => {
    await openTranscript()
    appendFileSync(sandbox.transcript(), `{"type":"tag","tag":"far","sessionId":"${current()}"}\n`)
    await recordTranscript([prompt(1, 'start'), prompt(2, 'p'.repeat(70_000))])
    await flushSessionStorage()
    restoreSessionMetadata({ tag: 'cached' })
    const appended = await appendedBy(() => reAppendSessionMetadata())
    expect(appended.filter(e => e.type === 'tag').map(e => e.tag)).toEqual(['cached'])
  })

  test('restoreSessionMetadata: a cached title wins, an empty tag clears, empty strings are ignored', async () => {
    const cases: Array<{ name: string; before: () => void; meta: Parameters<typeof restoreSessionMetadata>[0]; lines: Record<string, unknown> }> = [
      { name: 'a title already cached stays', before: () => cacheSessionTitle('From --name'), meta: { customTitle: 'From disk' }, lines: { 'custom-title': 'From --name' } },
      { name: 'a title with none cached', before: () => {}, meta: { customTitle: 'From disk' }, lines: { 'custom-title': 'From disk' } },
      { name: 'an empty tag clears the cached one', before: () => restoreSessionMetadata({ tag: 'old' }), meta: { tag: '' }, lines: {} },
      { name: 'no tag keeps the cached one', before: () => restoreSessionMetadata({ tag: 'old' }), meta: {}, lines: { tag: 'old' } },
      { name: 'a new tag replaces the cached one', before: () => restoreSessionMetadata({ tag: 'old' }), meta: { tag: 'new' }, lines: { tag: 'new' } },
      { name: 'empty name, color, setting are ignored', before: () => restoreSessionMetadata({ agentName: 'A', agentColor: 'c', agentSetting: 's' }), meta: { agentName: '', agentColor: '', agentSetting: '' }, lines: { 'agent-name': 'A', 'agent-color': 'c', 'agent-setting': 's' } },
      { name: 'a null worktree is kept as null', before: () => saveWorktreeState(WORKTREE), meta: { worktreeSession: null }, lines: { 'worktree-state': null } },
      { name: 'an absent worktree leaves it', before: () => saveWorktreeState(WORKTREE), meta: { mode: 'normal' }, lines: { mode: 'normal', 'worktree-state': WORKTREE } },
    ]
    const valueOf = (e: Record<string, unknown>) => e.customTitle ?? e.tag ?? e.agentName ?? e.agentColor ?? e.agentSetting ?? e.mode ?? e.worktreeSession
    for (const { name, before, meta, lines } of cases) {
      await freshTranscript()
      await before()
      restoreSessionMetadata(meta)
      const appended = await appendedBy(() => reAppendSessionMetadata())
      expect({ name, lines: Object.fromEntries(appended.map(e => [e.type, valueOf(e)])) }).toEqual({ name, lines })
    }
  })

  test('clearSessionMetadata empties the cache, the last prompt included', async () => {
    await openTranscript()
    restoreSessionMetadata({ customTitle: 'T', tag: 'g', agentName: 'n', agentColor: 'c', agentSetting: 's', mode: 'normal', worktreeSession: null, prNumber: 1, prUrl: 'u', prRepository: 'r' })
    clearSessionMetadata()
    expect(await appendedBy(() => reAppendSessionMetadata())).toEqual([])
    expect([getCurrentSessionTitle(asSessionId(current())), getCurrentSessionTag(current()), getCurrentSessionAgentColor(), getProject().currentSessionWorktree]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe('the last prompt', () => {
  test("the first meaningful user text of the latest main-thread turn, on one line, cut at 200 characters", async () => {
    await openTranscript()
    const long = `${'word '.repeat(50)}tail`
    const cases: Array<{ name: string; messages: Message[]; sidechain?: boolean; lastPrompt: string }> = [
      { name: 'a plain prompt', messages: [prompt(10, 'Fix the parser')], lastPrompt: 'Fix the parser' },
      { name: 'newlines become spaces, ends trimmed', messages: [prompt(11, '  first line\nsecond line \n')], lastPrompt: 'first line second line' },
      { name: 'exactly 200 characters', messages: [prompt(12, 'x'.repeat(200))], lastPrompt: 'x'.repeat(200) },
      { name: 'longer: cut, trimmed, ellipsis', messages: [prompt(13, long)], lastPrompt: `${long.slice(0, 200).trim()}…` },
      { name: 'a turn without text keeps the previous one', messages: [prompt(14, [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] as never)], lastPrompt: `${long.slice(0, 200).trim()}…` },
      { name: 'a subagent turn does not count', messages: [prompt(15, 'agent work')], sidechain: true, lastPrompt: `${long.slice(0, 200).trim()}…` },
      { name: 'the first text of the turn', messages: [prompt(16, 'one'), prompt(17, 'two')], lastPrompt: 'one' },
    ]
    for (const { name, messages, sidechain, lastPrompt } of cases) {
      if (sidechain) await recordSidechainTranscript(messages, 'agent-1', null)
      else await recordTranscript(messages)
      await flushSessionStorage()
      const appended = await appendedBy(() => reAppendSessionMetadata())
      expect({ name, appended }).toEqual({ name, appended: [{ type: 'last-prompt', lastPrompt, sessionId: current() }] })
    }
  })

  test('the first prompt of a session is not written when it opens the file', async () => {
    await openTranscript()
    expect(sandbox.entries().map(e => e.type)).toEqual(['user'])
  })
})

describe('adopting a resumed transcript', () => {
  test('the open file becomes the current session transcript, and the cached title is written without re-reading it', async () => {
    await openTranscript()
    await recordTranscript([prompt(1, 'start'), createAssistantMessage({ content: 'ok' })])
    await flushSessionStorage()
    const transcript = sandbox.transcript()
    appendFileSync(transcript, `{"type":"custom-title","customTitle":"On disk","sessionId":"${current()}"}\n`)
    appendFileSync(transcript, `{"type":"tag","tag":"disk-tag","sessionId":"${current()}"}\n`)

    resetProjectForTesting()
    await resetSessionFilePointer()
    restoreSessionMetadata({ customTitle: 'On disk', tag: 'cached-tag' })
    clearSessionMetadata()
    cacheSessionTitle('From --name')
    restoreSessionMetadata({ customTitle: 'On disk', tag: 'cached-tag', agentName: 'Scout' })
    const appended = await appendedBy(() => adoptResumedSessionFile())

    expect(getProject().sessionFile).toBe(transcript)
    expect(appended.map(e => [e.type, e.customTitle ?? e.tag ?? e.agentName])).toEqual([
      ['custom-title', 'From --name'],
      ['tag', 'disk-tag'],
      ['agent-name', 'Scout'],
    ])

    const later = await appendedBy(() => recordTranscript([prompt(30, 'continuing')]))
    expect(later.map(e => e.type)).toEqual(['user'])
  })
})

describe('the running cost', () => {
  test("getProject().reAppendCostState() stamps the session's cost at the end, once the file exists", async () => {
    resetCostStateOwnerForTesting()
    getProject().reAppendCostState()
    expect(existsSync(dirname(sandbox.transcript()))).toBe(false)

    await openTranscript()
    const appended = await appendedBy(() => getProject().reAppendCostState())
    expect(appended.map(e => [e.type, e.sessionId])).toEqual([['cost-state', current()]])
    expect(sandbox.text().split('\n').at(-2)!.startsWith('{"type":"cost-state"')).toBe(true)
  })

  test('not while persistence is off', async () => {
    resetCostStateOwnerForTesting()
    await openTranscript()
    setSessionPersistenceDisabled(true)
    expect(await appendedBy(() => getProject().reAppendCostState())).toEqual([])
    setSessionPersistenceDisabled(false)
  })
})

describe('at exit', () => {
  test('outside tests, the cleanup flushes the queue, then re-appends the metadata and the cost', async () => {
    const session = 'e1e1e1e1-0000-4000-8000-000000000000'
    const script = `
      const storage = await import('src/sessions/sessionStorage.js')
      const state = await import('src/platform/bootstrap/state.js')
      const { createUserMessage } = await import('src/agent/messages/messages.js')
      const { runCleanupFunctions } = await import('src/shared/cleanupRegistry.js')
      state.setOriginalCwd(process.env.PROJECT)
      state.setCwdState(process.env.PROJECT)
      state.switchSession(process.env.SESSION)
      await storage.recordTranscript([createUserMessage({ content: 'Ship it\\nnow' })])
      await storage.saveTag(process.env.SESSION, 'release')
      await runCleanupFunctions()
      console.log(storage.getProject().sessionFile)
    `
    const run = await runChild(script, {
      HOME: sandbox.root,
      CLAUDIN_CONFIG_DIR: sandbox.configDir,
      PROJECT: sandbox.project,
      SESSION: session,
    })
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: '' })

    const transcript = run.stdout.trim()
    expect(transcript).toBe(join(dirname(sandbox.transcript()), `${session}.jsonl`))
    const entries = sandbox.entries(transcript)
    expect(entries.map(e => e.type)).toEqual(['tag', 'user', 'last-prompt', 'tag', 'cost-state'])
    expect(entries.slice(2, 4).map(e => e.lastPrompt ?? e.tag)).toEqual(['Ship it now', 'release'])
  }, 30_000)
})
