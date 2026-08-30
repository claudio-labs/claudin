import { describe, expect, test } from 'bun:test'
import { CACHE_WHITELIST } from 'src/agent/tools/toolResultCache.js'
import { ContainerTool } from 'src/tools/ContainerTool/ContainerTool.js'
import {
  containerOpFailed,
  formatContainerResult,
} from 'src/tools/ContainerTool/format.js'
import { CONTAINER_OPS } from 'src/tools/ContainerTool/types.js'
import type { ContainerToolOutput } from 'src/tools/ContainerTool/types.js'

function output(over: Partial<ContainerToolOutput> = {}): ContainerToolOutput {
  return {
    op: 'ps',
    command: 'docker ps',
    exitCode: 0,
    output: 'legendarr-legendarr-1  up',
    diagnosis: null,
    durationMs: 12,
    ...over,
  }
}

describe('registration', () => {
  test('is deferred, and the flag is a constant', () => {
    // A conditional presence — "only when a compose file exists", "only while a
    // stack is up" — would toggle the tool list, which sits at the head of the
    // cached prefix. LSPTool is deliberately not flagged `isLsp` for the same
    // reason. `shouldDefer` must therefore never be computed.
    expect(ContainerTool.shouldDefer).toBe(true)
    expect(ContainerTool.isEnabled()).toBe(true)
  })

  test('read ops are read-only and concurrency-safe, mutating ops are neither', () => {
    expect(ContainerTool.isReadOnly({ op: 'ps' })).toBe(true)
    expect(ContainerTool.isReadOnly({ op: 'logs' })).toBe(true)
    expect(ContainerTool.isReadOnly({ op: 'wait' })).toBe(true)
    expect(ContainerTool.isReadOnly({ op: 'down' })).toBe(false)
    expect(ContainerTool.isReadOnly({ op: 'prune' })).toBe(false)
    expect(ContainerTool.isConcurrencySafe({ op: 'build' })).toBe(false)
  })

  test('every op is accepted by the input schema', () => {
    for (const op of CONTAINER_OPS) {
      expect(ContainerTool.inputSchema.safeParse({ op }).success).toBe(true)
    }
    expect(ContainerTool.inputSchema.safeParse({ op: 'nope' }).success).toBe(false)
  })
})

describe('the tool-result cache guardrail', () => {
  test('Container is NOT cacheable', () => {
    // That cache keys on the input alone with a 30s TTL, so a second `ps` or
    // `logs` inside the window would replay the first answer — which would
    // quietly destroy the real-time property this tool exists for. The cache is
    // an allowlist, so we are safe by default; this pins it.
    expect(CACHE_WHITELIST.has('Container')).toBe(false)
    expect(CACHE_WHITELIST.has(ContainerTool.name)).toBe(false)
  })
})

describe('the failure guardrail', () => {
  test('a failure keeps its raw text, with the diagnosis prepended', () => {
    const raw = 'Error response from daemon: driver failed programming\nbind: address already in use'
    const text = formatContainerResult(
      output({
        op: 'up',
        exitCode: 1,
        output: raw,
        diagnosis: {
          kind: 'port-conflict',
          summary: 'port 8000 is already in use',
          evidence: 'bind: address already in use',
        },
      }),
    )
    expect(text.startsWith('port 8000 is already in use')).toBe(true)
    // Every line of the original survives — a failure is never budgeted.
    for (const line of raw.split('\n')) expect(text).toContain(line)
  })

  test('a non-zero exit is reported as an error to the model', () => {
    expect(containerOpFailed(output({ exitCode: 1 }))).toBe(true)
    expect(containerOpFailed(output())).toBe(false)
  })

  test('a wait that ran out is an error even though the exit code is 0', () => {
    expect(
      containerOpFailed(
        output({
          op: 'wait',
          wait: {
            satisfied: false,
            observedState: 'starting',
            observedHealth: 'starting',
            waitedMs: 120_000,
          },
        }),
      ),
    ).toBe(true)
  })

  test('a timed-out wait reports the last observed state, never a bare timeout', () => {
    const text = formatContainerResult(
      output({
        op: 'wait',
        output: '',
        wait: {
          satisfied: false,
          observedState: 'restarting',
          observedHealth: '',
          waitedMs: 30_000,
        },
      }),
    )
    expect(text).toContain('restarting')
    expect(text).not.toBe('timed out')
  })

  test('a stall is reported as an observation, not as a hang', () => {
    const text = formatContainerResult(
      output({
        op: 'build',
        stall: {
          reason: 'idle',
          ranMs: 240_000,
          silentMs: 185_000,
          lastLine: '#7 12.4 Collecting numpy',
        },
      }),
    )
    expect(text).toContain('silent for')
    expect(text).toContain('#7 12.4 Collecting numpy')
    expect(text.toLowerCase()).not.toContain('hang')
  })

  test('a warm build is reported as a no-op, not as a clean build', () => {
    const text = formatContainerResult(
      output({
        op: 'build',
        output: 'up to date, nothing rebuilt',
      }),
    )
    expect(text).toContain('nothing rebuilt')
  })
})
