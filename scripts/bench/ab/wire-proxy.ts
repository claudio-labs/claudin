#!/usr/bin/env bun
/**
 * A recording reverse proxy for the Anthropic Messages API: what a CLI really
 * sends on a real session, request by request, and what each response cost —
 * including the per-message thinking tokens that Claude Code's own stream-json
 * does not report (its `result` carries one total per process).
 *
 * The CLI talks plain HTTP to 127.0.0.1 and the proxy forwards every request to
 * https://api.anthropic.com unchanged, streaming the SSE back while it reads the
 * usage out of it. The first path segment is a label naming the session
 * (`/claude-r1.p1/v1/messages`), so one proxy serves every arm of a bench run;
 * both CLIs keep a base URL's path when they build request URLs.
 *
 * THE CONFOUND (team memory `claude-code-beta-gap-2026-09-22`): a localhost
 * base URL makes Claude Code classify the session as not first-party, which
 * turns `safeguards` on and thinking-binding, the global cache scope, tool
 * search and `display:"updates"` off. `proxyEnv()` sets both CLIs' override
 * with the base URL, so a proxied session is the first-party session.
 *
 * Credentials never reach the log: only the headers in LOGGED_HEADERS are
 * written, and request bodies carry no token.
 *
 * Two debugging aids ride on the same path:
 *   - `transform` rewrites a /v1/messages body before it goes upstream (the
 *     session bench's `--proxy-display=summarized` asks for the thinking
 *     summary on both CLIs). The log keeps the body that was SENT, and the
 *     line says which rewrite produced it.
 *   - `replay()` sends a body upstream with the headers a CLI used on its
 *     first /v1/messages request through this proxy. Those headers carry the
 *     CLI's credential, so they live in memory only, like the forwarding does.
 * Every response's thinking text — non-empty only when the request asked for
 * `display: "summarized"` — lands beside its request.
 *
 * `requestKind(body)` tells, from a logged body alone, which part of the CLI
 * sent it: the agent loop, the auto-mode permission classifier, or a side
 * request. `summarize` counts requests by kind, and `readKindedRequests`
 * hands a session's requests to the session bench's census.
 *
 * Layout under the log dir, one directory per label:
 *   <label>/log.jsonl         one line per request (ProxyRecord)
 *   <label>/req-NNN.json.gz   the body of each /v1/messages request
 *   <label>/resp-NNN.thinking.txt  the response's thinking text, when it had any
 *
 * Usage:
 *   import { startWireProxy, proxyEnv, readProxyThinking, readKindedRequests } from './wire-proxy'
 *   bun scripts/bench/ab/wire-proxy.ts summarize <logDir>
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gunzipSync, gzipSync } from 'node:zlib'

const UPSTREAM_HOST = 'api.anthropic.com'
const LOGGED_HEADERS = ['anthropic-beta', 'anthropic-version', 'user-agent', 'x-app', 'content-type']
const LABEL_RE = /^\/([A-Za-z0-9_.@-]+)(\/.*)$/
const SSE_EVENT_SPLIT_RE = /\r?\n\r?\n/
const SSE_DATA_RE = /^data: ?(.*)$/m

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export type ProxyResponse = {
  id: string | null
  model: string | null
  stopReason: string | null
  usage: Json | null
  thinkingTokens: number | null
  /** Content blocks in order: `thinking`, `text`, `tool_use:<name>`, … */
  blocks: string[]
  /** Chars of thinking text returned (0 unless the request asked for a summary). */
  thinkingChars: number
}

export type ProxyRecord = {
  t: string
  label: string
  n: number
  method: string
  path: string
  status: number
  ms: number
  headers: Record<string, string>
  reqFile: string | null
  /** Which `transform` rewrote the body before it went upstream, if one did. */
  rewrite?: string
  /** Set on bodies sent by `replay()`: the label whose captured headers they used. */
  replayOf?: string
  response: ProxyResponse | null
}

/** Rewrites a /v1/messages body; null leaves it as the CLI sent it. */
export type BodyTransform = { name: string; apply(body: Json, label: string): Json | null }

export type WireProxyOptions = { port?: number; transform?: BodyTransform }

export type ReplayResult = { status: number; record: ProxyRecord; thinkingText: string }

export type WireProxy = {
  port: number
  logDir: string
  url(label: string): string
  /** Whether a CLI already sent a /v1/messages request under this label (its headers are held). */
  hasHeaders(label: string): boolean
  /** Sends `body` upstream with the headers `fromLabel` used, recording it under `asLabel`. */
  replay(fromLabel: string, asLabel: string, body: Json): Promise<ReplayResult>
  close(): Promise<void>
}

/** The environment that points a CLI at the proxy without leaving the first-party path. */
export function proxyEnv(url: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: url,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
  }
}

/** `thinking.display` set to `display` on every body that asks for thinking. */
export function thinkingDisplayTransform(display: string): BodyTransform {
  return {
    name: `display=${display}`,
    apply(body) {
      if (!isRecord(body.thinking) || body.thinking.type === 'disabled') return null
      return { ...body, thinking: { ...body.thinking, display } }
    },
  }
}

function loggedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of LOGGED_HEADERS) {
    const v = headers[name]
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Numeric fields merged by max, nested objects recursively — usage repeats across events. */
function mergeUsage(into: Json, next: Json): void {
  for (const [k, v] of Object.entries(next)) {
    // JSON.parse makes `__proto__` an own key, and `into[k]` would then read
    // and write the prototype — recursively, Object.prototype itself.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    if (typeof v === 'number') into[k] = Math.max(typeof into[k] === 'number' ? (into[k] as number) : 0, v)
    else if (isRecord(v)) {
      const inner = isRecord(into[k]) ? (into[k] as Json) : {}
      mergeUsage(inner, v)
      into[k] = inner
    } else if (v !== null && v !== undefined && into[k] === undefined) into[k] = v
  }
}

function thinkingOf(usage: Json | null): number | null {
  const details = usage && isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  return details && typeof details.thinking_tokens === 'number' ? details.thinking_tokens : null
}

/** Reads the message id, model, stop reason, usage, block order and thinking text out of an SSE stream or a JSON body. */
class ResponseReader {
  private buffer = ''
  private readonly response: ProxyResponse = {
    id: null,
    model: null,
    stopReason: null,
    usage: null,
    thinkingTokens: null,
    blocks: [],
    thinkingChars: 0,
  }
  private readonly chunks: Buffer[] = []
  thinkingText = ''

  constructor(private readonly sse: boolean) {}

  push(chunk: Buffer): void {
    if (!this.sse) {
      this.chunks.push(chunk)
      return
    }
    this.buffer += chunk.toString('utf8')
    const events = this.buffer.split(SSE_EVENT_SPLIT_RE)
    this.buffer = events.pop() ?? ''
    for (const event of events) this.event(event)
  }

  private event(text: string): void {
    const data = SSE_DATA_RE.exec(text)?.[1]
    if (!data) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    if (parsed.type === 'message_start' && isRecord(parsed.message)) this.message(parsed.message)
    if (parsed.type === 'content_block_start' && isRecord(parsed.content_block)) this.block(parsed.content_block)
    if (parsed.type === 'content_block_delta' && isRecord(parsed.delta) && parsed.delta.type === 'thinking_delta') {
      if (typeof parsed.delta.thinking === 'string') this.thinkingText += parsed.delta.thinking
    }
    if (parsed.type === 'message_delta') {
      if (isRecord(parsed.delta) && typeof parsed.delta.stop_reason === 'string') this.response.stopReason = parsed.delta.stop_reason
      if (isRecord(parsed.usage)) this.usage(parsed.usage)
    }
  }

  private message(m: Json): void {
    if (typeof m.id === 'string') this.response.id = m.id
    if (typeof m.model === 'string') this.response.model = m.model
    if (typeof m.stop_reason === 'string') this.response.stopReason = m.stop_reason
    if (isRecord(m.usage)) this.usage(m.usage)
  }

  private block(b: Json): void {
    const kind = String(b.type ?? '?')
    if (kind === 'thinking' && this.response.blocks.length > 0 && this.thinkingText && !this.thinkingText.endsWith('\n')) {
      this.thinkingText += '\n\n'
    }
    this.response.blocks.push(kind === 'tool_use' || kind === 'server_tool_use' ? `${kind}:${String(b.name ?? '?')}` : kind)
    if (kind === 'thinking' && typeof b.thinking === 'string') this.thinkingText += b.thinking
  }

  private usage(u: Json): void {
    this.response.usage ??= {}
    mergeUsage(this.response.usage, u)
  }

  result(): ProxyResponse | null {
    if (this.sse) {
      if (this.buffer.trim()) this.event(this.buffer)
    } else {
      try {
        const body = JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
        if (isRecord(body) && body.type === 'message') {
          this.message(body)
          for (const b of Array.isArray(body.content) ? body.content : []) if (isRecord(b)) this.block(b)
        }
      } catch {
        // not JSON: nothing to record beyond the status
      }
    }
    if (!this.response.id && !this.response.usage) return null
    this.response.thinkingTokens = thinkingOf(this.response.usage)
    this.response.thinkingChars = this.thinkingText.length
    return this.response
  }
}

/** Headers for the upstream request: the CLI's own, retargeted, with identity encoding so the bytes read are the bytes parsed. */
function upstreamHeaders(from: IncomingHttpHeaders, length: number): IncomingHttpHeaders {
  return { ...from, host: UPSTREAM_HOST, 'accept-encoding': 'identity', 'content-length': String(length) }
}

/** A request the model answers: /v1/messages, not its count_tokens sibling. */
function isMessagesPath(path: string): boolean {
  return path.startsWith('/v1/messages') && !path.includes('count_tokens')
}

export function startWireProxy(logDir: string, options: WireProxyOptions = {}): Promise<WireProxy> {
  mkdirSync(logDir, { recursive: true })
  const counters = new Map<string, number>()
  /** The first /v1/messages headers per label — credentials included, so memory only. */
  const captured = new Map<string, IncomingHttpHeaders>()

  const nextSlot = (label: string): { n: number; dir: string } => {
    const n = (counters.get(label) ?? 0) + 1
    counters.set(label, n)
    const dir = join(logDir, label)
    mkdirSync(dir, { recursive: true })
    return { n, dir }
  }
  const writeThinking = (dir: string, n: number, text: string): void => {
    if (text) writeFileSync(join(dir, `resp-${String(n).padStart(3, '0')}.thinking.txt`), text)
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const started = performance.now()
    const t = new Date().toISOString()
    const match = LABEL_RE.exec(req.url ?? '')
    const label = match?.[1] ?? '_unlabeled'
    const path = match?.[2] ?? req.url ?? '/'
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body = Buffer.concat(chunks)
      const { n, dir } = nextSlot(label)
      const isMessages = isMessagesPath(path)
      let rewrite: string | undefined
      if (isMessages && body.length > 0) {
        if (!captured.has(label)) captured.set(label, { ...req.headers })
        if (options.transform) {
          try {
            const rewritten = options.transform.apply(JSON.parse(body.toString('utf8')) as Json, label)
            if (rewritten) {
              body = Buffer.from(JSON.stringify(rewritten))
              rewrite = options.transform.name
            }
          } catch {
            // not JSON: forwarded untouched
          }
        }
      }
      let reqFile: string | null = null
      if (body.length > 0 && path.startsWith('/v1/messages')) {
        reqFile = `req-${String(n).padStart(3, '0')}.json.gz`
        writeFileSync(join(dir, reqFile), gzipSync(body))
      }
      const record = (status: number, reader: ResponseReader | null): void => {
        const response = reader?.result() ?? null
        if (reader) writeThinking(dir, n, reader.thinkingText)
        const line: ProxyRecord = {
          t,
          label,
          n,
          method: req.method ?? 'GET',
          path,
          status,
          ms: Math.round(performance.now() - started),
          headers: loggedHeaders(req.headers),
          reqFile,
          ...(rewrite ? { rewrite } : {}),
          response,
        }
        appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`)
      }
      const upstream = httpsRequest(
        { host: UPSTREAM_HOST, port: 443, method: req.method, path, headers: upstreamHeaders(req.headers, body.length) },
        up => {
        const status = up.statusCode ?? 502
        res.writeHead(status, up.headers)
        const reader = new ResponseReader(String(up.headers['content-type'] ?? '').includes('text/event-stream'))
        up.on('data', (c: Buffer) => {
          res.write(c)
          reader.push(c)
        })
        up.on('end', () => {
          res.end()
            record(status, reader)
        })
        up.on('error', e => {
          res.destroy(e)
            record(status, reader)
        })
        },
      )
      upstream.on('error', e => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`wire-proxy: upstream error: ${String(e)}`)
        record(502, null)
      })
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy()
      })
      upstream.end(body)
    })
  }

  const replay = (fromLabel: string, asLabel: string, body: Json): Promise<ReplayResult> => {
    const from = captured.get(fromLabel)
    if (!from) return Promise.reject(new Error(`wire-proxy: no /v1/messages request seen under ${fromLabel} yet`))
    const payload = Buffer.from(JSON.stringify({ ...body, stream: true }))
    const { n, dir } = nextSlot(asLabel)
    const reqFile = `req-${String(n).padStart(3, '0')}.json.gz`
    writeFileSync(join(dir, reqFile), gzipSync(payload))
    const started = performance.now()
    const t = new Date().toISOString()
    const path = '/v1/messages?beta=true'
    return new Promise((resolve, reject) => {
      const upstream = httpsRequest(
        { host: UPSTREAM_HOST, port: 443, method: 'POST', path, headers: upstreamHeaders(from, payload.length) },
        up => {
          const status = up.statusCode ?? 502
          const reader = new ResponseReader(String(up.headers['content-type'] ?? '').includes('text/event-stream'))
          const errorBody: Buffer[] = []
          up.on('data', (c: Buffer) => {
            reader.push(c)
            if (status >= 400) errorBody.push(c)
          })
          up.on('end', () => {
            writeThinking(dir, n, reader.thinkingText)
            const record: ProxyRecord = {
              t,
              label: asLabel,
              n,
              method: 'POST',
              path,
              status,
              ms: Math.round(performance.now() - started),
              headers: loggedHeaders(from),
              reqFile,
              replayOf: fromLabel,
              response: reader.result(),
            }
            appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(record)}\n`)
            if (status >= 400) reject(new Error(`wire-proxy: replay got ${status}: ${Buffer.concat(errorBody).toString('utf8').slice(0, 300)}`))
            else resolve({ status, record, thinkingText: reader.thinkingText })
          })
          up.on('error', reject)
        },
      )
      upstream.on('error', reject)
      upstream.end(payload)
    })
  }

  return new Promise(resolve => {
    const server = createServer(handle)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        port: bound,
        logDir,
        url: (label: string) => `http://127.0.0.1:${bound}/${label}`,
        hasHeaders: (label: string) => captured.has(label),
        replay,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

export function readProxyRecords(logDir: string, label: string): ProxyRecord[] {
  const file = join(logDir, label, 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ProxyRecord)
}

/** Thinking tokens per response message id, for the labels given. */
export function readProxyThinking(logDir: string, labels: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const label of labels) {
    for (const r of readProxyRecords(logDir, label)) {
      if (r.response?.id && r.response.thinkingTokens !== null) out.set(r.response.id, r.response.thinkingTokens)
    }
  }
  return out
}

function readBody(logDir: string, label: string, reqFile: string): Json {
  return JSON.parse(gunzipSync(readFileSync(join(logDir, label, reqFile))).toString('utf8')) as Json
}

// ---------------------------------------------------------------------------
// requestKind — which part of the CLI sent a request, read off its body
// ---------------------------------------------------------------------------

/**
 * `main`: an agent-loop turn — the main thread, or a sub-agent it spawned; the
 * conversation whose tool calls reach the permission check. `classifier`: the
 * auto-mode permission classifier, one request per stage. `other`: every side
 * request — titles and tool-use summaries, the forks that append a prompt to
 * the main thread's prefix, keep-alive pings, token counts.
 */
export type RequestKind = 'main' | 'classifier' | 'other'

// The auto-mode classifier (src/permissions/yoloClassifier/classify.ts). On the
// XML path, the one an Opus 5.x session always takes, every stage wraps the
// transcript and the action in <transcript> blocks and appends its own
// instruction after them, and stage 1 stops at </block>; the tool_use path
// forces its one tool instead. Its system block opens the same on both paths
// (the attribution header, when there is one, is a block of its own).
const CLASSIFIER_TOOL = 'classify_result'
const CLASSIFIER_STOP = '</block>'
const TRANSCRIPT_OPEN = '<transcript>\n'
const TRANSCRIPT_CLOSE = '</transcript>\n'
const CLASSIFIER_IDENTITY = 'You are a security classifier for an autonomous coding agent'

/**
 * How each fork's prompt opens. A fork (runForkedAgent) re-sends the main
 * thread's system prompt, tools and messages, to read the same cache, and
 * appends one user message: that message is all that tells it apart, on its
 * first request and on every later one of its loop.
 */
const FORK_PROMPTS: readonly string[] = [
  'You are now acting as the memory extraction subagent', // src/memory/extract/prompts.ts
  'IMPORTANT: This message and these instructions are NOT part of the actual user conversation', // src/memory/session/prompts.ts
  '# Dream: Memory Consolidation', // src/memory/autoDream/consolidationPrompt.ts
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.', // src/agent/compact/prompt.ts
  'Describe your most recent action in 3-5 words', // src/agent/summary/agentSummary.ts, progress
  'Produce a concise, actionable summary of your final result above', // same file, a sub-agent's result
  '<system-reminder>This is a side question from the user.', // src/agent/sideQuestion.ts
  '[SUGGESTION MODE:', // src/terminal/prompt-suggestion/promptSuggestion.ts
]

const textOf = (block: unknown): string => (isRecord(block) && typeof block.text === 'string' ? block.text : '')

/** A system prompt or a message's content as blocks, a plain string counting as one. */
function contentBlocks(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function messagesOf(body: Json): Json[] {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function lastUserBlocks(body: Json): Json[] {
  const last = messagesOf(body).at(-1)
  return last?.role === 'user' ? contentBlocks(last.content) : []
}

function isClassifierRequest(body: Json): boolean {
  if (isRecord(body.tool_choice) && body.tool_choice.name === CLASSIFIER_TOOL) return true
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.includes(CLASSIFIER_STOP)) return true
  const blocks = lastUserBlocks(body)
  if (textOf(blocks[0]) === TRANSCRIPT_OPEN && blocks.some(b => textOf(b) === TRANSCRIPT_CLOSE)) return true
  return contentBlocks(body.system).some(b => textOf(b).startsWith(CLASSIFIER_IDENTITY))
}

function hasForkPrompt(body: Json): boolean {
  return messagesOf(body).some(
    m =>
      m.role === 'user' &&
      contentBlocks(m.content).some(b => {
        const text = textOf(b).trimStart()
        return FORK_PROMPTS.some(prompt => text.startsWith(prompt))
      }),
  )
}

export function requestKind(body: Json): RequestKind {
  if (isClassifierRequest(body)) return 'classifier'
  // The agent loop sends its whole tool pool on every request, deferred tools
  // included, and lets the model choose. A side query sends no tool or the
  // one it forces, a count_tokens body has no max_tokens, and a keep-alive
  // ping asks for a single token.
  const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : []
  const forced = isRecord(body.tool_choice) && body.tool_choice.type === 'tool'
  const generates = typeof body.max_tokens === 'number' && body.max_tokens > 1
  return tools.length > 1 && !forced && generates && !hasForkPrompt(body) ? 'main' : 'other'
}

/**
 * What a classifier request judged: the action — the last block inside the
 * transcript on the XML path, the last block on the tool_use path — and a key
 * for the judgment, shared by its stages: they send the same transcript and
 * action, and differ only in the instruction after them.
 */
function judgmentOf(body: Json): { action: string; judgment: string } | null {
  const blocks = lastUserBlocks(body)
  const close = blocks.findLastIndex(b => textOf(b) === TRANSCRIPT_CLOSE)
  const judged = close >= 0 ? blocks.slice(0, close) : blocks
  const action = textOf(judged.at(-1))
  if (!action) return null
  return { action, judgment: createHash('sha256').update(JSON.stringify(judged)).digest('hex') }
}

/** An answered request, with what the session bench's census needs of it. */
export type KindedRequest = {
  n: number
  kind: RequestKind
  /** The response's model, or the body's when the response carried none. */
  model: string
  usage: Json | null
  /** Classifier requests only: the action judged, and the judgment its stages share. */
  action?: string
  judgment?: string
}

/** The answered /v1/messages requests of one label, in the order they were sent. */
export function readKindedRequests(logDir: string, label: string): KindedRequest[] {
  return readProxyRecords(logDir, label)
    .filter(r => r.reqFile && r.status < 400 && isMessagesPath(r.path))
    .sort((a, b) => a.n - b.n)
    .map(r => {
      const body = readBody(logDir, label, r.reqFile!)
      const kind = requestKind(body)
      return {
        n: r.n,
        kind,
        model: r.response?.model ?? String(body.model ?? ''),
        usage: r.response?.usage ?? null,
        ...(kind === 'classifier' ? (judgmentOf(body) ?? {}) : {}),
      }
    })
}

// ---------------------------------------------------------------------------
// summarize — what each session sent, request by request
// ---------------------------------------------------------------------------

function effortsIn(body: Json): string[] {
  const out: string[] = []
  if (isRecord(body.output_config) && typeof body.output_config.effort === 'string') out.push(`top:${body.output_config.effort}`)
  const messages = Array.isArray(body.messages) ? body.messages : []
  messages.forEach((m, i) => {
    if (isRecord(m) && isRecord(m.output_config) && typeof m.output_config.effort === 'string') {
      out.push(`msg${i}:${m.output_config.effort}`)
    }
  })
  return out
}

function summarize(logDir: string): void {
  const labels = readdirSync(logDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
  for (const label of labels) {
    const records = readProxyRecords(logDir, label)
    const messages = records.filter(r => r.path.startsWith('/v1/messages') && r.reqFile)
    const configs = new Map<string, number>()
    const betas = new Set<string>()
    const tools = new Map<string, number>()
    const kinds: Record<RequestKind, number> = { main: 0, classifier: 0, other: 0 }
    let thinking = 0
    let output = 0
    let withTools = 0
    let summarized = 0
    const rewrites = new Set<string>()
    for (const r of messages) {
      for (const b of (r.headers['anthropic-beta'] ?? '').split(',')) if (b.trim()) betas.add(b.trim())
      if (r.rewrite) rewrites.add(r.rewrite)
      if ((r.response?.thinkingChars ?? 0) > 0) summarized++
      const body = readBody(logDir, label, r.reqFile!)
      kinds[requestKind(body)]++
      const toolList = Array.isArray(body.tools) ? body.tools.filter(isRecord) : []
      if (toolList.length) withTools++
      const eager = toolList.filter(x => !x.defer_loading).map(x => String(x.name))
      const key = [
        `model=${String(body.model)}`,
        `thinking=${JSON.stringify(body.thinking ?? null)}`,
        `effort=${effortsIn(body).join('+') || 'none'}`,
        `max_tokens=${String(body.max_tokens)}`,
        `tools=${toolList.length}(eager ${eager.length})`,
      ].join(' ')
      configs.set(key, (configs.get(key) ?? 0) + 1)
      for (const name of eager) tools.set(name, (tools.get(name) ?? 0) + 1)
      thinking += r.response?.thinkingTokens ?? 0
      output += typeof r.response?.usage?.output_tokens === 'number' ? (r.response.usage.output_tokens as number) : 0
    }
    console.log(`\n## ${label}: ${messages.length} /v1/messages (${withTools} with tools), output ${output}, thinking ${thinking}`)
    console.log(`  by kind: ${kinds.main} agent loop, ${kinds.classifier} auto-mode classifier, ${kinds.other} other`)
    for (const [k, n] of configs) console.log(`  ${n}× ${k}`)
    if (rewrites.size) console.log(`  rewritten by the proxy: ${[...rewrites].join(', ')}; ${summarized} responses carried thinking text`)
    console.log(`  betas: ${[...betas].sort().join(', ') || 'none'}`)
    console.log(`  eager tools: ${[...tools.keys()].sort().join(', ') || 'none'}`)
    const other = records.filter(r => !r.path.startsWith('/v1/messages'))
    if (other.length) console.log(`  other paths: ${[...new Set(other.map(r => `${r.method} ${r.path.split('?')[0]} ${r.status}`))].join('; ')}`)
    const failed = records.filter(r => r.status >= 400)
    if (failed.length) console.log(`  non-2xx: ${failed.map(r => `#${r.n} ${r.status} ${r.path.split('?')[0]}`).join('; ')}`)
  }
}

if (import.meta.main) {
  const [mode, dir] = process.argv.slice(2)
  if (mode !== 'summarize' || !dir) {
    console.error('usage: bun scripts/bench/ab/wire-proxy.ts summarize <logDir>')
    process.exit(2)
  }
  summarize(dir)
}
