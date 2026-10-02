/**
 * A scripted Anthropic Messages endpoint for the end-to-end prompt-cache
 * suite (src/agent/cache/wirePrefix.e2e.test.ts), and the session runner that
 * drives the BUILT CLI against it.
 *
 * The CLI is dist/cli.mjs (through bin/claudin), the bundle that ships: feature() folded, every
 * production flag in place — what no source-side test can see. It runs
 * headless with stream-json input, so one process serves every turn of a
 * session, the way a user's does. Nothing reaches the real API: the CLI's only
 * credential is a fake key in a throwaway config dir pointed at this server,
 * and every response id is the mock's.
 *
 * Routing never counts requests. A request is answered from where it is in
 * the script: the one whose last user message holds the tool_results of step
 * N gets step N+1; the one carrying a turn's prompt token gets that turn's
 * first step. A request from a sub-agent (its first message carries the
 * sub-agent token) or a side query (title, classifier) gets plain text.
 * Pieces adapted from scripts/bench/ab/read-credit-e2e.ts.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

export type Json = Record<string, any>

export const MOCK_MODEL = 'claude-opus-5-5'
export const MOCK_ID_PREFIX = 'msg_e2e_'
const MOCK_KEY = 'sk-ant-api03-prefix-e2e-mock-key'

export type ToolCall = { name: string; input: Json }
/** One model response: thinking (by default), then text and/or tool calls. */
export type Step = { text?: string; tools?: ToolCall[]; thinking?: boolean }
export type Turn = { prompt: string; steps: Step[] }

/** One recorded /v1/messages body and who it was for. */
export type Capture = {
  body: Json
  /** 'main' for the session's own thread, 'sub' for a sub-agent, 'side' otherwise. */
  thread: 'main' | 'sub' | 'side'
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function frame(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

let counter = 0

function sse(step: Step, toolIds: string[]): string {
  const id = `${MOCK_ID_PREFIX}${++counter}`
  let out = frame('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MOCK_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  let index = 0
  const block = (start: Json, deltas: Json[]) => {
    out += frame('content_block_start', { type: 'content_block_start', index, content_block: start })
    for (const delta of deltas) out += frame('content_block_delta', { type: 'content_block_delta', index, delta })
    out += frame('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (step.thinking !== false) {
    // A signed thinking block, as Opus 5.5 sends it: the CLI stores it and
    // re-sends it, so the round trip goes through the prefix check too.
    block({ type: 'thinking', thinking: '', signature: '' }, [
      { type: 'thinking_delta', thinking: `thinking ${id}` },
      { type: 'signature_delta', signature: `sig_${id}` },
    ])
  }
  if (step.text !== undefined || !step.tools?.length) {
    block({ type: 'text', text: '' }, [{ type: 'text_delta', text: step.text ?? 'ok' }])
  }
  for (const [i, call] of (step.tools ?? []).entries()) {
    block({ type: 'tool_use', id: toolIds[i], name: call.name, input: {} }, [
      { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    ])
  }
  out += frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: step.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  out += frame('message_stop', { type: 'message_stop' })
  return out
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function blocksOf(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function textOf(message: unknown): string {
  if (!isRecord(message)) return ''
  return blocksOf(message.content)
    .map(b => (b.type === 'text' ? String(b.text ?? '') : ''))
    .join('\n')
}

type Session = {
  token: string
  subToken: string
  turns: Turn[]
  captures: Capture[]
  /** tool_use id → [turn, step] it was issued for. */
  issued: Map<string, [number, number]>
  /** Results the scripted calls got back, by tool_use id. */
  results: Map<string, { text: string; isError: boolean }>
}

export type MockServer = {
  baseUrl: string
  register: (session: Session) => void
  close: () => void
}

export async function startMockAnthropic(): Promise<MockServer> {
  const sessions: Session[] = []

  const route = (body: Json): { session?: Session; thread: Capture['thread']; reply: string } => {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
    const first = textOf(messages[0])
    const session = sessions.find(s => first.includes(s.token) || first.includes(s.subToken))
    const side = { session, thread: 'side' as const, reply: sse({ text: 'ok', thinking: false }, []) }
    if (!session) return side
    if (!first.includes(session.token)) return { ...side, thread: 'sub' }
    // A main-thread side query (title, classifier) sends no tool pool.
    if (!Array.isArray(body.tools) || body.tools.length === 0) return side

    const last = messages.findLast(m => m.role === 'user')
    let at: [number, number] | undefined
    for (const block of blocksOf(last?.content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const from = session.issued.get(block.tool_use_id)
      if (!from) continue
      session.results.set(block.tool_use_id, {
        text: blocksOf(block.content).map(b => String(b.text ?? '')).join('\n'),
        isError: block.is_error === true,
      })
      at = [from[0], from[1] + 1]
    }
    if (!at) {
      const said = textOf(last)
      const turn = session.turns.findIndex(t => said.includes(t.prompt))
      at = turn === -1 ? undefined : [turn, 0]
    }
    const step = at ? session.turns[at[0]]?.steps[at[1]] : undefined
    if (!at || !step) return { session, thread: 'main', reply: sse({ text: 'done' }, []) }
    const ids = (step.tools ?? []).map(() => `toolu_e2e_${String(++counter).padStart(4, '0')}`)
    for (const id of ids) session.issued.set(id, at)
    return { session, thread: 'main', reply: sse(step, ids) }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = req.url ?? ''
      if (path.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      if (req.method !== 'POST' || !path.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: Json = {}
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (isRecord(parsed)) body = parsed
      } catch {
        // an unparseable body is answered as a side request
      }
      const { session, thread, reply } = route(body)
      session?.captures.push({ body, thread })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(reply)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    register: s => sessions.push(s),
    close: () => server.close(),
  }
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/** The session running the suite leaks its own; a GIT_DIR would point git elsewhere. */
const HOST_ENV_RE = /^(?:CLAUDECODE$|CLAUDE_CODE_|_?CLAUDIN_|ANTHROPIC_|GIT_)/

export type SessionSpec = {
  /** Unique per scenario: it routes the mock and names the workspace. */
  key: string
  turns: Turn[]
  /** Files written into the workspace, which is a git repo. */
  files?: Record<string, string>
  /** CLAUDIN_CONFIG_DIR/settings.json. */
  settings?: Json
  env?: Record<string, string>
}

export type SessionRun = {
  captures: Capture[]
  results: Map<string, { text: string; isError: boolean }>
  /** tool_use ids the script issued, with the call they were for. */
  issued: Array<{ id: string; turn: number; step: number }>
  stderr: string
  exitCode: number | null
  /** Ids of the model responses the CLI printed — all must be the mock's. */
  modelIds: string[]
}

/**
 * `launcher` is bin/claudin: it runs dist/cli.mjs under Node, as installs do.
 * Under Bun the bundle's HTTP client (undici) fails before the first request.
 */
export async function runSession(
  mock: MockServer,
  launcher: string,
  root: string,
  spec: SessionSpec,
): Promise<SessionRun> {
  const dir = join(root, spec.key)
  const ws = join(dir, 'workspace')
  const configDir = join(dir, 'config')
  mkdirSync(ws, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  for (const [name, content] of Object.entries({ 'README.md': '# e2e\n', ...spec.files })) {
    mkdirSync(join(ws, name, '..'), { recursive: true })
    writeFileSync(join(ws, name), content)
  }
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: ws })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'init')

  const profile = { id: 'prefix-e2e', name: 'prefix e2e mock', provider: 'anthropic', baseUrl: mock.baseUrl, model: MOCK_MODEL, apiKey: MOCK_KEY }
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ providerProfiles: [profile], activeProviderProfileId: profile.id, hasCompletedOnboarding: true }),
  )
  if (spec.settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(spec.settings))

  const token = `[e2e ${spec.key}]`
  const session: Session = {
    token,
    subToken: `[e2e-sub ${spec.key}]`,
    turns: spec.turns.map(t => ({ ...t, prompt: `${t.prompt} ${token}` })),
    captures: [],
    issued: new Map(),
    results: new Map(),
  }
  mock.register(session)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_ENV_RE.test(k)) env[k] = v
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  Object.assign(env, {
    NODE_ENV: 'production',
    CLAUDIN_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: mock.baseUrl,
    // A localhost base URL otherwise flips the CLI into its non-first-party shape.
    CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    CLAUDIN_CACHE_STRICT: '1',
    ...spec.env,
  })

  const child = spawn(
    launcher,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', MOCK_MODEL, '--dangerously-skip-permissions'],
    { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', d => (stderr += String(d)))
  const modelIds: string[] = []
  let buf = ''
  const waiting: Array<() => void> = []
  child.stdout.on('data', d => {
    buf += String(d)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let event: Json
      try {
        event = JSON.parse(line) as Json
      } catch {
        continue
      }
      // `<synthetic>` is the CLI's own message (a local command's output), not a model response.
      if (event.type === 'assistant' && isRecord(event.message) && event.message.model !== '<synthetic>') {
        modelIds.push(String(event.message.id))
      }
      if (event.type === 'result') waiting.shift()?.()
    }
  })
  const closed = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const kill = setTimeout(() => child.kill('SIGTERM'), 100_000)
  for (const turn of session.turns) {
    const done = new Promise<void>(resolve => waiting.push(resolve))
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: turn.prompt } })}\n`)
    await Promise.race([done, closed])
  }
  child.stdin.end()
  const exitCode = await closed
  clearTimeout(kill)

  return {
    captures: session.captures,
    results: session.results,
    issued: [...session.issued].map(([id, [turn, step]]) => ({ id, turn, step })),
    stderr,
    exitCode,
    modelIds,
  }
}
