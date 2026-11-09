import { describe, expect, test } from 'bun:test'
import type { WebSocketHandle, WebSocketHandlers, WebSocketOpenOptions } from 'src/providers/transport/webSocket.js'
import {
  createWebSocketCommand,
  WS_MAX_FRAME_BYTES,
  wsInputError,
  wsTargetRefusal,
} from 'src/tools/MonitorTool/webSocketCommand.js'

describe('wsInputError', () => {
  test('accepts ws:// and wss:// URLs with valid subprotocols', () => {
    expect(wsInputError({ url: 'wss://events.example.com/stream' })).toBeNull()
    expect(wsInputError({ url: 'ws://127.0.0.1:8080/feed', protocols: ['v1', 'graphql-ws'] })).toBeNull()
  })

  test('refuses other schemes, whitespace, control and non-ASCII characters', () => {
    expect(wsInputError({ url: 'https://example.com' })).toContain('ws:// or wss://')
    expect(wsInputError({ url: 'wss://example.com/a b' })).toContain('printable ASCII')
    expect(wsInputError({ url: 'wss://example.com/\u0007' })).toContain('printable ASCII')
    expect(wsInputError({ url: 'wss://exämple.com' })).toContain('printable ASCII')
  })

  test('refuses an unparsable URL and one that carries credentials', () => {
    expect(wsInputError({ url: 'wss://[::1' })).toContain('not a valid URL')
    expect(wsInputError({ url: 'wss://user:secret@example.com' })).toContain('credentials')
    expect(wsInputError({ url: 'wss://token@example.com' })).toContain('credentials')
  })

  test('refuses a subprotocol that is not a token, and a repeated one', () => {
    expect(wsInputError({ url: 'wss://example.com', protocols: ['v 1'] })).toContain('"v 1"')
    expect(wsInputError({ url: 'wss://example.com', protocols: ['a,b'] })).toContain('"a,b"')
    expect(wsInputError({ url: 'wss://example.com', protocols: ['v1', 'v1'] })).toContain('twice')
  })
})

describe('wsTargetRefusal', () => {
  const never = async (): Promise<string[]> => {
    throw new Error('must not resolve an IP literal')
  }

  test('refuses a private, link-local or metadata literal without resolving it', async () => {
    expect(await wsTargetRefusal('ws://10.0.0.7/x', never)).toBe('10.0.0.7 is in a private, link-local or cloud-metadata range')
    expect(await wsTargetRefusal('ws://169.254.169.254/latest', never)).toContain('169.254.169.254 is in')
    expect(await wsTargetRefusal('ws://[fe80::1]/x', never)).toContain('fe80::1 is in')
  })

  test('allows loopback and public literals', async () => {
    expect(await wsTargetRefusal('ws://127.0.0.1:9000/x', never)).toBeNull()
    expect(await wsTargetRefusal('ws://[::1]:9000/x', never)).toBeNull()
    expect(await wsTargetRefusal('wss://8.8.8.8/x', never)).toBeNull()
  })

  test('refuses a name when any of its addresses is blocked', async () => {
    const resolve = async (host: string) => (host === 'mixed.example' ? ['93.184.216.34', '192.168.1.5'] : ['93.184.216.34'])
    expect(await wsTargetRefusal('wss://mixed.example/feed', resolve)).toBe(
      'mixed.example resolves to 192.168.1.5, which is in a private, link-local or cloud-metadata range',
    )
    expect(await wsTargetRefusal('wss://public.example/feed', resolve)).toBeNull()
  })

  test('says so when the name does not resolve', async () => {
    expect(await wsTargetRefusal('wss://gone.example', async () => [])).toBe('could not resolve gone.example')
    const failing = async () => {
      throw new Error('ENOTFOUND gone.example')
    }
    expect(await wsTargetRefusal('wss://gone.example', failing)).toBe('could not resolve gone.example: ENOTFOUND gone.example')
  })
})

type FakeSocket = {
  url: string
  options: WebSocketOpenOptions
  handlers: WebSocketHandlers
  closed: Array<{ code?: number; reason?: string }>
  detached: number
}

function harness(ws: { url: string; protocols?: string[] } = { url: 'wss://events.example.com/stream' }) {
  const lines: string[] = []
  let flushes = 0
  let socket: FakeSocket | undefined
  const command = createWebSocketCommand(ws, {
    open: (url, options = {}) => {
      const fake: FakeSocket = { url, options, handlers: options.handlers ?? {}, closed: [], detached: 0 }
      socket = fake
      return {
        url,
        readyState: 1,
        listen: h => {
          fake.handlers = h
        },
        send: async () => {},
        ping: () => {},
        close: (code, reason) => {
          fake.closed.push({ code, reason })
        },
        detach: () => {
          fake.detached++
        },
      } satisfies WebSocketHandle
    },
    append: (_taskId, text) => {
      lines.push(text)
    },
    flush: async () => {
      flushes++
    },
  })
  return { command, lines, socket: () => socket!, flushes: () => flushes }
}

describe('createWebSocketCommand', () => {
  test('opens the URL, offering subprotocols only when there are some', () => {
    const plain = harness()
    expect(plain.socket().url).toBe('wss://events.example.com/stream')
    expect(plain.socket().options.protocols).toBeUndefined()
    expect(harness({ url: 'wss://x.example', protocols: [] }).socket().options.protocols).toBeUndefined()
    expect(harness({ url: 'wss://x.example', protocols: ['v1'] }).socket().options.protocols).toEqual(['v1'])
  })

  test('writes each text frame as a line, and a frame that ends in a newline as is', () => {
    const h = harness()
    h.socket().handlers.onMessage?.('deploy started', false)
    h.socket().handlers.onMessage?.('step 1\nstep 2\n', false)
    expect(h.lines).toEqual(['deploy started\n', 'step 1\nstep 2\n'])
  })

  test('names a binary frame by its size instead of passing it through', () => {
    const h = harness()
    h.socket().handlers.onMessage?.('\u0000\u0001\u0002', true)
    expect(h.lines).toEqual(['[binary frame, 3 bytes]\n'])
  })

  test('drops a frame over the cap and closes the socket', () => {
    const h = harness()
    h.socket().handlers.onMessage?.('x'.repeat(WS_MAX_FRAME_BYTES + 1), false)
    expect(h.lines).toEqual([`[Dropped a ${WS_MAX_FRAME_BYTES + 1}-byte frame (over ${WS_MAX_FRAME_BYTES} bytes); closing]\n`])
    expect(h.socket().closed).toEqual([{ code: 1009, reason: 'frame too large' }])
  })

  test('a normal close is the last line and ends the command with exit 0, after the flush', async () => {
    const h = harness()
    h.socket().handlers.onMessage?.('one', false)
    h.socket().handlers.onClose?.(1000, 'done')
    const result = await h.command.result
    expect(h.lines).toEqual(['one\n', '[WebSocket closed: 1000 done]\n'])
    expect(result).toMatchObject({ code: 0, interrupted: false })
    expect(h.flushes()).toBe(1)
    expect(h.command.status).toBe('completed')
  })

  test('an abnormal close or a refused upgrade ends it with exit 1', async () => {
    const abnormal = harness()
    abnormal.socket().handlers.onClose?.(1006, '')
    expect((await abnormal.command.result).code).toBe(1)
    expect(abnormal.lines).toEqual(['[WebSocket closed: 1006]\n'])

    const refused = harness()
    refused.socket().handlers.onRefused?.(403, 'Forbidden')
    refused.socket().handlers.onError?.(new Error('Unexpected server response: 403'))
    refused.socket().handlers.onClose?.(1000, '')
    expect((await refused.command.result).code).toBe(1)
    // The error a refusal also raises is not repeated.
    expect(refused.lines).toEqual(['[WebSocket upgrade rejected: HTTP 403]\n', '[WebSocket closed: 1000]\n'])
  })

  test('an error is written as a line', () => {
    const h = harness()
    h.socket().handlers.onError?.(new Error('ECONNRESET'))
    expect(h.lines).toEqual(['[WebSocket error: ECONNRESET]\n'])
  })

  test('kill closes the socket and settles at once, as killed', async () => {
    const h = harness()
    h.command.kill()
    h.command.cleanup()
    const result = await h.command.result
    expect(result).toMatchObject({ code: 143, interrupted: true })
    expect(h.command.status).toBe('killed')
    expect(h.socket().closed).toEqual([{ code: 1000, reason: 'monitor stopped' }])
    expect(h.socket().detached).toBe(1)
    // A close event after the kill changes nothing.
    h.socket().handlers.onClose?.(1000, 'monitor stopped')
    expect(h.flushes()).toBe(1)
  })

  test('kill after the socket closed on its own is a no-op', async () => {
    const h = harness()
    h.socket().handlers.onClose?.(1000, '')
    await h.command.result
    h.command.kill()
    expect(h.socket().closed).toEqual([])
    expect(h.command.status).toBe('completed')
  })

  test('background marks a running command backgrounded', () => {
    const h = harness()
    expect(h.command.background('ignored')).toBe(true)
    expect(h.command.status).toBe('backgrounded')
    expect(h.command.taskOutput.taskId).toMatch(/^b/)
  })
})
