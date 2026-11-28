/**
 * Replays HTTP cassettes recorded against real providers, from a local server.
 *
 * The cassettes under src/providers/__fixtures__/cassettes/ were recorded by
 * opencode's http-recorder (see the README there). A server, rather than a
 * stubbed fetch, because the three wires reach the network three ways: the
 * OpenAI shim calls fetch, the Anthropic SDK takes a `baseURL`, and the AWS
 * SDK takes an `endpoint` and its own HTTP handler, which no fetch stub sees.
 *
 * Routing is by method and path, in recorded order: the Nth request to a path
 * gets the Nth interaction recorded for it. The recorded host is dropped, so a
 * client pointed at `${server.url}/anthropic` reaches the interactions recorded
 * at `https://api.minimax.io/anthropic/v1/messages`. A request no interaction
 * is left for gets a 599 and is kept in `unmatched`.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

export const CASSETTE_DIR = join(import.meta.dir, '..', '__fixtures__', 'cassettes')

export type CassetteInteraction = {
  request: { method: string; url: string; headers?: Record<string, string>; body?: string }
  response: {
    status: number
    headers?: Record<string, string>
    body?: string
    bodyEncoding?: 'base64'
  }
}

export type Cassette = {
  version: number
  metadata?: Record<string, unknown>
  interactions: CassetteInteraction[]
}

/** One request the server received. `json` is the parsed body when it parses. */
export type CassetteCapture = {
  method: string
  path: string
  search: string
  headers: IncomingHttpHeaders
  body: string
  json: unknown
}

export type CassetteServer = {
  url: string
  captures: CassetteCapture[]
  unmatched: CassetteCapture[]
  close: () => Promise<void>
}

/** `name` is relative to the cassette dir, without `.json`: `minimax-messages/m3-streams-adaptive-thinking`. */
export function loadCassette(name: string): Cassette {
  return JSON.parse(readFileSync(join(CASSETTE_DIR, `${name}.json`), 'utf8')) as Cassette
}

/** The recorded request body of interaction `index`, parsed. */
export function recordedRequestBody(cassette: Cassette, index = 0): Record<string, unknown> {
  const body = cassette.interactions[index]?.request.body
  return body ? (JSON.parse(body) as Record<string, unknown>) : {}
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${decodeURIComponent(path)}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function startCassetteServer(cassettes: Cassette[]): Promise<CassetteServer> {
  const queues = new Map<string, CassetteInteraction[]>()
  for (const cassette of cassettes) {
    for (const interaction of cassette.interactions) {
      const url = new URL(interaction.request.url)
      const key = routeKey(interaction.request.method, url.pathname)
      const queue = queues.get(key) ?? []
      queue.push(interaction)
      queues.set(key, queue)
    }
  }

  const captures: CassetteCapture[] = []
  const unmatched: CassetteCapture[] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://cassette.local')
      const body = Buffer.concat(chunks).toString('utf8')
      const capture: CassetteCapture = {
        method: req.method ?? 'GET',
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        body,
        json: parseJson(body),
      }
      captures.push(capture)
      const interaction = queues.get(routeKey(capture.method, capture.path))?.shift()
      if (!interaction) {
        unmatched.push(capture)
        res.writeHead(599, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `no cassette interaction for ${capture.method} ${capture.path}` }))
        return
      }
      const { response } = interaction
      const payload =
        response.bodyEncoding === 'base64'
          ? Buffer.from(response.body ?? '', 'base64')
          : Buffer.from(response.body ?? '', 'utf8')
      res.writeHead(response.status, { ...response.headers, 'content-length': String(payload.length) })
      res.end(payload)
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    captures,
    unmatched,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
