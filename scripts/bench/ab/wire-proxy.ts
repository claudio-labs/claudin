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
 * Layout under the log dir, one directory per label:
 *   <label>/log.jsonl         one line per request (ProxyRecord)
 *   <label>/req-NNN.json.gz   the body of each /v1/messages request
 *
 * Usage:
 *   import { startWireProxy, proxyEnv, readProxyThinking } from './wire-proxy'
 *   bun scripts/bench/ab/wire-proxy.ts summarize <logDir>
 */
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
  response: ProxyResponse | null
}

export type WireProxy = {
  port: number
  logDir: string
  url(label: string): string
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

/** Reads the message id, model, stop reason and usage out of an SSE stream or a JSON body. */
class ResponseReader {
  private buffer = ''
  private readonly response: ProxyResponse = { id: null, model: null, stopReason: null, usage: null, thinkingTokens: null }
  private readonly chunks: Buffer[] = []

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
        if (isRecord(body) && body.type === 'message') this.message(body)
      } catch {
        // not JSON: nothing to record beyond the status
      }
    }
    if (!this.response.id && !this.response.usage) return null
    this.response.thinkingTokens = thinkingOf(this.response.usage)
    return this.response
  }
}

export function startWireProxy(logDir: string, port = 0): Promise<WireProxy> {
  mkdirSync(logDir, { recursive: true })
  const counters = new Map<string, number>()

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const started = performance.now()
    const t = new Date().toISOString()
    const match = LABEL_RE.exec(req.url ?? '')
    const label = match?.[1] ?? '_unlabeled'
    const path = match?.[2] ?? req.url ?? '/'
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const n = (counters.get(label) ?? 0) + 1
      counters.set(label, n)
      const dir = join(logDir, label)
      mkdirSync(dir, { recursive: true })
      let reqFile: string | null = null
      if (body.length > 0 && path.startsWith('/v1/messages')) {
        reqFile = `req-${String(n).padStart(3, '0')}.json.gz`
        writeFileSync(join(dir, reqFile), gzipSync(body))
      }
      const record = (status: number, response: ProxyResponse | null): void => {
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
          response,
        }
        appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(line)}\n`)
      }
      // Identity encoding upstream, so the bytes piped back are the bytes parsed here.
      const headers: IncomingHttpHeaders = { ...req.headers, host: UPSTREAM_HOST, 'accept-encoding': 'identity' }
      headers['content-length'] = String(body.length)
      const upstream = httpsRequest({ host: UPSTREAM_HOST, port: 443, method: req.method, path, headers }, up => {
        const status = up.statusCode ?? 502
        res.writeHead(status, up.headers)
        const reader = new ResponseReader(String(up.headers['content-type'] ?? '').includes('text/event-stream'))
        up.on('data', (c: Buffer) => {
          res.write(c)
          reader.push(c)
        })
        up.on('end', () => {
          res.end()
          record(status, reader.result())
        })
        up.on('error', e => {
          res.destroy(e)
          record(status, reader.result())
        })
      })
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

  return new Promise(resolve => {
    const server = createServer(handle)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : port
      resolve({
        port: bound,
        logDir,
        url: (label: string) => `http://127.0.0.1:${bound}/${label}`,
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
    let thinking = 0
    let output = 0
    let withTools = 0
    for (const r of messages) {
      for (const b of (r.headers['anthropic-beta'] ?? '').split(',')) if (b.trim()) betas.add(b.trim())
      const body = JSON.parse(gunzipSync(readFileSync(join(logDir, label, r.reqFile!))).toString('utf8')) as Json
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
    for (const [k, n] of configs) console.log(`  ${n}× ${k}`)
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
