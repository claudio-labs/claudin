/**
 * Characterization of `loadConversationForResume`, the one loader behind
 * `--continue`, `--resume <session id>`, `--resume <file.jsonl>`, the resume
 * picker and the headless resume, pinned before the clean-base rewrite of
 * `sessions/resume`.
 *
 * Each test runs in a temp CLAUDIN_CONFIG_DIR and project. Sessions are
 * recorded through the session persistence module, or written as JSONL into
 * the project's transcript directory when a test needs exact timestamps.
 * SessionStart hooks are real command hooks in the temp settings.json.
 */
import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'

import { NO_RESPONSE_REQUESTED } from 'src/agent/messages/messages.js'
import { getPlanSlug } from 'src/agent/plans/plans.js'
import { getInvokedSkills } from 'src/platform/bootstrap/state.js'
import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { useRestoreSandbox, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import {
  attachment,
  id,
  jsonl,
  type Line,
  prompt,
  reply,
  textOf,
} from 'src/sessions/__testutils__/resumeTranscripts.js'
import {
  loadConversationForResume,
  ResumeTranscriptTooLargeError,
} from 'src/sessions/conversationRecovery.js'
import { getProjectDir, loadMessageLogs } from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'

const sandbox = useRestoreSandbox()

const SENTINEL = NO_RESPONSE_REQUESTED
const MiB = 1024 * 1024

const OWN = '5e55104e-0000-4000-8000-0000000000d1' as UUID
const OTHER = '5e55104e-0000-4000-8000-0000000000d2' as UUID

const texts = (messages: unknown[]) => messages.map(textOf)

/** Writes `<project transcripts>/<session>.jsonl`, the place `--resume <id>` looks. */
function writeProjectSession(session: UUID, lines: Array<Line | string>): string {
  const dir = getProjectDir(sandbox.projectDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${session}.jsonl`)
  writeFileSync(path, jsonl(lines))
  return path
}

/** Writes a JSONL file outside the project, as `--resume <file.jsonl>` takes it. */
function writeLooseFile(lines: Array<Line | string>): string {
  const dir = join(sandbox.root, 'elsewhere')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'exported.jsonl')
  writeFileSync(path, jsonl(lines))
  return path
}

const costLine = (session: UUID, dollars: number): Line => ({
  type: 'cost-state',
  sessionId: session,
  totalCostUSD: dollars,
  totalAPIDuration: 1,
  totalAPIDurationWithoutRetries: 1,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalDuration: 2,
  startTime: 1,
  modelUsage: {},
})

/** A short exchange of `session`, one second apart, with session metadata. */
function exchange(session: UUID, first = 1): Line[] {
  const at = { session }
  return [
    prompt(id(first), 'Rename the module', { ...at, at: 1 }),
    reply(id(first + 1), 'Renamed', { ...at, parent: id(first), at: 2 }),
    prompt(id(first + 2), 'Thanks', { ...at, parent: id(first + 1), at: 3 }),
    reply(id(first + 3), 'Anything else?', { ...at, parent: id(first + 2), at: 4 }),
    { type: 'custom-title', sessionId: session, customTitle: 'Module rename' },
    { type: 'tag', sessionId: session, tag: 'refactor' },
    { type: 'agent-setting', sessionId: session, agentSetting: 'renamer' },
    { type: 'worktree-state', sessionId: session, worktreeSession: null },
    costLine(session, 0.75),
  ]
}

function configureSessionStartHook(record: string, context: string): void {
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })
  const command = `cat > '${record}'; printf '%s\\n' '${output}'`
  const settings = { hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command }] }] } }
  writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
  resetHooksConfigSnapshot()
}

// --- --continue ------------------------------------------------------------------------

describe('loadConversationForResume(undefined) — the most recent session of the project', () => {
  test('loads the latest session with its messages and every piece of metadata', async () => {
    const older = await writeSession({ title: 'Older' })
    const past = new Date(Date.now() - 3600_000)
    utimesSync(older.transcript, past, past)
    const worktree = {
      originalCwd: sandbox.projectDir,
      worktreePath: join(sandbox.root, 'wt'),
      worktreeName: 'wt',
      sessionId: 'w',
    }
    const latest = await writeSession({
      title: 'Parser rewrite',
      tag: 'parser',
      agentName: 'Ada',
      agentColor: 'cyan',
      agentSetting: 'reviewer',
      pr: { number: 42, url: 'https://github.com/acme/shop/pull/42', repository: 'acme/shop' },
      worktree,
      costUSD: 0.5,
    })

    const loaded = (await loadConversationForResume(undefined, undefined))!
    expect(texts(loaded.messages)).toEqual(['Let us fix the parser.', 'On it.', 'That is all for now.'])
    expect(loaded).toMatchObject({
      sessionId: latest.id,
      turnInterruptionState: { kind: 'none' },
      customTitle: 'Parser rewrite',
      tag: 'parser',
      agentName: 'Ada',
      agentColor: 'cyan',
      agentSetting: 'reviewer',
      prNumber: 42,
      prUrl: 'https://github.com/acme/shop/pull/42',
      prRepository: 'acme/shop',
      worktreeSession: worktree,
      fullPath: latest.transcript,
    })
    expect(loaded.costState?.totalCostUSD).toBeCloseTo(0.5)
  })

  test('nothing to continue gives null', async () => {
    expect(await loadConversationForResume(undefined, undefined)).toBeNull()
  })
})

// --- --resume <session id> ---------------------------------------------------------------

describe('loadConversationForResume(sessionId) — one session of the project', () => {
  test('loads that session, takes the given id, and carries its title, tag, agent, worktree and cost', async () => {
    const path = writeProjectSession(OWN, exchange(OWN))
    writeProjectSession(OTHER, exchange(OTHER, 20))

    const loaded = (await loadConversationForResume(OWN, undefined))!
    expect(texts(loaded.messages)).toEqual(['Rename the module', 'Renamed', 'Thanks', 'Anything else?'])
    expect(loaded).toMatchObject({
      sessionId: OWN,
      customTitle: 'Module rename',
      tag: 'refactor',
      agentSetting: 'renamer',
      worktreeSession: null,
      fullPath: path,
    })
    expect(loaded.costState?.totalCostUSD).toBe(0.75)
  })

  test('an id with no transcript gives null', async () => {
    writeProjectSession(OTHER, exchange(OTHER))
    expect(await loadConversationForResume(OWN, undefined)).toBeNull()
  })

  test('a session that ends on a prompt reports it and gets an answer placeholder', async () => {
    writeProjectSession(OWN, [...exchange(OWN), prompt(id(9), 'One more thing', { session: OWN, parent: id(4), at: 5 })])
    const loaded = (await loadConversationForResume(OWN, undefined))!
    expect(loaded.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(textOf((loaded.turnInterruptionState as { message: unknown }).message)).toBe('One more thing')
    expect(texts(loaded.messages).slice(-2)).toEqual(['One more thing', SENTINEL])
  })

  test('the plan of the session is handed to the resumed id', async () => {
    const withSlug = exchange(OWN).map(line => (line.uuid ? { ...line, slug: 'brave-otter' } : line))
    writeProjectSession(OWN, withSlug)
    await loadConversationForResume(OWN, undefined)
    expect(getPlanSlug(asSessionId(OWN))).toBe('brave-otter')
  })

  test('skills the session had invoked are known again', async () => {
    const skills = [{ name: 'tidy', path: '/skills/tidy/SKILL.md', content: 'Tidy the tree.' }]
    writeProjectSession(OWN, [
      ...exchange(OWN),
      attachment(id(9), { type: 'invoked_skills', skills }, { session: OWN, parent: id(4), at: 5 }),
    ])
    await loadConversationForResume(OWN, undefined)
    expect(getInvokedSkills().get(':tidy')?.content).toBe('Tidy the tree.')
  })
})

// --- a LogOption from the picker ------------------------------------------------------------

describe('loadConversationForResume(log) — a session the picker already listed', () => {
  test('a lite entry is loaded in full first', async () => {
    const written = await writeSession({ title: 'Listed' })
    const [lite] = await loadMessageLogs()
    const loaded = (await loadConversationForResume(lite!, undefined))!
    expect(texts(loaded.messages)).toEqual(['Let us fix the parser.', 'On it.', 'That is all for now.'])
    expect(loaded.sessionId).toBe(written.id)
    expect(loaded.customTitle).toBe('Listed')
  })

  test('a full entry is used as given: its metadata passes through, and the id comes from its first message', async () => {
    const lines = exchange(OWN).filter(line => line.uuid)
    const snapshots = [{ messageId: id(1), trackedFileBackups: {}, timestamp: new Date(0) }]
    const log = {
      date: '2026-09-30',
      messages: lines,
      value: 0,
      created: new Date(0),
      modified: new Date(0),
      firstPrompt: 'Rename the module',
      messageCount: 4,
      isSidechain: false,
      fullPath: '/somewhere/else.jsonl',
      agentName: 'Bea',
      agentColor: 'green',
      agentSetting: 'planner',
      customTitle: 'Given title',
      tag: 'given',
      mode: 'coordinator',
      worktreeSession: null,
      prNumber: 9,
      prUrl: 'https://example.test/pr/9',
      prRepository: 'acme/app',
      costState: costLine(OWN, 3),
      fileHistorySnapshots: snapshots,
      attributionSnapshots: [],
      contextCollapseCommits: [],
    } as unknown as LogOption

    const loaded = (await loadConversationForResume(log, undefined))!
    expect(texts(loaded.messages)).toEqual(['Rename the module', 'Renamed', 'Thanks', 'Anything else?'])
    expect(loaded).toMatchObject({
      sessionId: OWN,
      agentName: 'Bea',
      agentColor: 'green',
      agentSetting: 'planner',
      customTitle: 'Given title',
      tag: 'given',
      mode: 'coordinator',
      worktreeSession: null,
      prNumber: 9,
      prUrl: 'https://example.test/pr/9',
      prRepository: 'acme/app',
      fullPath: '/somewhere/else.jsonl',
      fileHistorySnapshots: snapshots,
      attributionSnapshots: [],
      contextCollapseCommits: [],
      contextCollapseSnapshot: undefined,
    })
    expect(loaded.costState?.totalCostUSD).toBe(3)
  })

  test('an entry’s own session id wins over its first message’s', async () => {
    const log = {
      messages: exchange(OWN).filter(line => line.uuid),
      sessionId: OTHER,
      isSidechain: false,
    } as unknown as LogOption
    expect((await loadConversationForResume(log, undefined))!.sessionId).toBe(OTHER)
  })
})

// --- --resume <file.jsonl> ---------------------------------------------------------------

describe('loadConversationForResume(_, file) — a transcript given by path', () => {
  test('walks from the newest main-thread tip; the id and cost are the tip’s session’s, nothing else is carried', async () => {
    const path = writeLooseFile([
      prompt(id(1), 'Forked from elsewhere', { session: OTHER, at: 1 }),
      reply(id(2), 'Old answer', { session: OTHER, parent: id(1), at: 2 }),
      prompt(id(3), 'Continued here', { session: OWN, parent: id(2), at: 3 }),
      reply(id(4), 'Newest answer', { session: OWN, parent: id(3), at: 4 }),
      prompt(id(5), 'Older branch', { session: OWN, parent: id(2), at: 2.5 }),
      prompt(id(6), 'A subagent, newer still', { session: OWN, at: 9, sidechain: true }),
      { type: 'custom-title', sessionId: OWN, customTitle: 'Not carried' },
      costLine(OTHER, 1),
      costLine(OWN, 2),
    ])
    const loaded = (await loadConversationForResume('ignored-when-a-path-is-given', path))!
    expect(texts(loaded.messages)).toEqual(['Forked from elsewhere', 'Old answer', 'Continued here', 'Newest answer'])
    expect(loaded.sessionId).toBe(OWN)
    expect(loaded.costState?.totalCostUSD).toBe(2)
    expect(loaded.customTitle).toBeUndefined()
    expect(loaded.fullPath).toBeUndefined()
  })

  test('the path is followed even when the session id names another session', async () => {
    writeProjectSession(OTHER, exchange(OTHER))
    const path = writeLooseFile([prompt(id(1), 'From the file', { session: OWN }), reply(id(2), 'Yes', { session: OWN, parent: id(1), at: 1 })])
    const loaded = (await loadConversationForResume(OTHER, path))!
    expect(texts(loaded.messages)).toEqual(['From the file', 'Yes'])
    expect(loaded.sessionId).toBe(OWN)
  })

  test('a file with nothing to walk loads as an empty conversation, not null', async () => {
    for (const path of [join(sandbox.root, 'missing.jsonl'), writeLooseFile([{ type: 'tag', sessionId: OWN, tag: 'x' }])]) {
      const loaded = await loadConversationForResume(OWN, path)
      expect(loaded).not.toBeNull()
      expect(loaded!.messages).toEqual([])
      expect(loaded!.sessionId).toBeUndefined()
      expect(loaded!.costState).toBeUndefined()
    }
  })

  test('without a session id the path is not read: it is a --continue', async () => {
    writeProjectSession(OTHER, exchange(OTHER))
    const path = writeLooseFile([prompt(id(1), 'From the file', { session: OWN })])
    const loaded = (await loadConversationForResume(undefined, path))!
    expect(loaded.sessionId).toBe(OTHER)
    expect(texts(loaded.messages)[0]).toBe('Rename the module')
  })

  test('the plan is not handed over from a file', async () => {
    const path = writeLooseFile([prompt(id(1), 'With a plan', { session: OWN, more: { slug: 'quiet-heron' } })])
    await loadConversationForResume(OWN, path)
    expect(getPlanSlug(asSessionId(OWN))).not.toBe('quiet-heron')
  })
})

// --- what runs after the load -------------------------------------------------------------

describe('loadConversationForResume — SessionStart hooks and the size limit', () => {
  test('the resume SessionStart hooks run with the session id, and their output follows the conversation', async () => {
    const record = join(sandbox.root, 'hook-input.json')
    configureSessionStartHook(record, 'resumed with context')
    writeProjectSession(OWN, exchange(OWN))

    const loaded = (await loadConversationForResume(OWN, undefined))!
    const input = JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>
    expect(input).toMatchObject({ hook_event_name: 'SessionStart', source: 'resume', session_id: OWN })
    expect(texts(loaded.messages).slice(0, 4)).toEqual(['Rename the module', 'Renamed', 'Thanks', 'Anything else?'])
    const tail = loaded.messages.at(-1) as { type: string; attachment?: { type: string; content: unknown } }
    expect(tail.type).toBe('attachment')
    expect(JSON.stringify(tail.attachment)).toContain('resumed with context')
  })

  test('a conversation over 8 MiB is refused before any hook runs', async () => {
    const record = join(sandbox.root, 'hook-input.json')
    configureSessionStartHook(record, 'should not run')
    writeProjectSession(OWN, [prompt(id(1), 'y'.repeat(8 * MiB + 64 * 1024), { session: OWN }), reply(id(2), 'ok', { session: OWN, parent: id(1), at: 1 })])

    const failure = await loadConversationForResume(OWN, undefined).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ResumeTranscriptTooLargeError)
    const tooLarge = failure as ResumeTranscriptTooLargeError
    expect(tooLarge.name).toBe('ResumeTranscriptTooLargeError')
    expect(tooLarge.maxBytes).toBe(8 * MiB)
    expect(tooLarge.bytes).toBeGreaterThan(8 * MiB)
    expect(tooLarge.messageCount).toBe(2)
    expect(tooLarge.message).toContain('too large to resume')
    expect(tooLarge.message).toContain(`${(tooLarge.bytes / MiB).toFixed(1)} MiB > 8.0 MiB`)
    expect(tooLarge.message).toContain('2 messages')
    expect(existsSync(record)).toBe(false)
  })

  test('a conversation just under the limit loads', async () => {
    writeProjectSession(OWN, [prompt(id(1), 'z'.repeat(8 * MiB - 64 * 1024), { session: OWN }), reply(id(2), 'ok', { session: OWN, parent: id(1), at: 1 })])
    const loaded = await loadConversationForResume(OWN, undefined)
    expect(loaded!.messages).toHaveLength(2)
  })

  test('the error can be built directly, and states both sizes in MiB with one decimal', () => {
    const error = new ResumeTranscriptTooLargeError(12.25 * MiB, 8 * MiB, 31)
    expect(error).toBeInstanceOf(Error)
    expect([error.bytes, error.maxBytes, error.messageCount]).toEqual([12.25 * MiB, 8 * MiB, 31])
    expect(error.message).toContain('(12.3 MiB > 8.0 MiB, 31 messages)')
  })
})
