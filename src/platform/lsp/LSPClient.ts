// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/lsp/client.ts
// packages/opencode/src/util/process.ts
import { type ChildProcessWithoutNullStreams, spawn } from 'child_process'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver-protocol/node'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { subprocessEnv } from 'src/shared/proc/subprocessEnv.js'

type LSPClientStartOptions = {
  /** Laid over this process's environment for the server. */
  env?: Record<string, string>
  cwd?: string
}

type NotificationHandler = (params: unknown) => void
type RequestHandler = (params: unknown) => unknown

/**
 * A JSON-RPC client for one language server spoken to over stdio. One client
 * outlives many server processes: `start` spawns a process, `stop` ends it,
 * and the handlers registered on the client follow it to every process.
 */
export type LSPClient = {
  /** What the server declared in its initialize result; undefined before. */
  readonly capabilities: ServerCapabilities | undefined
  /** True between a successful initialize and the process ending. */
  readonly isInitialized: boolean
  start(command: string, args: string[], options?: LSPClientStartOptions): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
  stop(): Promise<void>
}

/** One spawned server process and the connection over its stdio. */
type Session = {
  child: ChildProcessWithoutNullStreams
  connection: MessageConnection
  /** Settles when the process exits, with the error that describes the exit. */
  exit: Promise<Error>
  /** The process exited or its output closed: nothing more will come back. */
  gone: boolean
  /** Set before an exit we caused, so it is not reported as a crash. */
  stopping: boolean
  initialized: boolean
  capabilities: ServerCapabilities | undefined
}

export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  const notificationHandlers = new Map<string, NotificationHandler>()
  const requestHandlers = new Map<string, RequestHandler>()
  let session: Session | undefined

  function requireSession(): Session {
    if (!session) throw new Error('LSP client not started')
    return session
  }

  function openSession(child: ChildProcessWithoutNullStreams): Session {
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    )
    let settleExit: (error: Error) => void = () => {}
    const current: Session = {
      child,
      connection,
      exit: new Promise(resolve => (settleExit = resolve)),
      gone: false,
      stopping: false,
      initialized: false,
      capabilities: undefined,
    }

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      logForDebugging(`[LSP ${serverName} stderr] ${chunk}`)
    })
    child.on('error', error => {
      logError(new Error(`LSP server ${serverName} process error: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      current.gone = true
      current.initialized = false
      const error = describeExit(serverName, code, signal)
      settleExit(error)
      if (current.stopping || code === 0) {
        logForDebugging(`LSP server ${serverName}: ${error.message}`)
        return
      }
      onCrash?.(error)
    })

    // A message the reader cannot decode is dropped by vscode-jsonrpc, which
    // then carries on with the next one, so the connection stays usable.
    connection.onError(([error]) => {
      logError(new Error(`LSP server ${serverName} connection error: ${error.message}`))
    })
    for (const [method, handler] of notificationHandlers) {
      connection.onNotification(method, handler)
    }
    for (const [method, handler] of requestHandlers) {
      connection.onRequest(method, handler)
    }
    connection.listen()
    return current
  }

  async function start(
    command: string,
    args: string[],
    options: LSPClientStartOptions = {},
  ): Promise<void> {
    if (session) closeSession(session)
    session = undefined
    const child = await spawnServer(command, args, options)
    session = openSession(child)
    logForDebugging(`LSP server ${serverName} started (pid ${child.pid})`)
  }

  async function initialize(params: InitializeParams): Promise<InitializeResult> {
    const current = requireSession()
    const result = await settleBeforeExit(
      current,
      current.connection.sendRequest<InitializeResult>('initialize', params),
    )
    await current.connection.sendNotification('initialized', {})
    current.capabilities = result.capabilities
    current.initialized = !current.gone
    return result
  }

  async function sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
    const current = requireSession()
    if (!current.initialized) throw new Error('LSP server not initialized')
    return settleBeforeExit(current, current.connection.sendRequest<TResult>(method, params))
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    const current = requireSession()
    if (current.gone) {
      logForDebugging(`LSP server ${serverName} is gone; dropped notification ${method}`)
      return
    }
    await current.connection.sendNotification(method, params)
  }

  function onNotification(method: string, handler: NotificationHandler): void {
    notificationHandlers.set(method, handler)
    session?.connection.onNotification(method, handler)
  }

  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    const untyped: RequestHandler = params => handler(params as TParams)
    requestHandlers.set(method, untyped)
    session?.connection.onRequest(method, untyped)
  }

  async function stop(): Promise<void> {
    const current = session
    if (!current) return
    session = undefined
    current.stopping = true
    try {
      await shutdownGracefully(current)
    } finally {
      closeSession(current)
    }
  }

  return {
    get capabilities() {
      return session?.capabilities
    },
    get isInitialized() {
      return session?.initialized ?? false
    },
    start,
    initialize,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
    stop,
  }
}

function spawnServer(
  command: string,
  args: string[],
  options: LSPClientStartOptions,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...subprocessEnv(), ...options.env },
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.off('error', reject)
      resolve(child)
    })
  })
}

/**
 * vscode-jsonrpc only rejects a pending request when the connection is
 * disposed, so a request the server dies under would otherwise wait forever.
 */
function settleBeforeExit<T>(current: Session, request: Promise<T>): Promise<T> {
  const exited = current.exit.then((error): never => {
    throw error
  })
  return Promise.race([request, exited])
}

/** LSP's polite ending: `shutdown`, then `exit` once the server agreed. */
async function shutdownGracefully(current: Session): Promise<void> {
  const answered = await Promise.race([
    current.connection.sendRequest('shutdown').then(() => true),
    current.exit.then(() => false),
  ])
  if (!answered) return
  try {
    await current.connection.sendNotification('exit')
  } catch (error) {
    // The server may close its end as soon as it answers shutdown; it is
    // killed right after either way.
    logForDebugging(`LSP exit notification not delivered: ${errorMessage(error)}`)
  }
}

function closeSession(current: Session): void {
  current.stopping = true
  current.connection.dispose()
  if (current.child.exitCode === null && current.child.signalCode === null) {
    current.child.kill()
  }
}

function describeExit(
  serverName: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  if (code !== null && code !== 0) {
    return new Error(`LSP server ${serverName} crashed with exit code ${code}`)
  }
  if (signal !== null) return new Error(`LSP server ${serverName} was killed by ${signal}`)
  return new Error(`LSP server ${serverName} exited`)
}
