import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages.js'

// Snapshot real modules before mocking so afterAll restores don't pick up our
// own overrides through live bindings (testing.md cross-file mock leak rules).
const realSideQueryNS = { ...(await import('src/agent/sideQuery.js')) }

type SideQueryBehavior =
  | { kind: 'tool_use' }
  | { kind: 'text_only' }
  | { kind: 'throw'; error: unknown }

const state: { behavior: SideQueryBehavior; calls: number } = {
  behavior: { kind: 'tool_use' },
  calls: 0,
}

function fakeMessage(blocks: unknown[]): BetaMessage {
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: 'probe-model',
    content: blocks,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as BetaMessage
}

const sideQueryMock = async (): Promise<BetaMessage> => {
  state.calls++
  switch (state.behavior.kind) {
    case 'tool_use':
      return fakeMessage([
        {
          type: 'tool_use',
          id: 'toolu_probe',
          name: 'classify_result',
          input: { thinking: 'benign', shouldBlock: false, reason: 'probe' },
        },
      ])
    case 'text_only':
      return fakeMessage([{ type: 'text', text: 'ok=true' }])
    case 'throw':
      throw state.behavior.error
  }
}

// Mock BOTH specifier forms (testing.md: Bun pre-applies module mocks for the
// whole run; a sibling file importing the same module via the src/ alias would
// otherwise bypass the mock).
mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryNS,
  sideQuery: sideQueryMock,
}))
mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryNS,
  sideQuery: sideQueryMock,
}))

afterAll(() => {
  mock.module('src/agent/sideQuery.js', () => realSideQueryNS)
  mock.module('src/agent/sideQuery.js', () => realSideQueryNS)
})

const { probeClassifierCapability } = await import('src/permissions/classifierProbe.js')
const {
  __setClassifierProbeStoreDirForTests,
  readClassifierProbe,
} = await import('src/permissions/classifierProbeStore.js')

let fakeConfigDir: string

beforeEach(() => {
  fakeConfigDir = mkdtempSync(join(tmpdir(), 'classifier-probe-'))
  __setClassifierProbeStoreDirForTests(fakeConfigDir)
  state.behavior = { kind: 'tool_use' }
  state.calls = 0
})

afterEach(() => {
  __setClassifierProbeStoreDirForTests(undefined)
  rmSync(fakeConfigDir, { recursive: true, force: true })
})

describe('probeClassifierCapability', () => {
  test('passes when the model returns the forced tool_use block, and persists ok', async () => {
    const result = await probeClassifierCapability({
      key: 'k1',
      model: 'some-model',
    })
    expect(result.ok).toBe(true)
    expect(state.calls).toBe(1)
    expect(readClassifierProbe('k1')?.ok).toBe(true)
  })

  test('fails when the response has no tool_use block, and persists the failure', async () => {
    state.behavior = { kind: 'text_only' }
    const result = await probeClassifierCapability({
      key: 'k1',
      model: 'some-model',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('no tool_use block')
    expect(readClassifierProbe('k1')?.ok).toBe(false)
  })

  test('fails (not throws) when the API call errors, and persists the failure', async () => {
    state.behavior = { kind: 'throw', error: new Error('boom') }
    const result = await probeClassifierCapability({
      key: 'k1',
      model: 'some-model',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('boom')
    expect(readClassifierProbe('k1')?.ok).toBe(false)
  })

  test('rethrows abort errors instead of caching them', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    state.behavior = { kind: 'throw', error: abortError }
    await expect(
      probeClassifierCapability({ key: 'k1', model: 'some-model' }),
    ).rejects.toThrow('aborted')
    expect(readClassifierProbe('k1')).toBeUndefined()
  })
})
