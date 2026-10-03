/**
 * Characterization of `useRemoteSession`, the sending side: posting what the
 * user typed, the session title, the watchdog that notices a silent session,
 * interrupting, and dropping the echo of our own messages.
 *
 * The session is a `FakeSessionsApi` on a local port. The claude.ai login the
 * HTTP calls read is a credentials file in a temp CLAUDIN_CONFIG_DIR. The
 * title model is the one mocked boundary (`queryHaiku`). The watchdog's 60 s
 * and 3 min run on Bun's fake clock, which freezes every sleep, so waits
 * inside those windows go through `waitOnFakeClock`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as claudeShim from 'src/providers/shims/claude.js'
import {
  FakeSessionsApi,
  openScratch,
  pointAnthropicApiAt,
  restoreAnthropicApi,
  type Scratch,
  settle,
  signIn,
  unmountAll,
  waitFor,
} from 'src/sessions/__testutils__/remoteRig.js'
import {
  connectRemote,
  frames,
  type RemoteHost,
  type RemoteOptions,
  SESSION,
} from 'src/sessions/__testutils__/remoteSessionHost.js'

const FIXTURES = join(import.meta.dir, '..', '__fixtures__', 'rewrite', 'remote')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const EVENTS = `/v1/sessions/${SESSION}/events`
const THE_SESSION = `/v1/sessions/${SESSION}`
const LOGIN = { accessToken: 'claude-ai-token-1', organizationUuid: 'org-from-login' }
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// --- the title model --------------------------------------------------------

const realShim = { ...claudeShim }
let titleReply = '{"title":"Tidy the release script"}'
const titleAsks: string[] = []
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: async ({ userPrompt }: { userPrompt: string }) => {
    titleAsks.push(userPrompt)
    return { message: { content: [{ type: 'text', text: titleReply }] } }
  },
}))

let api: FakeSessionsApi
let scratch: Scratch

beforeEach(() => {
  scratch = openScratch('remote-send')
  api = new FakeSessionsApi()
  pointAnthropicApiAt(api.base)
  signIn(scratch, LOGIN)
  api.answer('POST', EVENTS, 200, { ok: true })
  api.answer('PATCH', THE_SESSION, 200, {})
  titleReply = '{"title":"Tidy the release script"}'
  titleAsks.length = 0
})

afterEach(() => {
  jest.useRealTimers()
  unmountAll()
  api.stop()
  pointAnthropicApiAt(null)
  scratch.dispose()
})

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  restoreAnthropicApi()
})

const posted = () => api.callsTo('POST', EVENTS)
const titled = () => api.callsTo('PATCH', THE_SESSION)
const warnings = (host: RemoteHost) =>
  host.messages.value().filter(m => (m as { level?: string }).level === 'warning') as Array<{ content: string }>

/** Connected, with the watchdog clock faked from here on. */
async function onFakeClock(options: RemoteOptions = {}): Promise<RemoteHost> {
  const host = await connectRemote(api, options)
  jest.useFakeTimers()
  return host
}

describe('sending', () => {
  test('posts what was typed as one user event, with the login and the organization', async () => {
    const host = await connectRemote(api)
    const uuid = fixture('send-event.json').events[0].uuid
    expect(await host.hook.current().sendMessage('hello there', { uuid })).toBe(true)
    expect(posted()).toHaveLength(1)
    expect(posted()[0]!.body).toEqual(fixture('send-event.json'))
    expect(posted()[0]!.headers).toMatchObject(fixture('send-event.headers.json'))
    expect(host.loading.value()).toBe(true)
  })

  test('without a uuid the event gets a fresh one', async () => {
    const host = await connectRemote(api)
    await host.hook.current().sendMessage('no id')
    await host.hook.current().sendMessage('no id')
    const [first, second] = posted().map(call => (call.body as any).events[0].uuid)
    expect(first).toMatch(UUID_SHAPE)
    expect(second).toMatch(UUID_SHAPE)
    expect(first).not.toBe(second)
  })

  test('content blocks are posted as they are', async () => {
    const host = await connectRemote(api)
    const blocks = [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
    ]
    await host.hook.current().sendMessage(blocks)
    expect((posted()[0]!.body as any).events[0].message).toEqual({ role: 'user', content: blocks })
  })

  const answers: Array<[number, boolean]> = [
    [200, true],
    [201, true],
    [204, false],
    [400, false],
    [401, false],
    [500, false],
  ]

  test.each(answers)('an answer of %i means sent: %p', async (status, sent) => {
    api.answer('POST', EVENTS, status, status === 204 ? null : { error: { message: 'x' } })
    const host = await connectRemote(api)
    expect(await host.hook.current().sendMessage('try')).toBe(sent)
    expect(host.loading.value()).toBe(sent)
    expect(host.loading.history).toContain(true)
  })

  test('without a claude.ai login nothing is posted and the send fails', async () => {
    const host = await connectRemote(api)
    scratch.dispose()
    scratch = openScratch('remote-send-anon')
    expect(await host.hook.current().sendMessage('anyone?')).toBe(false)
    expect(posted()).toHaveLength(0)
    expect(host.loading.value()).toBe(false)
  })
})

describe('the session title', () => {
  test('the first message of a session started without a prompt names it, once', async () => {
    const host = await connectRemote(api, { config: { hasInitialPrompt: false } })
    await host.hook.current().sendMessage('clean up the release script')
    await waitFor(() => titled().length === 1)
    expect(titleAsks).toEqual(['clean up the release script'])
    expect(titled()[0]!.body).toEqual(fixture('title.json'))
    expect(titled()[0]!.headers).toMatchObject(fixture('send-event.headers.json'))

    await host.hook.current().sendMessage('and the changelog')
    await settle(100)
    expect(titleAsks).toHaveLength(1)
    expect(titled()).toHaveLength(1)
  })

  test('from blocks, the text blocks joined by a space are what the model reads', async () => {
    const host = await connectRemote(api, { config: { hasInitialPrompt: false } })
    await host.hook.current().sendMessage([
      { type: 'text', text: 'fix' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
      { type: 'text', text: 'the flaky test' },
    ])
    await waitFor(() => titled().length === 1)
    expect(titleAsks).toEqual(['fix the flaky test'])
  })

  const fallbacks: Array<[string, string, string]> = [
    ['a short message is the title as it is', 'rename the flag', 'rename the flag'],
    [
      'a long one is cut to 75 columns with an ellipsis',
      'x'.repeat(40) + ' ' + 'y'.repeat(59),
      'x'.repeat(40) + ' ' + 'y'.repeat(33) + '…',
    ],
  ]

  test.each(fallbacks)('a model reply without a title: %s', async (_name, typed, title) => {
    titleReply = 'Sure! Here is a title for you.'
    const host = await connectRemote(api, { config: { hasInitialPrompt: false } })
    await host.hook.current().sendMessage(typed)
    await waitFor(() => titled().length === 1)
    expect(titled()[0]!.body).toEqual({ title })
  })

  const untitled: Array<[string, RemoteOptions['config']]> = [
    ['a session started with a prompt', { hasInitialPrompt: true }],
    ['a viewer', { hasInitialPrompt: false, viewerOnly: true }],
  ]

  test.each(untitled)('%s is never renamed', async (_name, config) => {
    const host = await connectRemote(api, { config })
    await host.hook.current().sendMessage('anything at all')
    await settle(100)
    expect(posted()).toHaveLength(1)
    expect(titleAsks).toHaveLength(0)
    expect(titled()).toHaveLength(0)
  })

  test('a failed send leaves the title to the next message that gets through', async () => {
    const host = await connectRemote(api, { config: { hasInitialPrompt: false } })
    api.answer('POST', EVENTS, 400, {})
    expect(await host.hook.current().sendMessage('lost message')).toBe(false)
    await settle(100)
    expect(titleAsks).toHaveLength(0)
    api.answer('POST', EVENTS, 200, {})
    await host.hook.current().sendMessage('second try')
    await waitFor(() => titled().length === 1)
    expect(titleAsks).toEqual(['second try'])
  })
})

describe('the watchdog', () => {
  test('a minute without a frame after a send: a warning, and the socket is opened again', async () => {
    const host = await onFakeClock()
    await host.hook.current().sendMessage('are you there')
    jest.advanceTimersByTime(59_999)
    expect(warnings(host)).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(warnings(host)).toHaveLength(1)
    expect(warnings(host)[0]!.content).toContain('unresponsive')
    expect((host.messages.value()[0] as { type: string }).type).toBe('system')
    jest.advanceTimersByTime(500)
    jest.useRealTimers()
    await waitFor(() => api.handshakes.length === 2 && api.openSockets === 1)
    expect(api.closes.length).toBeGreaterThanOrEqual(1)
  })

  test('any frame before the minute is up stands the watchdog down', async () => {
    const host = await onFakeClock()
    await host.hook.current().sendMessage('working?')
    api.push(frames.assistant([{ type: 'text', text: 'on it' }]))
    await api.waitOnFakeClock(() => host.messages.value().length === 1)
    jest.advanceTimersByTime(120_000)
    expect(warnings(host)).toHaveLength(0)
  })

  test('the echo of our own message counts as a frame', async () => {
    const host = await onFakeClock()
    await host.hook.current().sendMessage('ping', { uuid: 'aaaaaaaa-0000-4000-8000-000000000001' })
    api.push(frames.user('ping', 'aaaaaaaa-0000-4000-8000-000000000001'))
    // A permission request does not touch the watchdog; it only shows that
    // the echo before it has been read.
    api.push(frames.canUseTool('req-after-echo', { tool_name: 'Bash', input: {}, tool_use_id: 'toolu_e' }))
    await api.waitOnFakeClock(() => host.queue.value().length === 1)
    jest.advanceTimersByTime(120_000)
    expect(warnings(host)).toHaveLength(0)
  })

  test('a permission request alone does not stand it down', async () => {
    const host = await onFakeClock()
    await host.hook.current().sendMessage('ping')
    api.push(frames.canUseTool('req-only', { tool_name: 'Bash', input: {}, tool_use_id: 'toolu_q' }))
    await api.waitOnFakeClock(() => host.queue.value().length === 1)
    jest.advanceTimersByTime(60_000)
    expect(warnings(host)).toHaveLength(1)
  })

  test('while the session compacts it waits three minutes instead', async () => {
    const host = await connectRemote(api)
    api.push(frames.system('status', { status: 'compacting' }))
    await waitFor(() => host.messages.value().length === 1)
    jest.useFakeTimers()
    await host.hook.current().sendMessage('still there?')
    jest.advanceTimersByTime(179_999)
    expect(warnings(host)).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(warnings(host)).toHaveLength(1)
  })

  const compactionEnds: Array<[string, () => unknown]> = [
    ['a cleared status', () => frames.system('status', { status: null })],
    ['a compaction boundary', () => frames.system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 1 } })],
    ['a result', () => frames.result('success')],
  ]

  test.each(compactionEnds)('after %s the minute applies again', async (_name, end) => {
    const host = await connectRemote(api)
    api.push(frames.system('status', { status: 'compacting' }))
    api.push(end())
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().some(m => (m as any).message?.content?.[0]?.text === 'marker'))
    jest.useFakeTimers()
    await host.hook.current().sendMessage('next')
    jest.advanceTimersByTime(60_000)
    expect(warnings(host)).toHaveLength(1)
  })

  test('a second send restarts the minute', async () => {
    const host = await onFakeClock()
    await host.hook.current().sendMessage('one')
    jest.advanceTimersByTime(40_000)
    await host.hook.current().sendMessage('two')
    jest.advanceTimersByTime(40_000)
    expect(warnings(host)).toHaveLength(0)
    jest.advanceTimersByTime(20_000)
    expect(warnings(host)).toHaveLength(1)
  })

  const quiet: Array<[string, RemoteOptions, (host: RemoteHost) => void]> = [
    ['a viewer never arms it', { config: { viewerOnly: true } }, () => {}],
    ['cancelling disarms it', {}, host => host.hook.current().cancelRequest()],
    ['disconnecting disarms it', {}, host => host.hook.current().disconnect()],
    ['unmounting disarms it', {}, host => host.hook.unmount()],
  ]

  test.each(quiet)('%s', async (_name, options, after) => {
    const host = await onFakeClock(options)
    await host.hook.current().sendMessage('hello')
    after(host)
    jest.advanceTimersByTime(600_000)
    expect(warnings(host)).toHaveLength(0)
  })

  test('a failed send arms nothing', async () => {
    api.answer('POST', EVENTS, 400, {})
    const host = await onFakeClock()
    await host.hook.current().sendMessage('lost')
    jest.advanceTimersByTime(600_000)
    expect(warnings(host)).toHaveLength(0)
  })
})

describe('interrupting', () => {
  test('cancel sends an interrupt to the session and stops loading', async () => {
    const host = await connectRemote(api)
    host.loading.set(true)
    host.hook.current().cancelRequest()
    expect(host.loading.value()).toBe(false)
    await waitFor(() => api.fromClient.length === 1)
    const frame = api.fromClient[0] as { request_id: string }
    expect(frame.request_id).toMatch(UUID_SHAPE)
    expect({ ...frame, request_id: '<uuid>' }).toEqual(fixture('interrupt.json'))
  })

  test('a viewer never interrupts the remote agent', async () => {
    const host = await connectRemote(api, { config: { viewerOnly: true } })
    host.loading.set(true)
    host.hook.current().cancelRequest()
    expect(host.loading.value()).toBe(false)
    await settle(100)
    expect(api.fromClient).toEqual([])
  })
})

describe('the echo of our own messages', () => {
  // A viewer shows typed user messages, so a leaked echo would be visible.
  const viewer: RemoteOptions = { config: { viewerOnly: true } }
  const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`

  test('every echo of a uuid we sent is dropped; other user messages are shown', async () => {
    const host = await connectRemote(api, viewer)
    await host.hook.current().sendMessage('mine', { uuid: id(1) })
    api.push(frames.user('mine', id(1)))
    api.push(frames.user('mine', id(1)))
    api.push(frames.user('theirs', id(2)))
    await waitFor(() => host.messages.value().length === 1)
    await settle()
    expect(host.messages.value().map(m => (m as any).message.content)).toEqual(['theirs'])
  })

  test('the uuid of a send that failed is still dropped', async () => {
    api.answer('POST', EVENTS, 400, {})
    const host = await connectRemote(api, viewer)
    await host.hook.current().sendMessage('lost', { uuid: id(3) })
    api.push(frames.user('lost', id(3)))
    api.push(frames.user('marker', id(4)))
    await waitFor(() => host.messages.value().length === 1)
    expect((host.messages.value()[0] as any).message.content).toBe('marker')
  })

  test('only the last 50 uuids sent are remembered', async () => {
    const host = await connectRemote(api, viewer)
    for (let n = 1; n <= 51; n++) await host.hook.current().sendMessage(`m${n}`, { uuid: id(100 + n) })
    api.push(frames.user('m1', id(101)))
    api.push(frames.user('m2', id(102)))
    api.push(frames.user('m51', id(151)))
    api.push(frames.user('marker', id(999)))
    await waitFor(() => host.messages.value().length === 2)
    expect(host.messages.value().map(m => (m as any).message.content)).toEqual(['m1', 'marker'])
  })
})
