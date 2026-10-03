/**
 * Characterization of the JSONL transcript writer (`sessions/persistence`),
 * pinned before the clean-base rewrite: when the file appears, what each
 * message line carries, how the parentUuid chain is laid, how a conversation
 * recorded twice is written once, where subagent lines go, when nothing is
 * written at all, and how a message is taken back out.
 *
 * Session metadata (titles, tags, the re-append at the end of the file) is in
 * persistence.metadata.characterization.test.ts, and the remote ingress in
 * persistence.remote.characterization.test.ts. Everything here writes real
 * files under a temp CLAUDIN_CONFIG_DIR.
 */
import { describe, expect, setSystemTime, test } from 'bun:test'
import type { UUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createSystemMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import {
  getPlanSlugCache,
  getSessionId,
  setCwdState,
  setPromptId,
  setSessionPersistenceDisabled,
  setFlagSettingsInline,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { git, usePersistenceSandbox } from 'src/sessions/__testutils__/persistenceSandbox.js'
import {
  cacheSessionTitle,
  clearSessionMessagesCache,
  flushSessionStorage,
  getAgentTranscriptPath,
  getProject,
  recordAttributionSnapshot,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  resetProjectForTesting,
  resetSessionFilePointer,
  saveMode,
} from 'src/sessions/sessionStorage.js'
import { asAgentId, asSessionId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = usePersistenceSandbox()

const AT = '2026-03-14T09:26:53.000Z'

function uuidOf(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function prompt(n: number, text: string, extra: Partial<Parameters<typeof createUserMessage>[0]> = {}) {
  return createUserMessage({ content: text, uuid: uuidOf(n), timestamp: AT, ...extra })
}

function reply(n: number, content: Parameters<typeof createAssistantMessage>[0]['content']) {
  const made = createAssistantMessage({ content })
  return { ...made, uuid: uuidOf(n), timestamp: AT, message: { ...made.message, id: `msg_${n}` } }
}

function notice(n: number, text: string) {
  return { ...createSystemMessage(text, 'info'), uuid: uuidOf(n), timestamp: AT }
}

function boundary(n: number) {
  return { ...createCompactBoundaryMessage('manual', 1234), uuid: uuidOf(n), timestamp: AT }
}

async function record(messages: object[], ...rest: unknown[]): Promise<UUID | null> {
  const result = await (recordTranscript as (...args: unknown[]) => Promise<UUID | null>)(messages as Message[], ...rest)
  await flushSessionStorage()
  return result
}

function chain(path?: string): Array<[unknown, unknown]> {
  return sandbox.entries(path).filter(e => 'uuid' in e).map(e => [e.uuid, e.parentUuid])
}

function lineOf(n: number, path?: string): string {
  return sandbox.text(path).split('\n').find(line => line.includes(`"uuid":"${uuidOf(n)}"`))!
}

const FIXTURES = join(import.meta.dir, 'persistence', '__fixtures__', 'rewrite')

describe('when and where the transcript is written', () => {
  test('no file exists until the first user or assistant message; what came before is written ahead of it', async () => {
    await record([notice(1, 'SessionStart hook ran')])
    expect(existsSync(sandbox.transcript())).toBe(false)

    await record([notice(1, 'SessionStart hook ran'), prompt(2, 'hello')])

    expect(sandbox.entries().map(e => e.type)).toEqual(['system', 'user'])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(2), uuidOf(1)],
    ])
  })

  test('an assistant message alone also creates the file', async () => {
    await record([reply(1, 'unprompted')])
    expect(sandbox.entries().map(e => e.type)).toEqual(['assistant'])
  })

  test('the file is <config>/projects/<sanitized cwd>/<session id>.jsonl, readable by its owner only', async () => {
    await record([prompt(1, 'hello')])

    const projectDir = join(sandbox.configDir, 'projects', sandbox.project.replace(/[^A-Za-z0-9]/g, '-'))
    expect(sandbox.transcript()).toBe(join(projectDir, `${getSessionId()}.jsonl`))
    expect(statSync(sandbox.transcript()).mode & 0o777).toBe(0o600)
    expect(statSync(projectDir).mode & 0o777).toBe(0o700)
  })

  test('a recorded message reaches the disk on the next queue drain, or at once on flushSessionStorage', async () => {
    await recordTranscript([prompt(1, 'first')])
    expect(sandbox.text()).not.toContain(uuidOf(1))
    await flushSessionStorage()
    expect(sandbox.text()).toContain(uuidOf(1))

    await recordTranscript([prompt(1, 'first'), reply(2, 'queued')])
    await Bun.sleep(30)
    expect(sandbox.text()).not.toContain(uuidOf(2))
    await Bun.sleep(400)
    expect(sandbox.text()).toContain(uuidOf(2))
  })

  test('when the directory cannot be created, flushSessionStorage rejects with the file-system error', async () => {
    writeFileSync(join(sandbox.root, 'a-file'), '')
    process.env.CLAUDIN_CONFIG_DIR = join(sandbox.root, 'a-file')
    await recordTranscript([prompt(1, 'lost')])
    expect(await flushSessionStorage().then(() => 'resolved', (e: NodeJS.ErrnoException) => e.code)).toBe('ENOTDIR')
  })

  test('many messages come out in the order they were recorded', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => (i % 2 ? reply(i + 1, `r${i}`) : prompt(i + 1, `q${i}`)))
    await record(messages)
    expect(sandbox.entries().map(e => e.uuid)).toEqual(messages.map(m => m.uuid))
  })
})

describe('what a message line carries', () => {
  test('a whole session, written by the real API, matches the fixture byte for byte', async () => {
    const fixed = asSessionId('5e551011-0000-4000-8000-00000000f1a7')
    switchSession(fixed)
    git(sandbox.project, 'init', '-q', '-b', 'main')
    setSystemTime(new Date(AT))
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    setPromptId('prompt-1')
    getPlanSlugCache().set(fixed, 'quiet-river')
    cacheSessionTitle('Parser fixes')
    saveMode('normal')

    await recordQueueOperation({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, sessionId: fixed, content: 'run tests' })
    const ask = reply(2, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] as never)
    await record([
      prompt(1, 'List the files'),
      ask,
      prompt(3, '', {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }],
        toolUseResult: { stdout: 'a.ts\nb.ts', stderr: '' },
        sourceToolAssistantUUID: uuidOf(2),
      }),
    ])
    await recordFileHistorySnapshot(uuidOf(1), { messageId: uuidOf(1), trackedFileBackups: {}, timestamp: new Date(AT) }, false)
    await recordAttributionSnapshot({ type: 'attribution-snapshot', messageId: uuidOf(2), surface: 'cli', fileStates: {} })
    setPromptId('prompt-2')
    await record([boundary(4), prompt(5, 'Carry on')], { teamName: 'red', agentName: 'scout' })
    await flushSessionStorage()

    const expected = readFileSync(join(FIXTURES, 'session.jsonl'), 'utf8')
    expect(sandbox.normalize(sandbox.text())).toBe(expected)
  })

  test('each message hangs off the chain message before it, starting from null or from the hint', async () => {
    const cases: Array<{ name: string; hint?: UUID; first: UUID | null }> = [
      { name: 'no hint', first: null },
      { name: 'a hint', hint: uuidOf(99), first: uuidOf(99) },
    ]
    for (const { name, hint, first } of cases) {
      switchSession(asSessionId(crypto.randomUUID()))
      resetProjectForTesting()
      await record([prompt(1, 'q'), reply(2, 'a'), prompt(3, 'q2')], undefined, hint)
      expect({ name, chain: chain() }).toEqual({
        name,
        chain: [
          [uuidOf(1), first],
          [uuidOf(2), uuidOf(1)],
          [uuidOf(3), uuidOf(2)],
        ],
      })
    }
  })

  test('a tool result hangs off the assistant message named as its source, and the chain continues from it', async () => {
    await record([
      prompt(1, 'go'),
      reply(2, 'calling a tool'),
      reply(3, 'calling another'),
      prompt(4, 'result', { sourceToolAssistantUUID: uuidOf(2) }),
      reply(5, 'done'),
    ])
    expect(chain().slice(3)).toEqual([
      [uuidOf(4), uuidOf(2)],
      [uuidOf(5), uuidOf(4)],
    ])
  })

  test('a compact boundary starts a new chain and keeps the old parent as its logical parent', async () => {
    await record([prompt(1, 'old'), reply(2, 'old answer'), boundary(3), prompt(4, 'new')])
    const line = sandbox.entries().find(e => e.uuid === uuidOf(3))!
    expect(line.parentUuid).toBeNull()
    expect(line.logicalParentUuid).toBe(uuidOf(2))
    expect(chain().at(-1)).toEqual([uuidOf(4), uuidOf(3)])
    expect('logicalParentUuid' in sandbox.entries().find(e => e.uuid === uuidOf(4))!).toBe(false)
  })

  test('the stamps: cwd now, prompt id on user lines only, team info, plan slug, entrypoint', async () => {
    const elsewhere = join(sandbox.project, 'sub')
    setCwdState(elsewhere)
    setPromptId('p-7')
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    getPlanSlugCache().set(getSessionId(), 'brave-otter')
    await record([prompt(1, 'q'), reply(2, 'a')], { teamName: 'blue', agentName: 'lead' })

    const [user, assistant] = sandbox.entries()
    const stamps = (e: Record<string, unknown>) => ({
      cwd: e.cwd,
      promptId: e.promptId,
      teamName: e.teamName,
      agentName: e.agentName,
      slug: e.slug,
      entrypoint: e.entrypoint,
      userType: e.userType,
      sessionId: e.sessionId,
      isSidechain: e.isSidechain,
    })
    const shared = { cwd: elsewhere, teamName: 'blue', agentName: 'lead', slug: 'brave-otter', entrypoint: 'sdk-ts', userType: 'external', sessionId: getSessionId(), isSidechain: false }
    expect(stamps(user!)).toEqual({ ...shared, promptId: 'p-7' })
    expect(stamps(assistant!)).toEqual({ ...shared, promptId: undefined })
    expect(dirname(sandbox.transcript())).toContain(sandbox.project.replace(/[^A-Za-z0-9]/g, '-'))
  })

  test('the session stamp replaces what a message carries, and an unset stamp removes it', async () => {
    const carried = {
      ...prompt(1, 'from another session'),
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
      cwd: '/somewhere/else',
      version: '0.0.1',
      userType: 'ant',
      entrypoint: 'vscode',
      slug: 'old-slug',
      gitBranch: 'old-branch',
    }
    await record([carried])
    const [line] = sandbox.entries()
    expect({ sessionId: line!.sessionId, cwd: line!.cwd, userType: line!.userType, gitBranch: line!.gitBranch }).toEqual({
      sessionId: getSessionId(),
      cwd: sandbox.project,
      userType: 'external',
      gitBranch: 'HEAD',
    })
    expect(line!.version).not.toBe('0.0.1')
    expect('entrypoint' in line!).toBe(false)
    expect('slug' in line!).toBe(false)
  })

  test('any other member a message carries wins over the chain fields', async () => {
    await record([prompt(1, 'q'), { ...reply(2, 'a'), parentUuid: uuidOf(77), agentId: 'carried' }])
    const line = sandbox.entries().find(e => e.uuid === uuidOf(2))!
    expect({ parentUuid: line.parentUuid, isSidechain: line.isSidechain, agentId: line.agentId }).toEqual({
      parentUuid: uuidOf(77),
      isSidechain: false,
      agentId: 'carried',
    })
    expect(lineOf(2).startsWith('{"parentUuid":')).toBe(true)

    await record([prompt(1, 'q'), { ...reply(3, 'b'), isSidechain: true, agentId: 'carried' }])
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(1), uuidOf(2)])
    expect(sandbox.entries(getAgentTranscriptPath(asAgentId('carried'))).map(e => e.uuid)).toEqual([uuidOf(3)])
  })

  test('gitBranch is the branch checked out in the working directory, or HEAD outside a repository', async () => {
    await record([prompt(1, 'outside')])
    const repository = join(sandbox.root, 'repository')
    mkdirSync(repository)
    git(repository, 'init', '-q', '-b', 'release-7')
    setCwdState(repository)
    await record([prompt(1, 'outside'), prompt(2, 'inside')])
    expect(sandbox.entries().map(e => e.gitBranch)).toEqual(['HEAD', 'release-7'])
  })

  test('progress messages are not written and do not break the chain', async () => {
    const progress = { type: 'progress', uuid: uuidOf(2), timestamp: AT, toolUseID: 't', parentToolUseID: 't', data: { type: 'bash_progress' } }
    await record([prompt(1, 'q'), progress, reply(3, 'a')])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(3), uuidOf(1)],
    ])
  })
})

describe('recording a conversation that is partly on disk', () => {
  test('only the new messages are written, chained to the last one already recorded', async () => {
    await record([prompt(1, 'q1'), reply(2, 'a1')])
    await record([prompt(1, 'q1'), reply(2, 'a1'), prompt(3, 'q2'), reply(4, 'a2')])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(2), uuidOf(1)],
      [uuidOf(3), uuidOf(2)],
      [uuidOf(4), uuidOf(3)],
    ])
  })

  test('the result is the uuid the next slice should chain from', async () => {
    await record([prompt(1, 'q1'), reply(2, 'a1')])
    const progress = { type: 'progress', uuid: uuidOf(9), timestamp: AT, toolUseID: 't', parentToolUseID: 't', data: { type: 'bash_progress' } }
    const cases: Array<{ name: string; messages: object[]; hint?: UUID; result: UUID | null }> = [
      { name: 'nothing at all', messages: [], result: null },
      { name: 'nothing, with a hint', messages: [], hint: uuidOf(50), result: uuidOf(50) },
      { name: 'all recorded', messages: [prompt(1, 'q1'), reply(2, 'a1')], result: uuidOf(2) },
      { name: 'all recorded wins over the hint', messages: [prompt(1, 'q1')], hint: uuidOf(50), result: uuidOf(1) },
      { name: 'new messages', messages: [prompt(1, 'q1'), reply(2, 'a1'), prompt(3, 'q2')], result: uuidOf(3) },
      { name: 'a trailing progress tick', messages: [prompt(4, 'q3'), progress], result: uuidOf(4) },
    ]
    for (const { name, messages, hint, result } of cases) {
      expect({ name, result: await record(messages, undefined, hint) }).toEqual({ name, result })
    }
  })

  test('after compaction, kept messages that follow the new boundary are neither rewritten nor chained to', async () => {
    await record([prompt(1, 'q1'), reply(2, 'a1')])
    const summary = prompt(4, 'summary of the conversation', { isCompactSummary: true })
    const last = await record([boundary(3), summary, prompt(1, 'q1'), reply(2, 'a1')])

    expect(last).toBe(uuidOf(4))
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(2), uuidOf(1)],
      [uuidOf(3), null],
      [uuidOf(4), uuidOf(3)],
    ])
  })

  test('a recorded message that follows a new one is not chained to', async () => {
    await record([prompt(1, 'q1')])
    await record([prompt(5, 'new first'), prompt(1, 'q1')])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(5), null],
    ])
  })

  test('what is on disk counts as recorded after a restart', async () => {
    await record([prompt(1, 'q1')])
    resetProjectForTesting()
    clearSessionMessagesCache()
    await record([prompt(1, 'q1'), reply(2, 'a1')])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(2), uuidOf(1)],
    ])
  })
})

describe('subagent transcripts', () => {
  test("lines with an agent id go to the agent's own file, chained from the given parent", async () => {
    await record([prompt(1, 'main')])
    await recordSidechainTranscript([prompt(2, 'task') as Message, reply(3, 'work') as Message], 'agent-x', uuidOf(1))
    await flushSessionStorage()

    const file = getAgentTranscriptPath(asAgentId('agent-x'))
    expect(file).toBe(join(dirname(sandbox.transcript()), getSessionId(), 'subagents', 'agent-agent-x.jsonl'))
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(1)])
    expect(sandbox.entries(file).map(e => [e.uuid, e.parentUuid, e.isSidechain, e.agentId])).toEqual([
      [uuidOf(2), uuidOf(1), true, 'agent-x'],
      [uuidOf(3), uuidOf(2), true, 'agent-x'],
    ])
  })

  test('agent lines are written again on every call, even uuids the main transcript has', async () => {
    await record([prompt(1, 'shared')])
    for (let i = 0; i < 2; i++) {
      await recordSidechainTranscript([prompt(1, 'shared') as Message], 'agent-y', null)
    }
    await flushSessionStorage()
    expect(sandbox.entries(getAgentTranscriptPath(asAgentId('agent-y'))).map(e => e.uuid)).toEqual([uuidOf(1), uuidOf(1)])
  })

  test('agent lines do not count as recorded for the main transcript', async () => {
    await record([prompt(1, 'main')])
    await recordSidechainTranscript([reply(2, 'agent first') as Message], 'agent-z', uuidOf(1))
    await record([prompt(1, 'main'), reply(2, 'agent first')])
    expect(chain()).toEqual([
      [uuidOf(1), null],
      [uuidOf(2), uuidOf(1)],
    ])
  })

  test('sidechain lines without an agent id stay in the main transcript', async () => {
    await record([prompt(1, 'main')])
    await recordSidechainTranscript([reply(2, 'side') as Message], undefined, uuidOf(1))
    await flushSessionStorage()
    const side = sandbox.entries().find(e => e.uuid === uuidOf(2))!
    expect([side.isSidechain, side.parentUuid, 'agentId' in side]).toEqual([true, uuidOf(1), false])
  })
})

describe('other entries', () => {
  test('a queue operation recorded before the first message waits for it and is written verbatim', async () => {
    const op = { type: 'queue-operation' as const, operation: 'enqueue' as const, timestamp: AT, sessionId: asSessionId(getSessionId()), content: 'next' }
    await recordQueueOperation(op)
    await flushSessionStorage()
    expect(existsSync(sandbox.transcript())).toBe(false)

    await record([prompt(1, 'go')])
    const lines = sandbox.text().split('\n')
    expect(lines[0]).toBe(JSON.stringify(op))
    expect(JSON.parse(lines[1]!).uuid).toBe(uuidOf(1))
  })

  test('snapshots are written whole, in their own shape, and never deduplicated', async () => {
    await record([prompt(1, 'go')])
    const backup = { backupFileName: 'abc@v1', version: 1, backupTime: new Date(AT) }
    for (const update of [false, true]) {
      await recordFileHistorySnapshot(uuidOf(1), { messageId: uuidOf(1), trackedFileBackups: { 'a.ts': backup } as never, timestamp: new Date(AT) }, update)
    }
    const attribution = { type: 'attribution-snapshot' as const, messageId: uuidOf(1), surface: 'cli', fileStates: { 'a.ts': { contentHash: 'h', claudeContribution: 3, mtime: 1 } }, promptCount: 2 }
    await recordAttributionSnapshot(attribution)
    await flushSessionStorage()

    const lines = sandbox.text().split('\n').slice(1, 4)
    expect(lines).toEqual([
      `{"type":"file-history-snapshot","messageId":"${uuidOf(1)}","snapshot":{"messageId":"${uuidOf(1)}","trackedFileBackups":{"a.ts":{"backupFileName":"abc@v1","version":1,"backupTime":"${AT}"}},"timestamp":"${AT}"},"isSnapshotUpdate":false}`,
      `{"type":"file-history-snapshot","messageId":"${uuidOf(1)}","snapshot":{"messageId":"${uuidOf(1)}","trackedFileBackups":{"a.ts":{"backupFileName":"abc@v1","version":1,"backupTime":"${AT}"}},"timestamp":"${AT}"},"isSnapshotUpdate":true}`,
      JSON.stringify(attribution),
    ])
  })
})

describe('context-collapse entries', () => {
  test('commits and snapshots are written in call order, type and session first, never deduplicated', async () => {
    const commit = {
      collapseId: 'c-1',
      summaryUuid: uuidOf(40),
      summaryContent: '<collapsed>two turns</collapsed>',
      summary: 'two turns',
      firstArchivedUuid: uuidOf(1),
      lastArchivedUuid: uuidOf(2),
    }
    const snapshot = {
      staged: [{ startUuid: uuidOf(1), endUuid: uuidOf(2), summary: 's', risk: 0.25, stagedAt: 7 }],
      armed: true,
      lastSpawnTokens: 900,
    }
    await recordContextCollapseCommit(commit)
    await record([prompt(1, 'go')])
    await recordContextCollapseSnapshot(snapshot)
    await recordContextCollapseSnapshot(snapshot)
    await recordContextCollapseCommit(commit)
    await flushSessionStorage()

    const session = getSessionId()
    const commitLine = `{"type":"marble-origami-commit","sessionId":"${session}",${JSON.stringify(commit).slice(1)}`
    const snapshotLine = `{"type":"marble-origami-snapshot","sessionId":"${session}",${JSON.stringify(snapshot).slice(1)}`
    expect(sandbox.text().split('\n')).toEqual([commitLine, lineOf(1), snapshotLine, snapshotLine, commitLine, ''])
  })
})

describe('when persistence is off, nothing is written', () => {
  const switches: Array<{ name: string; on: () => void }> = [
    { name: 'NODE_ENV=test without TEST_ENABLE_SESSION_PERSISTENCE', on: () => delete process.env.TEST_ENABLE_SESSION_PERSISTENCE },
    { name: 'TEST_ENABLE_SESSION_PERSISTENCE=0', on: () => (process.env.TEST_ENABLE_SESSION_PERSISTENCE = '0') },
    { name: 'cleanupPeriodDays: 0', on: () => (setFlagSettingsInline({ cleanupPeriodDays: 0 }), resetSettingsCache()) },
    { name: '--no-session-persistence', on: () => setSessionPersistenceDisabled(true) },
    { name: 'CLAUDIN_SKIP_PROMPT_HISTORY=1', on: () => (process.env.CLAUDIN_SKIP_PROMPT_HISTORY = '1') },
    { name: 'CLAUDIN_SKIP_PROMPT_HISTORY=true', on: () => (process.env.CLAUDIN_SKIP_PROMPT_HISTORY = 'true') },
  ]
  for (const { name, on } of switches) {
    test(name, async () => {
      cacheSessionTitle('would be written at materialization')
      on()
      await record([prompt(1, 'q'), reply(2, 'a')])
      await recordQueueOperation({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, sessionId: asSessionId(getSessionId()) })
      getProject().reAppendCostState()
      await flushSessionStorage()
      expect(existsSync(dirname(sandbox.transcript()))).toBe(false)
      setSessionPersistenceDisabled(false)
    })
  }

  test('cleanupPeriodDays other than 0 keeps writing', async () => {
    setFlagSettingsInline({ cleanupPeriodDays: 1 })
    resetSettingsCache()
    await record([prompt(1, 'q')])
    expect(chain()).toEqual([[uuidOf(1), null]])
  })
})

describe('removing a message', () => {
  test('the last line: the file is cut back to the bytes before it', async () => {
    await record([prompt(1, 'q')])
    const before = sandbox.text()
    await record([prompt(1, 'q'), reply(2, 'partial')])
    await removeTranscriptMessage(uuidOf(2))
    expect(sandbox.text()).toBe(before)
  })

  test('a line in the middle: only that line goes, the rest stays byte for byte', async () => {
    await record([prompt(1, 'q'), reply(2, 'a'), prompt(3, 'q2'), reply(4, 'a2')])
    const before = sandbox.text()
    const target = lineOf(2)
    await removeTranscriptMessage(uuidOf(2))
    expect(sandbox.text()).toBe(before.replace(`${target}\n`, ''))
  })

  test("the match is the message's own uuid, not a child naming it as parent", async () => {
    await record([prompt(1, 'q'), reply(2, 'a')])
    await removeTranscriptMessage(uuidOf(1))
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(2)])
  })

  test('a line further back than the last 64 KiB is still removed; damaged and blank lines stay', async () => {
    await record([prompt(1, 'target'), reply(2, 'x'.repeat(20_000))])
    appendFileSync(sandbox.transcript(), 'not json\n\n')
    await record([prompt(1, 'target'), reply(2, ''), ...[3, 4, 5, 6].map(n => reply(n, 'y'.repeat(20_000)))])
    const before = sandbox.text()
    expect(before.indexOf(uuidOf(1))).toBeLessThan(before.length - 64 * 1024)
    const target = lineOf(1)

    await removeTranscriptMessage(uuidOf(1))
    expect(sandbox.text()).toBe(before.replace(`${target}\n`, ''))
    expect(sandbox.text()).toContain('\nnot json\n\n')
  })

  test('a line longer than 64 KiB is removed', async () => {
    await record([prompt(1, 'q'), reply(2, 'z'.repeat(70_000))])
    const before = sandbox.text()
    const target = lineOf(2)
    await removeTranscriptMessage(uuidOf(2))
    expect(sandbox.text()).toBe(before.replace(`${target}\n`, ''))
  })

  test('a file over 50 MiB is left alone when the line is not in its last 64 KiB', async () => {
    await record([prompt(1, 'target')])
    const filler = `${JSON.stringify({ type: 'filler', pad: 'f'.repeat(1000) })}\n`
    appendFileSync(sandbox.transcript(), filler.repeat(Math.ceil((50 * 1024 * 1024) / filler.length) + 10))
    const size = statSync(sandbox.transcript()).size
    await removeTranscriptMessage(uuidOf(1))
    expect(statSync(sandbox.transcript()).size).toBe(size)
    expect(readFileSync(sandbox.transcript()).subarray(0, 4096).toString()).toContain(`"uuid":"${uuidOf(1)}"`)
  })

  test('before the file exists, a buffered line is dropped and never written', async () => {
    await record([notice(1, 'hook output')])
    await removeTranscriptMessage(uuidOf(1))
    await record([prompt(2, 'go')])
    expect(chain()).toEqual([[uuidOf(2), null]])
  })

  test('a line still in the write queue is removed, not resurrected', async () => {
    await record([prompt(1, 'q')])
    const pending = recordTranscript([prompt(1, 'q'), reply(2, 'streamed then retried')])
    await Bun.sleep(5)
    await removeTranscriptMessage(uuidOf(2))
    await pending
    await flushSessionStorage()
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(1)])
  })

  test('a transcript that is missing or empty: nothing happens', async () => {
    await record([prompt(1, 'q')])
    truncateSync(sandbox.transcript(), 0)
    await removeTranscriptMessage(uuidOf(1))
    expect(sandbox.text()).toBe('')

    switchSession(asSessionId(crypto.randomUUID()))
    getProject().sessionFile = sandbox.transcript()
    await removeTranscriptMessage(uuidOf(1))
    expect(existsSync(sandbox.transcript())).toBe(false)
  })
})

describe('the file pointer', () => {
  test('resetSessionFilePointer: the next message opens the current session file, and buffered lines are dropped', async () => {
    await record([prompt(1, 'old session')])
    const old = sandbox.transcript()
    switchSession(asSessionId(crypto.randomUUID()))
    await resetSessionFilePointer()
    expect(getProject().sessionFile).toBeNull()
    await record([notice(2, 'dropped')])
    await resetSessionFilePointer()
    await record([prompt(3, 'new session')])

    expect(sandbox.transcript()).not.toBe(old)
    expect(chain()).toEqual([[uuidOf(3), null]])
    expect(chain(old)).toEqual([[uuidOf(1), null]])
  })

  test('getProject().sessionFile is null before the first message and the transcript path after it', async () => {
    expect(getProject().sessionFile).toBeNull()
    await record([prompt(1, 'q')])
    expect(getProject().sessionFile).toBe(sandbox.transcript())
  })
})
