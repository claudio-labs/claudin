/**
 * Characterization of `useRemoteSession`: the REPL's view of a session that
 * runs on Anthropic's servers. This file covers the socket (who it reaches,
 * with which credentials), what each frame from the session does to the
 * transcript and to the REPL's state, the connection status, and permission
 * prompts. Sending is in `useRemoteSession.sending.characterization.test.tsx`.
 *
 * The session is a `FakeSessionsApi` on a local port; the hook runs inside a
 * real Ink root, with every setter the REPL passes recorded.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  FakeSessionsApi,
  openScratch,
  pointAnthropicApiAt,
  restoreAnthropicApi,
  type Scratch,
  settle,
  unmountAll,
  waitFor,
} from 'src/sessions/__testutils__/remoteRig.js'
import {
  connectRemote,
  frames,
  localTool,
  mountRemote,
  type RemoteHost,
  remoteConfig,
  SESSION,
} from 'src/sessions/__testutils__/remoteSessionHost.js'

const FIXTURES = join(import.meta.dir, '..', '__fixtures__', 'rewrite', 'remote')
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

let api: FakeSessionsApi
let scratch: Scratch

beforeEach(() => {
  scratch = openScratch('remote-session')
  api = new FakeSessionsApi()
  pointAnthropicApiAt(api.base)
})

afterEach(() => {
  unmountAll()
  api.stop()
  pointAnthropicApiAt(null)
  scratch.dispose()
})

afterAll(() => {
  restoreAnthropicApi()
})

const lastMessage = (host: RemoteHost) => host.messages.value().at(-1) as Record<string, any> | undefined

describe('the socket', () => {
  test('subscribes to the session with the socket token, the organization and the API version', async () => {
    const host = await connectRemote(api)
    expect(api.handshakes).toEqual([fixture('subscribe.json')])
    expect(host.hook.current().isRemoteMode).toBe(true)
    expect(host.status()).toBe('connected')
  })

  test('outside remote mode nothing connects and nothing can be sent', async () => {
    const host = await mountRemote({ config: null })
    await settle()
    expect(api.handshakes).toHaveLength(0)
    const hook = host.hook.current()
    expect(hook.isRemoteMode).toBe(false)
    expect(await hook.sendMessage('hello')).toBe(false)
    expect(api.calls).toHaveLength(0)
    hook.disconnect()
    hook.cancelRequest()
    expect(host.loading.value()).toBe(false)
  })

  test('the result is the same object across renders with the same props', async () => {
    const host = await connectRemote(api)
    const first = host.hook.current()
    await host.hook.rerender({ ...host.props })
    expect(host.hook.current()).toBe(first)
  })

  test('a new config closes the old subscription and opens one for the new session', async () => {
    const host = await connectRemote(api)
    await host.hook.rerender({ ...host.props, config: remoteConfig({ sessionId: 'session_02next' }) })
    await waitFor(() => api.handshakes.length === 2 && api.closes.length === 1)
    expect(api.handshakes[1]?.path).toBe('/v1/sessions/ws/session_02next/subscribe')
    expect(api.openSockets).toBe(1)
  })

  test('unmounting closes the socket', async () => {
    const host = await connectRemote(api)
    host.hook.unmount()
    await waitFor(() => api.closes.length === 1)
    expect(api.openSockets).toBe(0)
  })

  test('disconnect closes the socket, and nothing is sent afterwards', async () => {
    const host = await connectRemote(api)
    host.hook.current().disconnect()
    await waitFor(() => api.closes.length === 1)
    expect(await host.hook.current().sendMessage('late')).toBe(false)
    host.hook.current().cancelRequest()
    await settle()
    expect(api.calls).toHaveLength(0)
    expect(api.fromClient).toHaveLength(0)
  })

  test('a dropped socket reports reconnecting, forgets running work, and comes back connected', async () => {
    const host = await connectRemote(api)
    api.push(frames.system('task_started', { task_id: 'task-a' }))
    api.push(frames.assistant([{ type: 'tool_use', id: 'toolu_gap', name: 'Bash', input: {} }]))
    await waitFor(() => host.taskCount() === 1 && host.inFlight.value().size === 1)

    api.hangUp(1011)
    await waitFor(() => host.status() === 'reconnecting')
    expect(host.taskCount()).toBe(0)
    expect(host.inFlight.value().size).toBe(0)
    // The retry comes after the socket's own back-off, about two seconds.
    await waitFor(() => host.status() === 'connected' && api.handshakes.length === 2, 4000)
  })

  test('a reconnect with nothing in flight keeps the same set of in-flight ids', async () => {
    const host = await connectRemote(api)
    const before = host.inFlight.value()
    api.hangUp(1011)
    await waitFor(() => host.status() === 'reconnecting')
    expect(host.inFlight.value()).toBe(before)
  })

  test('a server that refuses the session ends it: disconnected, not loading, nothing left running', async () => {
    const host = await connectRemote(api)
    api.push(frames.system('task_started', { task_id: 'task-a' }))
    api.push(frames.assistant([{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }]))
    await waitFor(() => host.taskCount() === 1 && host.inFlight.value().size === 1)
    host.loading.set(true)
    api.hangUp(4003)
    await waitFor(() => host.status() === 'disconnected')
    expect(host.loading.value()).toBe(false)
    expect(host.taskCount()).toBe(0)
    expect(host.inFlight.value().size).toBe(0)
    await settle(100)
    expect(api.handshakes).toHaveLength(1)
  })
})

describe('frames from the session', () => {
  test('an assistant message joins the transcript, marks its tool uses in flight and ends streaming', async () => {
    const host = await connectRemote(api)
    host.streaming.set([{ index: 0, contentBlock: {} as never, unparsedToolInput: '' }])
    api.push(
      frames.assistant([
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: {} },
      ]),
    )
    await waitFor(() => host.messages.value().length === 1)
    const message = lastMessage(host)!
    expect(message.type).toBe('assistant')
    expect(message.message.content[0]).toEqual({ type: 'text', text: 'Looking.' })
    expect([...host.inFlight.value()].sort()).toEqual(['toolu_a', 'toolu_b'])
    expect(host.streaming.value()).toEqual([])
    expect(host.loading.history).not.toContain(false)
  })

  test('an assistant message without tool uses leaves the in-flight set alone', async () => {
    const host = await connectRemote(api)
    const before = host.inFlight.value()
    const streamingBefore = host.streaming.value()
    api.push(frames.assistant([{ type: 'text', text: 'Plain.' }]))
    await waitFor(() => host.messages.value().length === 1)
    expect(host.inFlight.value()).toBe(before)
    expect(host.streaming.value()).toBe(streamingBefore)
  })

  test('a tool result takes its tool use out of flight but is not shown', async () => {
    const host = await connectRemote(api)
    api.push(
      frames.assistant([
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
      ]),
    )
    await waitFor(() => host.inFlight.value().size === 2)
    api.push(frames.toolResult('toolu_1'))
    await waitFor(() => host.inFlight.value().size === 1)
    expect([...host.inFlight.value()]).toEqual(['toolu_2'])
    expect(host.messages.value()).toHaveLength(1)
  })

  test('a tool result for an id not in flight keeps the same set', async () => {
    const host = await connectRemote(api)
    api.push(frames.assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]))
    await waitFor(() => host.inFlight.value().size === 1)
    const before = host.inFlight.value()
    api.push(frames.toolResult('toolu_other'))
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 2)
    expect(host.inFlight.value()).toBe(before)
  })

  test('typed user messages are not shown again: the REPL already added them', async () => {
    const host = await connectRemote(api)
    api.push(frames.user('typed here'))
    api.push(frames.user([{ type: 'text', text: 'typed as blocks' }]))
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 1)
    await settle()
    expect(host.messages.value()).toHaveLength(1)
  })

  test('a viewer shows user messages and tool results, since nothing local added them', async () => {
    const host = await connectRemote(api, { config: { viewerOnly: true } })
    api.push(frames.user('from another client'))
    api.push(frames.toolResult('toolu_v'))
    await waitFor(() => host.messages.value().length === 2)
    const [typed, result] = host.messages.value() as Array<Record<string, any>>
    expect(typed?.type).toBe('user')
    expect(typed?.message.content).toBe('from another client')
    expect(result?.type).toBe('user')
    expect(result?.message.content[0].type).toBe('tool_result')
  })

  const shown: Array<[string, () => unknown, (message: Record<string, any>) => void]> = [
    [
      'an error result, as a warning naming every error',
      () => frames.result('error_during_execution', ['disk full', 'quota']),
      m => {
        expect(m.type).toBe('system')
        expect(m.level).toBe('warning')
        expect(m.content).toBe('disk full, quota')
      },
    ],
    [
      'an init message, naming the model',
      () => frames.init(['/review'], 'claude-remote-1'),
      m => {
        expect(m.type).toBe('system')
        expect(m.content).toContain('claude-remote-1')
      },
    ],
    [
      'a compaction boundary',
      () => frames.system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }),
      m => {
        expect(m.subtype).toBe('compact_boundary')
        expect(m.compactMetadata).toEqual({ trigger: 'auto', preTokens: 9000 })
      },
    ],
    [
      'the start of a compaction',
      () => frames.system('status', { status: 'compacting' }),
      m => {
        expect(m.type).toBe('system')
        expect(m.content).toContain('Compacting')
      },
    ],
    [
      'tool progress',
      () => ({ type: 'tool_progress', uuid: crypto.randomUUID(), tool_name: 'Bash', tool_use_id: 'toolu_p', elapsed_time_seconds: 7, session_id: SESSION }),
      m => {
        expect(m.type).toBe('system')
        expect(m.toolUseID).toBe('toolu_p')
      },
    ],
  ]

  test.each(shown)('shown: %s', async (_name, frame, check) => {
    const host = await connectRemote(api)
    api.push(frame())
    await waitFor(() => host.messages.value().length === 1)
    check(lastMessage(host)!)
  })

  const hidden: Array<[string, () => unknown]> = [
    ['a successful result', () => frames.result('success')],
    ['a status that clears', () => frames.system('status', { status: null })],
    ['task progress', () => frames.system('task_progress', { task_id: 'task-z' })],
    ['a hook response', () => frames.system('hook_response')],
    ['an unknown frame type', () => ({ type: 'brand_new_kind', uuid: crypto.randomUUID() })],
    ['a control response', () => ({ type: 'control_response', response: { subtype: 'success', request_id: 'r' } })],
  ]

  test.each(hidden)('not shown: %s', async (_name, frame) => {
    const host = await connectRemote(api)
    api.push(frame())
    api.pushRaw('this is not json')
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 1)
    expect(lastMessage(host)?.message.content[0].text).toBe('marker')
  })

  test('a result ends loading, and so does an error result', async () => {
    const host = await connectRemote(api)
    for (const frame of [frames.result('success'), frames.result('error_max_turns', ['too many turns'])]) {
      host.loading.set(true)
      api.push(frame)
      await waitFor(() => host.loading.value() === false)
    }
  })

  test('init hands the slash commands to onInit, and is shown without one', async () => {
    const withInit = await connectRemote(api)
    api.push(frames.init(['/review', '/deploy']))
    await waitFor(() => withInit.inits.length === 1)
    expect(withInit.inits).toEqual([['/review', '/deploy']])
    withInit.hook.unmount()

    const without = await mountRemote({ onInit: false })
    await waitFor(() => api.openSockets === 1 && without.status() === 'connected')
    api.push(frames.init(['/x']))
    await waitFor(() => without.messages.value().length === 1)
    expect(without.inits).toEqual([])
  })

  test('task frames count the work running in the remote session', async () => {
    const host = await connectRemote(api)
    api.push(frames.system('task_started', { task_id: 'a' }))
    api.push(frames.system('task_started', { task_id: 'b' }))
    api.push(frames.system('task_started', { task_id: 'b' }))
    await waitFor(() => host.taskCount() === 2)
    api.push(frames.system('task_notification', { task_id: 'a', status: 'completed' }))
    await waitFor(() => host.taskCount() === 1)
    api.push(frames.system('task_notification', { task_id: 'unknown', status: 'completed' }))
    api.push(frames.system('task_notification', { task_id: 'b', status: 'completed' }))
    await waitFor(() => host.taskCount() === 0)
    expect(host.messages.value()).toHaveLength(0)
  })

  test('repeated compacting ticks are shown once', async () => {
    const host = await connectRemote(api)
    for (let i = 0; i < 3; i++) api.push(frames.system('status', { status: 'compacting' }))
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 2)
    expect((host.messages.value()[0] as Record<string, any>).content).toContain('Compacting')
  })

  test('a stream event drives the spinner mode and the streaming tool uses', async () => {
    const host = await connectRemote(api)
    api.push(
      frames.stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_s', name: 'Edit', input: {} },
      }),
    )
    await waitFor(() => host.streaming.value().length === 1)
    expect(host.mode.value()).toBe('tool-input')
    expect(host.streaming.value()[0]).toMatchObject({ index: 0, unparsedToolInput: '' })
    api.push(frames.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } }))
    await waitFor(() => host.streaming.value()[0]?.unparsedToolInput === '{"a"')
    api.push(frames.stream({ type: 'message_stop' }))
    await waitFor(() => host.streaming.value().length === 0)
    expect(host.messages.value()).toHaveLength(0)
  })

  test('without the streaming setters, stream events are dropped', async () => {
    const host = await connectRemote(api, { streaming: false })
    api.push(frames.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 1)
    expect(host.mode.history).toEqual([undefined])
  })

  test('without the in-flight setter, assistant tool uses and results still render', async () => {
    const host = await connectRemote(api, { inFlight: false, config: { viewerOnly: true } })
    api.push(frames.assistant([{ type: 'tool_use', id: 'toolu_n', name: 'Read', input: {} }]))
    api.push(frames.toolResult('toolu_n'))
    await waitFor(() => host.messages.value().length === 2)
    expect(host.inFlight.history).toHaveLength(1)
  })
})

describe('permission prompts', () => {
  const ask = {
    tool_name: 'Bash',
    input: { command: 'rm -rf build' },
    tool_use_id: 'toolu_perm',
    description: 'Delete the build directory',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    blocked_path: '/work/build',
  }

  test('a request from the session queues a prompt for the local tool and pauses loading', async () => {
    const bash = localTool('Bash')
    const host = await connectRemote(api, { tools: [bash] })
    host.loading.set(true)
    api.push(frames.canUseTool('req-1', ask))
    await waitFor(() => host.queue.value().length === 1)
    const prompt = host.queue.value()[0]!
    expect(prompt.tool).toBe(bash)
    expect(prompt.description).toBe('Delete the build directory')
    expect(prompt.input).toEqual({ command: 'rm -rf build' })
    expect(prompt.toolUseID).toBe('toolu_perm')
    expect(prompt.permissionResult).toEqual({
      behavior: 'ask',
      message: 'Delete the build directory',
      suggestions: ask.permission_suggestions,
      blockedPath: '/work/build',
    } as never)
    const use = (prompt.assistantMessage.message.content as unknown[])[0]
    expect(use).toEqual({ type: 'tool_use', id: 'toolu_perm', name: 'Bash', input: { command: 'rm -rf build' } })
    expect(typeof prompt.permissionPromptStartTimeMs).toBe('number')
    expect(host.loading.value()).toBe(false)
  })

  test('a tool the CLI does not have gets a stand-in named after it, and a default description', async () => {
    const host = await connectRemote(api, { tools: [localTool('Read')] })
    api.push(frames.canUseTool('req-2', { tool_name: 'mcp__remote__deploy', input: { env: 'prod' }, tool_use_id: 'toolu_m' }))
    await waitFor(() => host.queue.value().length === 1)
    const prompt = host.queue.value()[0]!
    expect(prompt.tool.name).toBe('mcp__remote__deploy')
    expect(prompt.tool.userFacingName(undefined as never)).toBe('mcp__remote__deploy')
    expect(prompt.description).toBe('mcp__remote__deploy requires permission')
    expect((prompt.permissionResult as { message: string }).message).toBe('mcp__remote__deploy requires permission')
  })

  test('tools handed in on a later render are the ones looked up', async () => {
    const host = await connectRemote(api, { tools: [] })
    const late = localTool('Bash')
    await host.hook.rerender({ ...host.props, tools: [late] })
    api.push(frames.canUseTool('req-3', ask))
    await waitFor(() => host.queue.value().length === 1)
    expect(host.queue.value()[0]!.tool).toBe(late)
  })

  type Answer = [string, (prompt: any) => void, string, boolean | undefined]
  const answers: Answer[] = [
    ['allow', p => p.onAllow({ command: 'rm -rf build/tmp' }, [], undefined), 'permission-allow.json', true],
    ['reject with feedback', p => p.onReject('use git clean instead'), 'permission-reject-feedback.json', false],
    ['reject', p => p.onReject(), 'permission-reject.json', false],
    ['abort', p => p.onAbort(), 'permission-abort.json', false],
  ]

  test.each(answers)('%s answers the session and leaves the queue', async (_name, act, file, loadingAfter) => {
    const host = await connectRemote(api, { tools: [localTool('Bash')] })
    api.push(frames.canUseTool('req-9', ask))
    api.push(frames.canUseTool('req-10', { ...ask, tool_use_id: 'toolu_other' }))
    await waitFor(() => host.queue.value().length === 2)
    act(host.queue.value()[0])
    await waitFor(() => api.fromClient.length === 1)
    expect(api.fromClient[0]).toEqual(fixture(file))
    expect(host.queue.value().map(p => p.toolUseID)).toEqual(['toolu_other'])
    expect(host.loading.value()).toBe(loadingAfter)
  })

  test('user interaction and a recheck send nothing', async () => {
    const host = await connectRemote(api)
    api.push(frames.canUseTool('req-4', ask))
    await waitFor(() => host.queue.value().length === 1)
    const prompt = host.queue.value()[0]!
    prompt.onUserInteraction()
    await prompt.recheckPermission()
    await settle()
    expect(api.fromClient).toEqual([])
    expect(host.queue.value()).toHaveLength(1)
  })

  test('a request the session cancels leaves the queue and resumes loading', async () => {
    const host = await connectRemote(api)
    api.push(frames.canUseTool('req-5', ask))
    api.push(frames.canUseTool('req-6', { ...ask, tool_use_id: 'toolu_keep' }))
    await waitFor(() => host.queue.value().length === 2)
    api.push(frames.cancel('req-5'))
    await waitFor(() => host.queue.value().length === 1)
    expect(host.queue.value()[0]!.toolUseID).toBe('toolu_keep')
    expect(host.loading.value()).toBe(true)
  })

  test('a cancel for a request it never saw removes a prompt whose tool use id is the request id', async () => {
    const host = await connectRemote(api)
    api.push(frames.canUseTool('req-7', { ...ask, tool_use_id: 'ghost' }))
    await waitFor(() => host.queue.value().length === 1)
    api.push(frames.cancel('ghost'))
    await waitFor(() => host.queue.value().length === 0)
    expect(host.loading.value()).toBe(true)
  })

  test('a control request of another kind is not queued', async () => {
    const host = await connectRemote(api)
    api.push({ type: 'control_request', request_id: 'req-8', request: { subtype: 'set_model', model: 'x' } })
    api.push(frames.assistant([{ type: 'text', text: 'marker' }]))
    await waitFor(() => host.messages.value().length === 1)
    expect(host.queue.value()).toHaveLength(0)
  })
})
