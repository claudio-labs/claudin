// Characterization of what Claudin answers to an MCP server's
// elicitation/create, what it queues in AppState for the dialog, and how
// notifications/elicitation/complete marks a queued URL elicitation — over a
// real SDK Client/Server pair, with real lifecycle hooks.
import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import {
  registerElicitationHandler,
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitationHandler.js'
import {
  appStateBox,
  linkedPair,
  useElicitationHooks,
  waitUntil,
} from 'src/mcp/__testutils__/elicitationHarness.js'

const hooks = useElicitationHooks()

const FORM = {
  message: 'Your name?',
  requestedSchema: {
    type: 'object' as const,
    properties: { name: { type: 'string' as const } },
    required: ['name'],
  },
}
const URL_PARAMS = {
  mode: 'url' as const,
  message: 'Sign in',
  url: 'https://auth.example/start',
  elicitationId: 'el-1',
}

const pairs: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const p of pairs.splice(0)) await p.close()
})

async function wired(serverName = 'srv') {
  const box = appStateBox()
  const pair = await linkedPair({
    beforeConnect: client => registerElicitationHandler(client, serverName, box.set),
  })
  pairs.push(pair)
  return { ...pair, box }
}

describe('registerElicitationHandler — form mode', () => {
  test('queues the request for the dialog and sends back what the user answered', async () => {
    const { server, box } = await wired()
    const answer = server.elicitInput(FORM)
    await waitUntil(() => box.queue().length === 1, 'queued elicitation')

    const [event] = box.queue()
    expect(event!.serverName).toBe('srv')
    expect(typeof event!.requestId).toBe('number')
    expect(event!.params).toMatchObject({ message: 'Your name?', mode: 'form' })
    expect(event!.signal).toBeInstanceOf(AbortSignal)
    expect(event!.waitingState).toBeUndefined()

    event!.respond({ action: 'accept', content: { name: 'Ada' } })
    expect(await answer).toEqual({ action: 'accept', content: { name: 'Ada' } })
    expect(hooks.notifications).toContainEqual({
      type: 'elicitation_response',
      message: 'Elicitation response for server "srv": accept',
    })
  })

  test('the hooks see the server name, the message, the schema and the mode', async () => {
    const { server, box } = await wired()
    const answer = server.elicitInput(FORM)
    await waitUntil(() => box.queue().length === 1)
    box.queue()[0]!.respond({ action: 'decline' })
    expect(await answer).toEqual({ action: 'decline' })

    const pre = hooks.inputs.find(i => i.hook_event_name === 'Elicitation') as Record<string, unknown>
    expect(pre).toMatchObject({
      mcp_server_name: 'srv',
      message: 'Your name?',
      mode: 'form',
      requested_schema: FORM.requestedSchema,
    })
    expect(pre.url).toBeUndefined()
    expect(pre.elicitation_id).toBeUndefined()
    const post = hooks.inputs.find(i => i.hook_event_name === 'ElicitationResult') as Record<string, unknown>
    expect(post).toMatchObject({ mcp_server_name: 'srv', mode: 'form', action: 'decline' })
  })

  test('an Elicitation hook answers for the user: nothing is queued', async () => {
    hooks.answer('Elicitation', {
      hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'Hook' } },
    })
    const { server, box } = await wired()
    expect(await server.elicitInput(FORM)).toEqual({ action: 'accept', content: { name: 'Hook' } })
    expect(box.queue()).toHaveLength(0)
  })

  test('an Elicitation hook that blocks declines without asking', async () => {
    hooks.answer('Elicitation', { decision: 'block', reason: 'not here' })
    const { server, box } = await wired()
    expect(await server.elicitInput(FORM)).toEqual({ action: 'decline' })
    expect(box.queue()).toHaveLength(0)
  })

  test('an ElicitationResult hook overrides the action and keeps the user content when it gives none', async () => {
    hooks.answer('ElicitationResult', {
      hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'accept' },
    })
    const { server, box } = await wired()
    const answer = server.elicitInput({ ...FORM, requestedSchema: { type: 'object', properties: {} } })
    await waitUntil(() => box.queue().length === 1)
    box.queue()[0]!.respond({ action: 'cancel', content: { kept: true } })
    expect(await answer).toEqual({ action: 'accept', content: { kept: true } })
    expect(hooks.notifications).toContainEqual({
      type: 'elicitation_response',
      message: 'Elicitation response for server "srv": accept',
    })
  })

  test('an ElicitationResult hook that blocks turns the answer into decline', async () => {
    hooks.answer('ElicitationResult', { decision: 'block', reason: 'no' })
    const { server, box } = await wired()
    const answer = server.elicitInput(FORM)
    await waitUntil(() => box.queue().length === 1)
    box.queue()[0]!.respond({ action: 'accept', content: { name: 'Ada' } })
    expect(await answer).toEqual({ action: 'decline' })
    expect(hooks.notifications).toContainEqual({
      type: 'elicitation_response',
      message: 'Elicitation response for server "srv": decline',
    })
  })

  test('an error while queueing answers cancel', async () => {
    const pair = await linkedPair({
      beforeConnect: client =>
        registerElicitationHandler(client, 'srv', () => {
          throw new Error('state exploded')
        }),
    })
    pairs.push(pair)
    expect(await pair.server.elicitInput(FORM)).toEqual({ action: 'cancel' })
  })

  test('a request the server cancels resolves the queued one as cancel', async () => {
    const { server, box } = await wired()
    // The v1 SDK ignores a cancel for request id 0 (`if (!requestId)`), so
    // spend id 0 on a ping first.
    await server.ping()
    const controller = new AbortController()
    const answer = server.elicitInput(FORM, { signal: controller.signal })
    await waitUntil(() => box.queue().length === 1)
    const event = box.queue()[0]!
    controller.abort()
    await expect(answer).rejects.toThrow()
    await waitUntil(() => event.signal.aborted, 'client-side abort')
    await waitUntil(
      () => hooks.notifications.some(n => n.message === 'Elicitation response for server "srv": cancel'),
      'cancel response',
    )
  })
})

describe('registerElicitationHandler — url mode', () => {
  test('a URL elicitation is queued with the skip-confirmation waiting state', async () => {
    const { server, box } = await wired()
    const answer = server.elicitInput(URL_PARAMS)
    await waitUntil(() => box.queue().length === 1)
    const event = box.queue()[0]!
    expect(event.params).toMatchObject(URL_PARAMS)
    expect(event.waitingState).toEqual({ actionLabel: 'Skip confirmation' })
    event.respond({ action: 'accept' })
    expect(await answer).toEqual({ action: 'accept' })

    const pre = hooks.inputs.find(i => i.hook_event_name === 'Elicitation') as Record<string, unknown>
    expect(pre).toMatchObject({ mode: 'url', url: URL_PARAMS.url, elicitation_id: 'el-1' })
    const post = hooks.inputs.find(i => i.hook_event_name === 'ElicitationResult') as Record<string, unknown>
    expect(post).toMatchObject({ mode: 'url', elicitation_id: 'el-1', action: 'accept' })
  })

  test('the completion notification marks only the matching queued URL elicitation', async () => {
    const { server, box } = await wired()
    void server.elicitInput(URL_PARAMS).catch(() => {})
    void server.elicitInput({ ...URL_PARAMS, elicitationId: 'el-2' }).catch(() => {})
    void server.elicitInput(FORM).catch(() => {})
    await waitUntil(() => box.queue().length === 3)

    await server.createElicitationCompletionNotifier('el-2')()
    await waitUntil(() => box.queue().some(e => e.completed), 'completed flag')
    const byId = box.queue().map(e => ('elicitationId' in e.params ? e.params.elicitationId : 'form'))
    const completed = box.queue().map(e => e.completed === true)
    expect(byId).toEqual(['el-1', 'el-2', 'form'])
    expect(completed).toEqual([false, true, false])
    expect(hooks.notifications).toContainEqual({
      type: 'elicitation_complete',
      message: 'MCP server "srv" confirmed elicitation el-2 complete',
    })
    for (const e of box.queue()) e.respond({ action: 'cancel' })
  })

  test('a completion for an unknown elicitation leaves the state untouched', async () => {
    const { server, box } = await wired()
    const before = box.get()
    await server.createElicitationCompletionNotifier('nobody')()
    await waitUntil(() => hooks.notifications.some(n => n.type === 'elicitation_complete'))
    expect(box.get()).toBe(before)
  })

  test('a completion from another server does not match', async () => {
    const box = appStateBox()
    const pair = await linkedPair({
      beforeConnect: client => registerElicitationHandler(client, 'srv', box.set),
    })
    pairs.push(pair)
    box.set(prev => ({
      ...prev,
      elicitation: {
        queue: [
          {
            serverName: 'other',
            requestId: 1,
            params: URL_PARAMS,
            signal: new AbortController().signal,
            respond: () => {},
          },
        ],
      },
    }))
    await pair.server.createElicitationCompletionNotifier('el-1')()
    await waitUntil(() => hooks.notifications.some(n => n.type === 'elicitation_complete'))
    expect(box.queue()[0]!.completed).toBeUndefined()
  })
})

describe('registerElicitationHandler — capability', () => {
  test('a client without the elicitation capability registers nothing and does not throw', async () => {
    const client = new Client({ name: 'c', version: '0' }, { capabilities: {} })
    const box = appStateBox()
    expect(() => registerElicitationHandler(client, 'srv', box.set)).not.toThrow()
  })

  test('with elicitation:{} (form only) a URL request is refused before the handler', async () => {
    const box = appStateBox()
    let server!: Server
    const pair = await linkedPair({
      clientCapabilities: { elicitation: {} },
      setupServer: s => {
        server = s
      },
      beforeConnect: client => registerElicitationHandler(client, 'srv', box.set),
    })
    pairs.push(pair)
    // The server-side guard reads the declared capability first.
    await expect(server.elicitInput(URL_PARAMS)).rejects.toThrow('Client does not support url elicitation.')
    expect(box.queue()).toHaveLength(0)
  })
})

describe('runElicitationHooks / runElicitationResultHooks', () => {
  const signal = new AbortController().signal

  test('without hooks: no hook answer, and the result passes through', async () => {
    expect(await runElicitationHooks('srv', FORM, signal)).toBeUndefined()
    const result = { action: 'accept' as const, content: { a: 1 } }
    expect(await runElicitationResultHooks('srv', result, signal, 'form')).toBe(result)
  })

  test('a hook that declines is reported as decline, without its content', async () => {
    hooks.answer('Elicitation', {
      hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline', content: { x: 1 } },
    })
    expect(await runElicitationHooks('srv', FORM, signal)).toEqual({ action: 'decline' })
  })

  test('a hook that cancels is reported as cancel', async () => {
    hooks.answer('Elicitation', {
      hookSpecificOutput: { hookEventName: 'Elicitation', action: 'cancel' },
    })
    expect(await runElicitationHooks('srv', URL_PARAMS, signal)).toEqual({
      action: 'cancel',
      content: undefined,
    })
  })

  test('a result hook can replace the content', async () => {
    hooks.answer('ElicitationResult', {
      hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'accept', content: { b: 2 } },
    })
    expect(
      await runElicitationResultHooks('srv', { action: 'accept', content: { a: 1 } }, signal, 'url', 'el-9'),
    ).toEqual({ action: 'accept', content: { b: 2 } })
    const post = hooks.inputs.find(i => i.hook_event_name === 'ElicitationResult') as Record<string, unknown>
    expect(post).toMatchObject({ elicitation_id: 'el-9', mode: 'url', content: { a: 1 } })
  })
})
