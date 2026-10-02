/**
 * A tiny language server for tests: a real child process that speaks JSON-RPC
 * over stdio with LSP's Content-Length framing. Tests spawn it with
 * `bun fakeLanguageServer.ts '<json behaviour>'`; see `FakeServerBehaviour`.
 *
 * Besides the lifecycle methods it answers a few `fake/*` requests that let a
 * test look inside the server (what it was told, what it received) and make it
 * misbehave on demand (fail, crash, push a notification, ask the client).
 *
 * Run as a script only — importing it from a test just gets the types and the
 * path helpers below.
 */
import { writeFileSync } from 'fs'

export type FakeServerBehaviour = {
  /** Returned as `capabilities` from initialize. */
  capabilities?: Record<string, unknown>
  /** What to do with `initialize`. Default 'answer'. */
  onInitialize?: 'answer' | 'hang' | 'reject' | { exitWith: number }
  /** What to do with `shutdown`. Default 'answer'. */
  onShutdown?: 'answer' | 'reject'
  /**
   * On didOpen/didChange, publish one error per line holding this marker
   * (and an empty list when none does).
   */
  flagLinesContaining?: string
  /** Written once at boot with this process's pid. */
  pidFile?: string
  /** Echoed to stderr at boot. */
  stderrBanner?: string
}

type Incoming = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export const FAKE_SERVER_SCRIPT = new URL(import.meta.url).pathname

/** `command` and `args` for a config that launches the fake server. */
export function fakeServerCommand(behaviour: FakeServerBehaviour = {}): {
  command: string
  args: string[]
} {
  return { command: process.execPath, args: [FAKE_SERVER_SCRIPT, JSON.stringify(behaviour)] }
}

function runServer(behaviour: FakeServerBehaviour): void {
  const journal: Array<{ method: string; params: unknown }> = []
  const flakyCounts = new Map<string, number>()
  const awaitingClient = new Map<number, (reply: Incoming) => void>()
  let initializeParams: unknown
  let nextOutgoingId = 1

  const send = (payload: Record<string, unknown>): void => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...payload }), 'utf8')
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
    process.stdout.write(body)
  }
  const reply = (id: Incoming['id'], result: unknown): void => send({ id, result })
  const refuse = (id: Incoming['id'], code: number, message: string): void =>
    send({ id, error: { code, message } })

  const publishFor = (uri: string, text: string): void => {
    const marker = behaviour.flagLinesContaining
    if (marker === undefined) return
    const diagnostics = text
      .split('\n')
      .flatMap((content, line) =>
        content.includes(marker)
          ? [
              {
                range: { start: { line, character: 0 }, end: { line, character: content.length } },
                severity: 1,
                source: 'fake',
                message: `line ${line + 1} holds ${marker}`,
              },
            ]
          : [],
      )
    send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
  }

  const askClient = (method: string, params: unknown): Promise<Incoming> =>
    new Promise(resolve => {
      const id = nextOutgoingId++
      awaitingClient.set(id, resolve)
      send({ id, method, params })
    })

  const onNotification = (method: string, params: any): void => {
    journal.push({ method, params })
    if (method === 'exit') process.exit(0)
    if (method === 'textDocument/didOpen') {
      publishFor(params.textDocument.uri, params.textDocument.text)
    }
    if (method === 'textDocument/didChange') {
      publishFor(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? '')
    }
  }

  const onRequest = async (id: Incoming['id'], method: string, params: any): Promise<void> => {
    switch (method) {
      case 'initialize': {
        initializeParams = params
        const how = behaviour.onInitialize ?? 'answer'
        if (how === 'hang') return
        if (how === 'reject') return refuse(id, -32603, 'initialize refused by fake')
        if (typeof how === 'object') process.exit(how.exitWith)
        return reply(id, {
          capabilities: behaviour.capabilities ?? {},
          serverInfo: { name: 'fake', version: '0' },
        })
      }
      case 'shutdown':
        if (behaviour.onShutdown === 'reject') return refuse(id, -32603, 'shutdown refused by fake')
        return reply(id, null)
      case 'fake/echo':
        return reply(id, params)
      case 'fake/fail':
        return refuse(id, params.code, params.message)
      case 'fake/flaky': {
        const seen = (flakyCounts.get(params.key) ?? 0) + 1
        flakyCounts.set(params.key, seen)
        if (seen <= params.failures) return refuse(id, -32801, 'content modified')
        return reply(id, { attempts: seen })
      }
      case 'fake/journal':
        return reply(id, journal)
      case 'fake/initializeParams':
        return reply(id, initializeParams)
      case 'fake/whoami':
        return reply(id, {
          pid: process.pid,
          cwd: process.cwd(),
          env: params?.env ? (process.env[params.env] ?? null) : null,
        })
      case 'fake/crash':
        process.exit(params.code)
        return
      case 'fake/garbage':
        // A correctly framed body that is not JSON, then the real answer.
        process.stdout.write('Content-Length: 9\r\n\r\n{not json')
        return reply(id, 'after garbage')
      case 'fake/push':
        send({ method: params.method, params: params.params })
        return reply(id, 'pushed')
      case 'fake/ask': {
        const answer = await askClient(params.method, params.params)
        return reply(id, answer.error !== undefined ? { error: answer.error } : { result: answer.result })
      }
      default:
        return refuse(id, -32601, `no handler for ${method}`)
    }
  }

  const dispatch = (message: Incoming): void => {
    if (message.method === undefined) {
      const waiter = awaitingClient.get(message.id as number)
      awaitingClient.delete(message.id as number)
      waiter?.(message)
    } else if (message.id === undefined) {
      onNotification(message.method, message.params)
    } else {
      void onRequest(message.id, message.method, message.params)
    }
  }

  let pending = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const headerEnd = pending.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = pending.subarray(0, headerEnd).toString('ascii')
      const size = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
      const bodyStart = headerEnd + 4
      if (pending.length < bodyStart + size) return
      const body = pending.subarray(bodyStart, bodyStart + size).toString('utf8')
      pending = pending.subarray(bodyStart + size)
      dispatch(JSON.parse(body))
    }
  })
  process.stdin.on('end', () => process.exit(0))

  if (behaviour.pidFile) writeFileSync(behaviour.pidFile, String(process.pid))
  if (behaviour.stderrBanner) process.stderr.write(`${behaviour.stderrBanner}\n`)
}

if (import.meta.main) {
  runServer(JSON.parse(process.argv[2] ?? '{}') as FakeServerBehaviour)
}
