import { afterEach, describe, expect, test } from 'bun:test'
import {
  type Cassette,
  type CassetteServer,
  loadCassette,
  recordedRequestBody,
  startCassetteServer,
} from 'src/providers/__testutils__/cassetteServer.js'

let server: CassetteServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function cassette(interactions: Cassette['interactions']): Cassette {
  return { version: 1, interactions }
}

describe('cassetteServer', () => {
  test('replays a recorded SSE body on the recorded path, whatever the host', async () => {
    const recorded = loadCassette('minimax-messages/m3-streams-adaptive-thinking')
    server = await startCassetteServer([recorded])

    const res = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'MiniMax-M3' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toBe(recorded.interactions[0]!.response.body!)
    expect(server.captures).toHaveLength(1)
    expect(server.captures[0]!.json).toEqual({ model: 'MiniMax-M3' })
    expect(server.unmatched).toHaveLength(0)
  })

  test('decodes a base64 body (the AWS event stream) to its bytes', async () => {
    const recorded = loadCassette('bedrock-converse/streams-text')
    server = await startCassetteServer([recorded])
    const path = new URL(recorded.interactions[0]!.request.url).pathname

    const res = await fetch(`${server.url}${path}`, { method: 'POST', body: '{}' })

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(bytes).toString('base64')).toBe(recorded.interactions[0]!.response.body!)
    expect(res.headers.get('content-type')).toBe('application/vnd.amazon.eventstream')
  })

  test('matches an encoded path segment against its decoded form', async () => {
    server = await startCassetteServer([
      cassette([
        {
          request: { method: 'POST', url: 'https://bedrock.example/model/us.amazon.nova-micro-v1%3A0/converse-stream' },
          response: { status: 200, body: 'ok' },
        },
      ]),
    ])

    const res = await fetch(`${server.url}/model/us.amazon.nova-micro-v1:0/converse-stream`, { method: 'POST' })

    expect(await res.text()).toBe('ok')
  })

  test('serves the Nth request to a path the Nth interaction recorded for it', async () => {
    server = await startCassetteServer([
      cassette([
        { request: { method: 'POST', url: 'https://a.example/v1/responses' }, response: { status: 200, body: 'first' } },
        { request: { method: 'POST', url: 'https://a.example/v1/other' }, response: { status: 201, body: 'other' } },
        { request: { method: 'POST', url: 'https://a.example/v1/responses' }, response: { status: 200, body: 'second' } },
      ]),
    ])

    const first = await fetch(`${server.url}/v1/responses`, { method: 'POST' })
    const second = await fetch(`${server.url}/v1/responses`, { method: 'POST' })

    expect(await first.text()).toBe('first')
    expect(await second.text()).toBe('second')
  })

  test('answers 599 and records a request no interaction is left for', async () => {
    server = await startCassetteServer([
      cassette([{ request: { method: 'POST', url: 'https://a.example/v1/responses' }, response: { status: 200, body: '' } }]),
    ])
    await fetch(`${server.url}/v1/responses`, { method: 'POST' })

    const extra = await fetch(`${server.url}/v1/responses?x=1`, { method: 'POST', body: 'not json' })

    expect(extra.status).toBe(599)
    expect(server.unmatched).toHaveLength(1)
    expect(server.unmatched[0]!.search).toBe('?x=1')
    expect(server.unmatched[0]!.json).toBeUndefined()
  })

  test('recordedRequestBody parses the recorded body, and an absent one is empty', () => {
    const recorded = loadCassette('openai-responses/openai-responses-gpt-5-5-reasoning-continuation')

    expect(recordedRequestBody(recorded, 1)).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] })
    expect(recordedRequestBody(cassette([{ request: { method: 'GET', url: 'https://a.example/' }, response: { status: 200 } }]))).toEqual({})
  })
})
