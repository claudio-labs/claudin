import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import {
  _setCodexSocketTransportForTesting,
  codexSocketEligible,
  codexSocketHeaders,
  codexSocketUrl,
  isCodexWebSocketEnabled,
  requestOverCodexSocket,
} from 'src/providers/shims/codex/websocket.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }
const { collectCodexCompletedResponse } = await import('src/providers/shims/codexShim.js')

const CODEX = { transport: 'codex_responses' as const, baseUrl: 'https://chatgpt.com/backend-api/codex' }
const saved = process.env.CLAUDIN_CODEX_WEBSOCKET

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_CODEX_WEBSOCKET
  else process.env.CLAUDIN_CODEX_WEBSOCKET = saved
  _setCodexSocketTransportForTesting(undefined)
})

describe('the gate', () => {
  test('on by default; 0 turns it off', () => {
    delete process.env.CLAUDIN_CODEX_WEBSOCKET
    expect(isCodexWebSocketEnabled()).toBe(true)
    expect(codexSocketEligible(CODEX)).toBe(true)
    process.env.CLAUDIN_CODEX_WEBSOCKET = '0'
    expect(isCodexWebSocketEnabled()).toBe(false)
    expect(codexSocketEligible(CODEX)).toBe(false)
  })

  test.each([
    ['GitHub Copilot', { transport: 'codex_responses' as const, baseUrl: 'https://api.githubcopilot.com' }],
    ['a relay with its own baseUrl', { transport: 'codex_responses' as const, baseUrl: 'http://localhost:8000/v1' }],
    ['a chat completions provider', { transport: 'chat_completions' as const, baseUrl: 'https://api.openai.com/v1' }],
  ])('%s keeps the POST', (_name, request) => {
    process.env.CLAUDIN_CODEX_WEBSOCKET = '1'
    expect(codexSocketEligible(request)).toBe(false)
  })
})

describe('what the upgrade carries', () => {
  test('the socket URL is the POST URL under a ws scheme', () => {
    expect(codexSocketUrl('https://chatgpt.com/backend-api/codex/responses')).toBe('wss://chatgpt.com/backend-api/codex/responses')
    expect(codexSocketUrl('http://127.0.0.1:9/x')).toBe('ws://127.0.0.1:9/x')
  })

  test("the POST's headers without a body type, plus the protocol's beta", () => {
    expect(codexSocketHeaders({
      'Content-Type': 'application/json',
      'User-Agent': 'claudin/1 (linux)',
      Authorization: 'Bearer t',
      'ChatGPT-Account-Id': 'acct',
      'session-id': 's',
      originator: 'claudin',
      'openai-beta': 'something-else',
    })).toEqual({
      'User-Agent': 'claudin/1 (linux)',
      Authorization: 'Bearer t',
      'ChatGPT-Account-Id': 'acct',
      'session-id': 's',
      originator: 'claudin',
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
    })
  })
})

describe('requestOverCodexSocket against a Responses socket', () => {
  let server: Server<undefined>
  let seen: { headers: Record<string, string>; frames: Record<string, unknown>[] }

  beforeEach(() => {
    seen = { headers: {}, frames: [] }
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        seen.headers = Object.fromEntries(req.headers)
        if (srv.upgrade(req, { data: undefined })) return
        return new Response('no', { status: 426 })
      },
      websocket: {
        message(ws, message) {
          seen.frames.push(JSON.parse(String(message)) as Record<string, unknown>)
          const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }
          for (const event of [
            { type: 'response.created', response: { id: 'resp_1' } },
            { type: 'codex.rate_limits', rate_limits: {} },
            { type: 'codex.response.metadata', headers: { 'x-codex-turn-state': 'abc' } },
            { type: 'response.output_item.done', item },
            { type: 'responsesapi.websocket_timing', timing: {} },
            { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item] } },
          ]) ws.send(JSON.stringify(event))
        },
      },
    })
  })

  afterEach(() => {
    server.stop(true)
  })

  test("the shim's reader gets the completed response; the frame is the body plus its type", async () => {
    let posts = 0
    const body = { model: 'gpt-5.6-terra', stream: true, store: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
    const response = await requestOverCodexSocket({
      url: `http://127.0.0.1:${server.port}/backend-api/codex/responses`,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body,
      http: async () => {
        posts += 1
        return new Response('', { status: 500 })
      },
    })
    const completed = await collectCodexCompletedResponse(response)
    expect(completed.id).toBe('resp_1')
    expect(posts).toBe(0)
    expect(seen.frames).toEqual([{ type: 'response.create', ...body }])
    expect(seen.headers['openai-beta']).toBe('responses_websockets=2026-02-06')
    expect(seen.headers.authorization).toBe('Bearer t')
  })
})
