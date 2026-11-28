import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'
import { EventStreamCodec } from '@smithy/eventstream-codec'
import { bedrockStream, converseStream, smokeBinary } from './smoke-binary'

const fakes = mkdtempSync(join(tmpdir(), 'smoke-binary-test-'))
afterAll(() => rmSync(fakes, { recursive: true, force: true }))

// A "binary" is a bun script behind a shebang, so it runs the way the copy does.
function fakeBinary(name: string, body: string): string {
  const path = join(fakes, name)
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const answerFromMock = `
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST' })
console.log(await res.text())
`

// Reads the frames' base64 payloads straight out of the bytes and prints each event's JSON.
const answerFromBedrockMock = `
if (!process.env.AWS_ACCESS_KEY_ID) process.exit(5)
const res = await fetch(process.env.ANTHROPIC_BEDROCK_BASE_URL + '/model/m/invoke-with-response-stream', { method: 'POST' })
const raw = Buffer.from(await res.arrayBuffer()).toString('latin1')
for (const [, b64] of raw.matchAll(/"bytes":"([^"]+)"/g)) console.log(Buffer.from(b64, 'base64').toString())
`

describe.skipIf(process.platform === 'win32')('smokeBinary', () => {
  test('passes a binary that prints the text the mock streamed', async () => {
    const result = await smokeBinary(fakeBinary('answers', answerFromMock), 20_000)
    expect(result).toEqual({ ok: true, detail: 'answered (1 request(s) to the mock)' })
  })

  test('fails a binary that only knows its version, which is all --version checks', async () => {
    const result = await smokeBinary(fakeBinary('version-only', `console.log('1.1.46 (Claudin)')`), 20_000)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('exit 0 without the mock’s answer, 0 request(s)')
  })

  test('fails a binary that crashes at startup, and shows the error', async () => {
    const crash = `throw new TypeError("undefined is not an object (evaluating 'getFsImplementation().existsSync')")`
    const result = await smokeBinary(fakeBinary('crashes', crash), 20_000)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('exit 1, 0 request(s)')
    expect(result.detail).toContain('getFsImplementation().existsSync')
  })

  test('runs a copy outside the checkout, from a cwd outside it', async () => {
    const guard = `
if (process.cwd().startsWith(${JSON.stringify(REPO_ROOT)})) process.exit(3)
if (import.meta.path.startsWith(${JSON.stringify(fakes)})) process.exit(4)
${answerFromMock}`
    const result = await smokeBinary(fakeBinary('guarded', guard), 20_000)
    expect(result.detail).toBe('answered (1 request(s) to the mock)')
  })

  test('kills a binary that never answers', async () => {
    const result = await smokeBinary(fakeBinary('hangs', 'setInterval(() => {}, 1000)'), 500)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('timed out after 500 ms')
  })

  test('the bedrock lane passes a binary that reads the event-stream answer, with env credentials', async () => {
    const result = await smokeBinary(fakeBinary('bedrock-answers', answerFromBedrockMock), 20_000, 'bedrock')
    expect(result).toEqual({ ok: true, detail: 'answered (1 request(s) to the mock)' })
  })

  test('the bedrock lane fails a binary whose Bedrock client never loads', async () => {
    const crash = `console.log("API Error: undefined is not a constructor (evaluating 'new AnthropicBedrock2(bedrockArgs)')"); process.exit(1)`
    const result = await smokeBinary(fakeBinary('bedrock-crashes', crash), 20_000, 'bedrock')
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('exit 1, 0 request(s)')
    expect(result.detail).toContain('AnthropicBedrock2')
  })

  test('the anthropic lane does not answer a Bedrock request', async () => {
    const result = await smokeBinary(fakeBinary('bedrock-on-anthropic', answerFromBedrockMock), 20_000)
    expect(result.ok).toBe(false)
  })

  test('the converse lane answers converse-stream, not invoke-with-response-stream', async () => {
    const converse = `
const res = await fetch(process.env.ANTHROPIC_BEDROCK_BASE_URL + '/model/m/converse-stream', { method: 'POST' })
console.log(Buffer.from(await res.arrayBuffer()).toString('latin1'))
`
    expect(await smokeBinary(fakeBinary('converse-answers', converse), 20_000, 'converse')).toEqual({
      ok: true,
      detail: 'answered (1 request(s) to the mock)',
    })
    expect((await smokeBinary(fakeBinary('converse-on-invoke', answerFromBedrockMock), 20_000, 'converse')).ok).toBe(false)
  })
})

test('bedrockStream frames decode to the Messages events, one chunk each', () => {
  const codec = new EventStreamCodec(
    bytes => new TextDecoder().decode(bytes),
    text => new TextEncoder().encode(text),
  )
  const bytes = bedrockStream('hello')
  const events: Array<Record<string, any>> = []
  let at = 0
  while (at < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0)
    const message = codec.decode(bytes.subarray(at, at + length))
    expect(message.headers[':event-type']?.value).toBe('chunk')
    const { bytes: b64 } = JSON.parse(new TextDecoder().decode(message.body)) as { bytes: string }
    events.push(JSON.parse(Buffer.from(b64, 'base64').toString()))
    at += length
  }
  expect(events.map(e => e.type)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  expect(events[2]!.delta.text).toBe('hello')
})

test('converseStream frames are the Converse events, in order', () => {
  const codec = new EventStreamCodec(
    bytes => new TextDecoder().decode(bytes),
    text => new TextEncoder().encode(text),
  )
  const bytes = converseStream('hello')
  const types: string[] = []
  let at = 0
  while (at < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0)
    const message = codec.decode(bytes.subarray(at, at + length))
    types.push(String(message.headers[':event-type']?.value))
    if (types.length === 2) expect(JSON.parse(new TextDecoder().decode(message.body)).delta.text).toBe('hello')
    at += length
  }
  expect(types).toEqual(['messageStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata'])
})
