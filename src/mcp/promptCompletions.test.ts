import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { createPromptArgumentCompleter } from 'src/mcp/promptCompletions.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import * as log from 'src/shared/log.js'

type CompleteParams = {
  ref: { type: string; name: string }
  argument: { name: string; value: string }
  context?: { arguments: Record<string, string> }
}
type Complete = (
  params: CompleteParams,
  options?: { timeout?: number },
) => Promise<{ completion: { values: string[] } }>

function fakeConnection(
  complete: Complete,
  capabilities: Record<string, unknown> = { completions: {} },
  name = 'srv',
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    capabilities,
    client: { complete },
    config: { type: 'sdk', name, scope: 'local' },
    cleanup: async () => {},
  } as unknown as ConnectedMCPServer
}

function answering(values: string[]) {
  return mock<Complete>(async () => ({ completion: { values } }))
}

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

describe('createPromptArgumentCompleter', () => {
  test('asks completion/complete for the prompt argument, with a timeout', async () => {
    const complete = answering(['Alice', 'Alicia'])
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'greet')
    expect(await values('name', 'Al', {})).toEqual(['Alice', 'Alicia'])
    expect(complete.mock.calls).toEqual([
      [{ ref: { type: 'ref/prompt', name: 'greet' }, argument: { name: 'name', value: 'Al' } }, { timeout: 5000 }],
    ])
  })

  test('sends the filled arguments as context', async () => {
    const complete = answering(['hi'])
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'greet')
    await values('greeting', 'h', { name: 'Alice' })
    expect(complete.mock.calls[0]![0].context).toEqual({ arguments: { name: 'Alice' } })
  })

  test('a server without completions is never asked', async () => {
    const complete = answering(['x'])
    const values = createPromptArgumentCompleter(fakeConnection(complete, {}), 'greet')
    expect(await values('name', '', {})).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  test('values are sanitized, deduplicated, one-line, non-empty and at most 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `v${i}`)
    const complete = answering(['a\u200B', 'a', 'two\nlines', '', ...many])
    const values = await createPromptArgumentCompleter(fakeConnection(complete), 'p')('x', '', {})
    expect(values.slice(0, 3)).toEqual(['a', 'v0', 'v1'])
    expect(values).toHaveLength(100)
  })

  test('a repeat is answered from the cache, whatever order the filled args come in', async () => {
    const complete = answering(['x'])
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'p')
    await values('c', 'q', { a: '1', b: '2' })
    expect(await values('c', 'q', { b: '2', a: '1' })).toEqual(['x'])
    expect(complete).toHaveBeenCalledTimes(1)
    await values('c', 'qq', { a: '1', b: '2' })
    await values('c', 'q', { a: '1' })
    expect(complete).toHaveBeenCalledTimes(3)
  })

  test('identical requests in flight share one round trip', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const complete = mock<Complete>(async () => {
      await gate
      return { completion: { values: ['x'] } }
    })
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'p')
    const first = values('a', 'q', {})
    const second = values('a', 'q', {})
    release()
    expect(await Promise.all([first, second])).toEqual([['x'], ['x']])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  test('the cache keeps the 64 most recently used answers', async () => {
    const complete = answering(['x'])
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'p')
    for (let i = 0; i < 64; i++) await values('a', `k${i}`, {})
    await values('a', 'k0', {}) // a hit moves k0 to the newest place
    await values('a', 'k64', {}) // evicts k1, the oldest
    expect(complete).toHaveBeenCalledTimes(65)
    await values('a', 'k0', {})
    expect(complete).toHaveBeenCalledTimes(65)
    await values('a', 'k1', {})
    expect(complete).toHaveBeenCalledTimes(66)
  })

  test('a failure is logged, answers [] and is not cached', async () => {
    const logged = spyOn(log, 'logMCPDebug').mockImplementation(() => {})
    spies.push(logged)
    const complete = mock<Complete>(async () => {
      throw new Error('boom')
    })
    const values = createPromptArgumentCompleter(fakeConnection(complete), 'greet')
    expect(await values('name', 'A', {})).toEqual([])
    expect(await values('name', 'A', {})).toEqual([])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(logged.mock.calls[0]).toEqual([
      'srv',
      "Completing argument 'name' of prompt 'greet' failed: boom",
    ])
  })

  test('asks through the connection the resolver hands back', async () => {
    const stale = answering(['stale'])
    const fresh = answering(['fresh'])
    const resolved: ConnectedMCPServer[] = []
    const original = fakeConnection(stale)
    const values = createPromptArgumentCompleter(original, 'p', async current => {
      resolved.push(current)
      return fakeConnection(fresh)
    })
    expect(await values('a', '', {})).toEqual(['fresh'])
    expect(resolved).toEqual([original])
    expect(stale).not.toHaveBeenCalled()
  })

  test('a resolver that cannot reconnect answers []', async () => {
    spies.push(spyOn(log, 'logMCPDebug').mockImplementation(() => {}))
    const values = createPromptArgumentCompleter(fakeConnection(answering(['x'])), 'p', async () => {
      throw new Error('MCP server "srv" is not connected')
    })
    expect(await values('a', '', {})).toEqual([])
  })
})
