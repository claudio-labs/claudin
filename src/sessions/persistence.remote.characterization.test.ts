/**
 * Characterization of the remote side of the transcript writer
 * (`sessions/persistence`): hydrating a session from Session Ingress (the
 * `-p --resume <url>` path behind ENABLE_SESSION_PERSISTENCE), mirroring new
 * transcript lines to it, and the CCR v2 internal-event writer and readers.
 *
 * Session Ingress is a local HTTP server started per test; the token comes
 * from CLAUDE_CODE_SESSION_ACCESS_TOKEN, as in a CCR container. The CCR v2
 * readers and writer are plain functions, which is how the worker hands
 * them over.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import { runChild, usePersistenceSandbox } from 'src/sessions/__testutils__/persistenceSandbox.js'
import {
  flushSessionStorage,
  getAgentTranscriptPath,
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  saveTag,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
} from 'src/sessions/sessionStorage.js'
import { asAgentId, asSessionId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = usePersistenceSandbox()

const AT = '2026-03-14T09:26:53.000Z'
const TOKEN = 'ingress-token-for-tests'
const FIXTURES = join(import.meta.dir, 'persistence', '__fixtures__', 'rewrite')
const STORED_SESSION = '5e551011-0000-4000-8000-00000000f1a7'

function uuidOf(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function prompt(n: number, text: string): Message {
  return createUserMessage({ content: text, uuid: uuidOf(n), timestamp: AT })
}

function reply(n: number, text: string): Message {
  return { ...createAssistantMessage({ content: text }), uuid: uuidOf(n), timestamp: AT }
}

type Seen = { method: string; path: string; headers: Record<string, string>; body: string }

/** A Session Ingress stand-in: GET answers `logs`, PUT answers `putStatus`; every request is kept. */
function ingress(answer: { getStatus?: number; getBody?: string; putStatus?: number } = {}) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      if (request.method === 'GET') {
        return new Response(answer.getBody ?? '{"loglines":[]}', {
          status: answer.getStatus ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: answer.putStatus ?? 200, headers: { 'content-type': 'application/json' } })
    },
  })
  servers.push(server)
  return { url: (session: string) => `http://127.0.0.1:${server.port}/v1/session_ingress/session/${session}`, seen }
}

const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const storedLogs = () => readFileSync(join(FIXTURES, 'ingress-loglines.json'), 'utf8')

function useToken(): void {
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = TOKEN
}

describe('hydrating from Session Ingress', () => {
  test('the stored lines replace the local transcript, one JSON line each, matching the fixture', async () => {
    useToken()
    const server = ingress({ getBody: storedLogs() })
    switchSession(asSessionId(STORED_SESSION))
    const transcript = sandbox.transcript()
    switchSession(asSessionId(crypto.randomUUID()))

    const found = await hydrateRemoteSession(STORED_SESSION, server.url(STORED_SESSION))

    expect(found).toBe(true)
    expect(getSessionId()).toBe(asSessionId(STORED_SESSION))
    expect(readFileSync(transcript, 'utf8')).toBe(readFileSync(join(FIXTURES, 'hydrated.jsonl'), 'utf8'))
    expect(statSync(transcript).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(transcript)).mode & 0o777).toBe(0o700)
    expect(server.seen.map(r => [r.method, r.path, r.headers.authorization])).toEqual([
      ['GET', `/v1/session_ingress/session/${STORED_SESSION}`, `Bearer ${TOKEN}`],
    ])
  })

  test('the result says whether anything was stored; the local file is replaced either way', async () => {
    useToken()
    const cases: Array<{ name: string; answer: Parameters<typeof ingress>[0]; found: boolean; text: string }> = [
      { name: 'stored lines', answer: { getBody: storedLogs() }, found: true, text: readFileSync(join(FIXTURES, 'hydrated.jsonl'), 'utf8') },
      { name: 'no lines', answer: { getBody: '{"loglines":[]}' }, found: false, text: '' },
      { name: 'not found', answer: { getStatus: 404, getBody: '{}' }, found: false, text: '' },
      { name: 'token refused', answer: { getStatus: 401, getBody: '{}' }, found: false, text: '' },
      { name: 'a malformed answer', answer: { getBody: '{"lines":[]}' }, found: false, text: '' },
    ]
    for (const { name, answer, found, text } of cases) {
      const server = ingress(answer)
      switchSession(asSessionId(STORED_SESSION))
      mkdirSync(dirname(sandbox.transcript()), { recursive: true })
      writeFileSync(sandbox.transcript(), 'local line\n')
      const result = await hydrateRemoteSession(STORED_SESSION, server.url(STORED_SESSION))
      expect({ name, result, text: sandbox.text() }).toEqual({ name, result: found, text })
    }
  })

  test('a failure before the write returns false and leaves no file', async () => {
    useToken()
    const server = ingress({ getBody: storedLogs() })
    writeFileSync(join(sandbox.root, 'not-a-directory'), '')
    process.env.CLAUDIN_CONFIG_DIR = join(sandbox.root, 'not-a-directory')
    expect(await hydrateRemoteSession(STORED_SESSION, server.url(STORED_SESSION))).toBe(false)
    expect(existsSync(sandbox.transcript())).toBe(false)
  })
})

describe('mirroring new lines to Session Ingress', () => {
  test('after hydration, each new message is PUT with the previous uuid; hydrated ones are neither re-sent nor re-written; the hydrated title is re-stamped', async () => {
    useToken()
    process.env.ENABLE_SESSION_PERSISTENCE = '1'
    const server = ingress({ getBody: storedLogs() })
    await hydrateRemoteSession(STORED_SESSION, server.url(STORED_SESSION))
    const before = sandbox.text()

    await recordTranscript([prompt(1, 'List the files'), prompt(6, 'And the tests?'), reply(7, 'None yet')])
    await flushSessionStorage()

    const puts = server.seen.filter(r => r.method === 'PUT')
    expect(puts.map(r => [r.path, r.headers['last-uuid'], r.headers.authorization, r.headers['content-type']])).toEqual([
      [`/v1/session_ingress/session/${STORED_SESSION}`, uuidOf(3), `Bearer ${TOKEN}`, 'application/json'],
      [`/v1/session_ingress/session/${STORED_SESSION}`, uuidOf(6), `Bearer ${TOKEN}`, 'application/json'],
    ])
    const appended = sandbox.text().slice(before.length).split('\n').filter(Boolean)
    expect(appended.map(line => JSON.parse(line).uuid ?? JSON.parse(line).customTitle)).toEqual(['Parser fixes', uuidOf(6), uuidOf(7)])
    expect(puts.map(r => JSON.parse(r.body))).toEqual(appended.slice(1).map(line => JSON.parse(line)))
  })

  test('the PUT is done when recordTranscript resolves, and the local line follows within the 10 ms remote interval', async () => {
    useToken()
    process.env.ENABLE_SESSION_PERSISTENCE = '1'
    const server = ingress()
    setRemoteIngressUrlForTesting(server.url(getSessionId()))
    await recordTranscript([prompt(1, 'quick')])
    expect(server.seen.length).toBe(1)
    await Bun.sleep(60)
    expect(sandbox.text()).toContain(uuidOf(1))
  })

  test('a hydration that found nothing still turns the mirroring on', async () => {
    useToken()
    process.env.ENABLE_SESSION_PERSISTENCE = '1'
    const server = ingress({ getStatus: 401, getBody: '{}' })
    const session = crypto.randomUUID()
    await hydrateRemoteSession(session, server.url(session))
    await recordTranscript([prompt(1, 'after a refused read')])
    expect(server.seen.map(r => [r.method, r.headers['last-uuid']]) as unknown).toEqual([
      ['GET', undefined],
      ['PUT', undefined],
    ])
  })

  test('nothing is sent without ENABLE_SESSION_PERSISTENCE', async () => {
    useToken()
    const server = ingress()
    setRemoteIngressUrlForTesting(server.url(getSessionId()))
    await recordTranscript([prompt(1, 'local only')])
    await flushSessionStorage()
    expect(server.seen).toEqual([])
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(1)])
  })

  test('only main-transcript messages are sent: not metadata, queue operations, snapshots or agent lines', async () => {
    useToken()
    process.env.ENABLE_SESSION_PERSISTENCE = '1'
    const server = ingress()
    setRemoteIngressUrlForTesting(server.url(getSessionId()))
    await recordTranscript([prompt(1, 'main')])
    await saveTag(getSessionId() as UUID, 'tagged')
    await recordQueueOperation({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, sessionId: asSessionId(getSessionId()) })
    await recordFileHistorySnapshot(uuidOf(1), { messageId: uuidOf(1), trackedFileBackups: {}, timestamp: new Date(AT) }, false)
    await recordSidechainTranscript([reply(2, 'agent line')], 'agent-q', uuidOf(1))
    await recordSidechainTranscript([reply(3, 'sidechain without agent')], undefined, uuidOf(1))
    await flushSessionStorage()
    expect(server.seen.map(r => JSON.parse(r.body).uuid)).toEqual([uuidOf(1), uuidOf(3)])
  })

  test('a PUT that fails ends the process with exit code 1', async () => {
    const server = ingress({ putStatus: 401 })
    const session = 'fa11ed00-0000-4000-8000-000000000000'
    const script = `
      const storage = await import('src/sessions/sessionStorage.js')
      const state = await import('src/platform/bootstrap/state.js')
      const { createUserMessage } = await import('src/agent/messages/messages.js')
      state.setOriginalCwd(process.env.PROJECT)
      state.setCwdState(process.env.PROJECT)
      state.switchSession(process.env.SESSION)
      storage.setRemoteIngressUrlForTesting(process.env.INGRESS)
      await storage.recordTranscript([createUserMessage({ content: 'rejected' })])
      await new Promise(resolve => setTimeout(resolve, 5000))
      console.log('still running')
    `
    const run = await runChild(script, {
      HOME: sandbox.root,
      CLAUDIN_CONFIG_DIR: sandbox.configDir,
      PROJECT: sandbox.project,
      SESSION: session,
      INGRESS: server.url(session),
      ENABLE_SESSION_PERSISTENCE: '1',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: TOKEN,
    })
    expect(run.exitCode).toBe(1)
    expect(run.stdout).not.toContain('still running')
    expect(server.seen.filter(r => r.method === 'PUT').length).toBe(1)
  }, 30_000)
})

describe('the CCR v2 internal event writer', () => {
  type Call = { kind: string; payload: Record<string, unknown>; options: unknown }

  function useWriter(fail = false): Call[] {
    const calls: Call[] = []
    setInternalEventWriter(async (kind, payload, options) => {
      calls.push({ kind, payload, options })
      if (fail) throw new Error('worker gone')
    })
    return calls
  }

  test('each new main-transcript message goes to the writer as written, with compaction and agent flags', async () => {
    const calls = useWriter()
    const boundary = { ...createCompactBoundaryMessage('auto', 99), uuid: uuidOf(3), timestamp: AT }
    await recordTranscript([prompt(1, 'q'), { ...reply(2, 'a'), agentId: 'helper' } as unknown as Message, boundary])
    await recordTranscript([prompt(1, 'q')])
    await saveTag(getSessionId() as UUID, 'not an event')
    await recordSidechainTranscript([reply(4, 'agent')], 'agent-w', null)
    await flushSessionStorage()

    expect(calls.map(c => [c.kind, c.payload.uuid, c.options])).toEqual([
      ['transcript', uuidOf(1), {}],
      ['transcript', uuidOf(2), { agentId: 'helper' }],
      ['transcript', uuidOf(3), { isCompaction: true }],
    ])
    expect(calls.map(c => c.payload)).toEqual(sandbox.entries().filter(e => e.type !== 'tag'))
  })

  test('the writer replaces Session Ingress, and its failures do not stop the local write', async () => {
    useToken()
    process.env.ENABLE_SESSION_PERSISTENCE = '1'
    const server = ingress()
    setRemoteIngressUrlForTesting(server.url(getSessionId()))
    const calls = useWriter(true)
    await recordTranscript([prompt(1, 'q')])
    await Bun.sleep(60)
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(1)])
    expect(calls.length).toBe(1)
    expect(server.seen).toEqual([])
  })
})

describe('hydrating from CCR v2 internal events', () => {
  const events = () =>
    JSON.parse(storedLogs()).loglines.map((payload: Record<string, unknown>) => ({ payload }))

  test('without a reader: false, the session switched, nothing written', async () => {
    const session = crypto.randomUUID()
    expect(await hydrateFromCCRv2InternalEvents(session)).toBe(false)
    expect(getSessionId()).toBe(asSessionId(session))
    expect(existsSync(sandbox.transcript())).toBe(false)
  })

  test('foreground payloads become the transcript, matching the Session Ingress fixture', async () => {
    setInternalEventReader(async () => events(), async () => null)
    expect(await hydrateFromCCRv2InternalEvents(STORED_SESSION)).toBe(true)
    expect(sandbox.text()).toBe(readFileSync(join(FIXTURES, 'hydrated.jsonl'), 'utf8'))
    expect(statSync(sandbox.transcript()).mode & 0o777).toBe(0o600)
  })

  test('the result and the file for an empty, a failed and a throwing read', async () => {
    const cases: Array<{ name: string; read: () => Promise<unknown>; result: boolean | string; file: string | undefined }> = [
      { name: 'no events', read: async () => [], result: false, file: '' },
      { name: 'a failed read', read: async () => null, result: false, file: undefined },
      { name: 'a thrown error', read: async () => Promise.reject(new Error('network down')), result: false, file: undefined },
      { name: 'an epoch mismatch', read: async () => Promise.reject(new Error('CCRClient: Epoch mismatch (409)')), result: 'CCRClient: Epoch mismatch (409)', file: undefined },
    ]
    for (const { name, read, result, file } of cases) {
      setInternalEventReader(read as never, async () => null)
      const session = crypto.randomUUID()
      const outcome = await hydrateFromCCRv2InternalEvents(session).catch((e: Error) => e.message)
      expect({ name, outcome, file: existsSync(sandbox.transcript()) ? sandbox.text() : undefined }).toEqual({ name, outcome: result, file })
    }
  })

  test("subagent payloads go to each agent's file, in order; events without an agent id are dropped", async () => {
    const line = (n: number) => ({ type: 'assistant', uuid: uuidOf(n), isSidechain: true })
    setInternalEventReader(
      async () => [{ payload: line(1) }],
      async () => [
        { payload: line(2), agent_id: 'alpha' },
        { payload: line(3), agent_id: 'beta' },
        { payload: line(4) },
        { payload: line(5), agent_id: '' },
        { payload: line(6), agent_id: 'alpha' },
      ],
    )
    expect(await hydrateFromCCRv2InternalEvents(crypto.randomUUID())).toBe(true)
    const alpha = getAgentTranscriptPath(asAgentId('alpha'))
    const beta = getAgentTranscriptPath(asAgentId('beta'))
    expect(readFileSync(alpha, 'utf8')).toBe(`${JSON.stringify(line(2))}\n${JSON.stringify(line(6))}\n`)
    expect(readFileSync(beta, 'utf8')).toBe(`${JSON.stringify(line(3))}\n`)
    expect(readdirSync(dirname(alpha)).sort()).toEqual(['agent-alpha.jsonl', 'agent-beta.jsonl'])
    expect(statSync(alpha).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(alpha)).mode & 0o777).toBe(0o700)
  })
})
