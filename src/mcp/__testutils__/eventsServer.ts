/**
 * A 2026-07-28 server that publishes MCP events (SEP-3415). The SDK has no
 * server runtime for the extension either, so `events/*` are answered raw,
 * through serveModern's `answer` hook, before the SDK server sees them:
 * `events/list` and `events/poll` as JSON (without `resultType`, which the
 * client's wire rules fill), `events/stream` as an SSE response the test
 * pushes notifications into.
 */
import { MCP_EVENTS_EXTENSION } from 'src/mcp/client/events.js'
import { type Hit, type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'

export type EventsNotificationKind = 'active' | 'event' | 'heartbeat' | 'error' | 'terminated'

export type EventStream = {
  id: string | number
  params: Record<string, unknown>
  /** Sends `notifications/events/<kind>` tagged with this stream's subscription id. */
  send(kind: EventsNotificationKind, params?: Record<string, unknown>): void
  /** Ends the stream with its JSON-RPC result. */
  end(): void
  /** Cuts the stream with no result, as a dropped connection would. */
  drop(): void
  /** True once the client closed it. */
  cancelled(): boolean
}

export type EventsFixture = ModernFixture & {
  streams: EventStream[]
  polls: Array<Record<string, unknown>>
  /** The events/* POSTs, in order. */
  eventHits: () => Hit[]
}

export type EventsServerSpec = {
  types: unknown[]
  /** false: the server does not declare the extension. */
  extension?: boolean
  /** Answers the n-th (1-based) events/poll. */
  poll?: (params: Record<string, unknown>, n: number) => Record<string, unknown>
  onStream?: (stream: EventStream) => void
}

const encoder = new TextEncoder()

export function serveEvents(spec: EventsServerSpec): EventsFixture {
  const streams: EventStream[] = []
  const polls: Array<Record<string, unknown>> = []
  const reply = (id: unknown, result: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id, result })

  function openStream(id: string | number, params: Record<string, unknown>): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let open = true
    let cancelled = false
    const write = (message: Record<string, unknown>) => {
      if (open) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`))
    }
    const close = () => {
      if (!open) return
      open = false
      controller.close()
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        open = false
        cancelled = true
      },
    })
    const stream: EventStream = {
      id,
      params,
      send(kind, notification = {}) {
        write({
          jsonrpc: '2.0',
          method: `notifications/events/${kind}`,
          params: { ...notification, _meta: { 'io.modelcontextprotocol/subscriptionId': id } },
        })
      },
      end() {
        write({ jsonrpc: '2.0', id, result: {} })
        close()
      },
      drop: close,
      cancelled: () => cancelled,
    }
    streams.push(stream)
    spec.onStream?.(stream)
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }

  const fixture = serveModern(
    server => {
      if (spec.extension !== false) {
        server.server.registerCapabilities({ extensions: { [MCP_EVENTS_EXTENSION]: {} } })
      }
    },
    {
      answer: body => {
        const params = (body?.params ?? {}) as Record<string, unknown>
        switch (body?.method) {
          case 'events/list':
            return reply(body.id, { events: spec.types })
          case 'events/poll':
            polls.push(params)
            return reply(body.id, spec.poll?.(params, polls.length) ?? { events: [], cursor: null })
          case 'events/stream':
            return openStream(body.id as string | number, params)
          default:
            return undefined
        }
      },
    },
  )
  const stop = fixture.stop
  return Object.assign(fixture, {
    streams,
    polls,
    eventHits: () => fixture.hits.filter(hit => String(hit.body?.method ?? '').startsWith('events/')),
    stop: async () => {
      for (const stream of streams) stream.drop()
      await stop()
    },
  })
}
