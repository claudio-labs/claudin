import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import {
  _getPendingMarkerAdvanceForTesting,
  _getPendingMessageMutationForTesting,
  _getWireBodiesForTesting,
  buildCacheBreakReason,
  CACHE_STRICT_MARKER,
  checkResponseForCacheBreak,
  notifyCacheDeletion,
  readServerCacheMissReason,
  readThinkingDrops,
  recordMarkerAdvance,
  recordPromptState,
  recordRenderedMessages,
  recordWireBody,
  resetPromptCacheBreakDetection,
  summarizeAppliedContextEdits,
} from 'src/providers/cache/promptCacheBreakDetection.js'
import {
  getCurrentTurnCacheBreaks,
  resetSessionCacheStats,
} from 'src/providers/cache/cacheStatsTracker.js'
import type { AgentId } from 'src/shared/types/ids.js'

// Minimal PendingChanges — everything false/empty except what a test flips.
function changes(
  overrides: Partial<Parameters<typeof buildCacheBreakReason>[0] & object>,
): NonNullable<Parameters<typeof buildCacheBreakReason>[0]> {
  return {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    modelChanged: false,
    fastModeChanged: false,
    cacheControlChanged: false,
    globalCacheStrategyChanged: false,
    betasChanged: false,
    autoModeChanged: false,
    overageChanged: false,
    effortChanged: false,
    extraBodyChanged: false,
    addedToolCount: 0,
    removedToolCount: 0,
    systemCharDelta: 0,
    addedTools: [],
    removedTools: [],
    changedToolSchemas: [],
    previousModel: 'm',
    newModel: 'm',
    prevGlobalCacheStrategy: '',
    newGlobalCacheStrategy: '',
    addedBetas: [],
    removedBetas: [],
    prevEffortValue: '',
    newEffortValue: '',
    buildPrevDiffableContent: () => '',
    ...overrides,
  }
}

describe('summarizeAppliedContextEdits', () => {
  test('undefined for no envelope, an empty edit list, or zero-token edits', () => {
    expect(summarizeAppliedContextEdits(undefined)).toBeUndefined()
    expect(summarizeAppliedContextEdits(null)).toBeUndefined()
    expect(summarizeAppliedContextEdits({ applied_edits: [] })).toBeUndefined()
    expect(
      summarizeAppliedContextEdits({
        applied_edits: [
          {
            type: 'clear_tool_uses_20250919',
            cleared_input_tokens: 0,
            cleared_tool_uses: 0,
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('sums tokens and tool uses across edits', () => {
    expect(
      summarizeAppliedContextEdits({
        applied_edits: [
          {
            type: 'clear_tool_uses_20250919',
            cleared_input_tokens: 41_000,
            cleared_tool_uses: 14,
          },
          {
            type: 'clear_thinking_20251015',
            cleared_input_tokens: 2_000,
            cleared_thinking_turns: 1,
          },
        ],
      }),
    ).toEqual({ clearedInputTokens: 43_000, clearedToolUses: 14 })
  })
})

describe('buildCacheBreakReason', () => {
  test('a deferred tool entering the array is named, not "server-side"', () => {
    // The discovery-driven break: before this change the deferred tools were
    // dropped from the hash, so this case read as
    // "likely server-side (prompt unchanged, <5min gap)".
    const reason = buildCacheBreakReason(
      changes({
        toolSchemasChanged: true,
        addedToolCount: 2,
        addedTools: ['EnterPlanMode', 'ExitPlanMode'],
      }),
      undefined,
      30_000,
    )
    expect(reason).toBe(
      'tools changed (+2/-0 tools: +EnterPlanMode,+ExitPlanMode)',
    )
  })

  test('caps the named tools at four', () => {
    const reason = buildCacheBreakReason(
      changes({
        toolSchemasChanged: true,
        addedToolCount: 5,
        addedTools: ['A', 'B', 'C', 'D', 'E'],
      }),
      undefined,
      30_000,
    )
    expect(reason).toBe('tools changed (+5/-0 tools: +A,+B,+C,+D,…)')
  })

  test('a server clear is labeled as such and wins over TTL guesses', () => {
    const reason = buildCacheBreakReason(
      null,
      { clearedInputTokens: 41_500, clearedToolUses: 14 },
      30_000,
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 14 tool uses, -42k tokens, expected)',
    )
  })

  test('a server clear that coincides with a client change lists both', () => {
    const reason = buildCacheBreakReason(
      changes({ effortChanged: true, prevEffortValue: 'low', newEffortValue: 'max' }),
      { clearedInputTokens: 10_000, clearedToolUses: 3 },
      30_000,
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 3 tool uses, -10k tokens, expected), also: effort changed (low → max)',
    )
  })

  test('unchanged prompt falls through to the TTL / server-side labels', () => {
    expect(buildCacheBreakReason(null, undefined, 30_000)).toBe(
      'likely server-side (prompt unchanged, <5min gap)',
    )
    expect(buildCacheBreakReason(null, undefined, 6 * 60_000)).toBe(
      'possible 5min TTL expiry (prompt unchanged)',
    )
    expect(buildCacheBreakReason(null, undefined, 61 * 60_000)).toBe(
      'possible 1h TTL expiry (prompt unchanged)',
    )
    expect(buildCacheBreakReason(null, undefined, null)).toBe('unknown cause')
  })

  test('a mutated message is named instead of falling through to "server-side"', () => {
    const reason = buildCacheBreakReason(null, undefined, 30_000, {
      index: 17,
      total: 230,
      role: 'user',
      blockTypes: 'tool_result',
      prevJson: '',
      newJson: '',
    })
    expect(reason).toBe(
      'messages mutated at 17/230 (user: tool_result) — client-side prefix rewrite',
    )
  })

  test('a server clear still wins over a message mutation', () => {
    const reason = buildCacheBreakReason(
      null,
      { clearedInputTokens: 10_000, clearedToolUses: 3 },
      30_000,
      { index: 1, total: 5, role: 'user', blockTypes: 'tool_result', prevJson: '', newJson: '' },
    )
    expect(reason).toBe(
      'server clear_tool_uses (cleared 3 tool uses, -10k tokens, expected)',
    )
  })

  test('a marker that advanced past the lookback window is a placement miss, not "server-side"', () => {
    // Session ab1e69e8: every hash unchanged, cache_read fell to the system
    // breakpoint, and the only thing that moved was the marker — 20+ positions
    // past the previous write, which is further than the API looks back.
    const reason = buildCacheBreakReason(null, undefined, 30_000, null, {
      positions: 27,
      lagPlaced: false,
    })
    expect(reason).toBe(
      'marker advanced 27 positions past the last write (lookback window is 20) — client-side placement',
    )
  })

  test('with the lag marker placed the same collapse is named a server miss', () => {
    const reason = buildCacheBreakReason(null, undefined, 30_000, null, {
      positions: 27,
      lagPlaced: true,
    })
    expect(reason).toBe(
      'marker advanced 27 positions past the last write with the lag marker placed — server-side miss',
    )
  })

  test('an advance inside the window changes nothing', () => {
    expect(
      buildCacheBreakReason(null, undefined, 30_000, null, {
        positions: 19,
        lagPlaced: false,
      }),
    ).toBe('likely server-side (prompt unchanged, <5min gap)')
  })

  test('a client-side change still wins over the marker advance', () => {
    const reason = buildCacheBreakReason(
      changes({ effortChanged: true, prevEffortValue: 'low', newEffortValue: 'max' }),
      undefined,
      30_000,
      null,
      { positions: 40, lagPlaced: false },
    )
    expect(reason).toBe('effort changed (low → max)')
  })
})

const SOURCE = 'repl_main_thread' as const

function user(text: string, cacheControl = false): BetaMessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        ...(cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
  }
}

function toolResult(id: string, text: string): BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  }
}

function assistant(text: string): BetaMessageParam {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function prime(model = 'claude-opus-5'): void {
  recordPromptState({
    system: [{ type: 'text', text: 'sys' }],
    toolSchemas: [],
    querySource: SOURCE,
    model,
  })
}

const AGENT_SOURCE = 'agent:builtin:Code' as const

function primeAgent(agentId: AgentId): void {
  recordPromptState({
    system: [{ type: 'text', text: 'agent sys' }],
    toolSchemas: [],
    querySource: AGENT_SOURCE,
    model: 'claude-opus-5',
    agentId,
  })
}

describe('recordRenderedMessages', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  test('a pure append is not a mutation', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), assistant('b')])
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      assistant('b'),
      user('c'),
    ])
    expect(_getPendingMessageMutationForTesting(SOURCE)).toBeNull()
  })

  test('a cache_control marker moving between turns is not a mutation', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a', true), assistant('b')])
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      assistant('b'),
      user('c', true),
    ])
    expect(_getPendingMessageMutationForTesting(SOURCE)).toBeNull()
  })

  test('the first message whose bytes changed is named with role and block types', () => {
    prime()
    const history = [
      user('ask'),
      assistant('reading'),
      toolResult('t1', 'full result'),
      assistant('done'),
    ]
    recordRenderedMessages(SOURCE, undefined, history)
    recordRenderedMessages(SOURCE, undefined, [
      history[0]!,
      history[1]!,
      toolResult('t1', '[clipped]'),
      history[3]!,
      user('next'),
    ])
    const mutation = _getPendingMessageMutationForTesting(SOURCE)
    expect(mutation).toMatchObject({
      index: 2,
      total: 4,
      role: 'user',
      blockTypes: 'tool_result',
    })
    expect(mutation?.prevJson).toContain('full result')
    expect(mutation?.newJson).toContain('[clipped]')
  })

  // streaming.ts used to render every request twice (once for a debug line),
  // and a withRetry attempt renders it again: the repeat compared the request
  // with itself and erased the mutation, so no live `[Cache:]` line ever named
  // one.
  test('rendering the same request again keeps the mutation it found', () => {
    prime()
    const history = [user('ask'), toolResult('t1', 'full result'), assistant('done')]
    recordRenderedMessages(SOURCE, undefined, history)
    const next = [history[0]!, toolResult('t1', '[clipped]'), history[2]!, user('next')]
    recordRenderedMessages(SOURCE, undefined, next)
    recordRenderedMessages(SOURCE, undefined, next)
    expect(_getPendingMessageMutationForTesting(SOURCE)).toMatchObject({
      index: 1,
      total: 3,
    })
  })

  test('an untracked source records nothing', () => {
    recordRenderedMessages('speculation', undefined, [user('a')])
    recordRenderedMessages('speculation', undefined, [user('b')])
    expect(_getPendingMessageMutationForTesting('speculation')).toBeNull()
  })

  test('a read drop after a mutation lands on the turn line with the message named', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), toolResult('t1', 'x')])
    // First response establishes the baseline read.
    await checkResponseForCacheBreak(SOURCE, 205_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [
      user('a'),
      toolResult('t1', 'y'),
      user('b'),
    ])
    await checkResponseForCacheBreak(SOURCE, 25_853, 182_825, [])
    expect(getCurrentTurnCacheBreaks()).toEqual([
      'messages mutated at 1/2 (user: tool_result) — client-side prefix rewrite — read 205k→25.9k, rewrote 182.8k',
    ])
    // The mutation is consumed: a healthy next response records nothing more.
    await checkResponseForCacheBreak(SOURCE, 208_678, 3_728, [])
    expect(getCurrentTurnCacheBreaks()).toHaveLength(1)
  })

  test('a small drop stays below the threshold and records no break', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, 100_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b')])
    await checkResponseForCacheBreak(SOURCE, 99_000, 1_000, [])
    expect(getCurrentTurnCacheBreaks()).toEqual([])
  })

  // Haiku 5.5 runs the main thread and the Explore/WebResearcher children, so
  // its breaks are reported; the older Haikus stay excluded.
  test.each([
    ['claude-haiku-5-5', 1],
    ['claude-haiku-4-5-20251001', 0],
  ] as const)('a break on %s is recorded %i time(s)', async (model, breaks) => {
    prime(model)
    recordRenderedMessages(SOURCE, undefined, [user('a'), toolResult('t1', 'x')])
    await checkResponseForCacheBreak(SOURCE, 205_000, 0, [])
    prime(model)
    recordRenderedMessages(SOURCE, undefined, [user('a'), toolResult('t1', 'y'), user('b')])
    await checkResponseForCacheBreak(SOURCE, 25_853, 182_825, [])
    expect(getCurrentTurnCacheBreaks()).toHaveLength(breaks)
  })

  test("a sub-agent's mutation is named without keeping its JSON", () => {
    const agentId = 'a-json' as AgentId
    primeAgent(agentId)
    recordRenderedMessages(AGENT_SOURCE, agentId, [user('a'), toolResult('t1', 'full')])
    recordRenderedMessages(AGENT_SOURCE, agentId, [
      user('a'),
      toolResult('t1', '[clipped]'),
      user('b'),
    ])
    const mutation = _getPendingMessageMutationForTesting(AGENT_SOURCE, agentId)
    expect(mutation).toMatchObject({ index: 1, total: 2, role: 'user', blockTypes: 'tool_result' })
    expect(mutation?.prevJson).toBe('')
    expect(mutation?.newJson).toContain('[clipped]')
  })
})

describe('thinking the server dropped', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  test('readThinkingDrops reads the thinking_dropped paths and nothing else', () => {
    expect(
      readThinkingDrops({
        input_transformations: [
          { type: 'thinking_dropped', path: 'messages.193.content.0', reason: 'prefix_binding_mismatch' },
          { type: 'something_else', path: 'messages.2.content.0' },
          { type: 'thinking_dropped', path: 'messages.195.content.1' },
        ],
      }),
    ).toEqual(['messages.193.content.0', 'messages.195.content.1'])
    expect(readThinkingDrops({ input_transformations: [] })).toEqual([])
    expect(readThinkingDrops({})).toEqual([])
    expect(readThinkingDrops(null)).toEqual([])
  })

  // Session e55e6d94 (2026-10-01): the turn opening after a Skill call had 22
  // thinking blocks dropped from messages.193 and the line said only
  // "likely server-side (prompt unchanged)". The server re-drops them on every
  // later request, so only the new ones are named.
  test('a break names the first dropped block, once', async () => {
    const dropped = ['messages.195.content.0', 'messages.193.content.0']
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, 258_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b')])
    await checkResponseForCacheBreak(SOURCE, 12_700, 238_800, [], undefined, null, null, null, dropped)
    expect(getCurrentTurnCacheBreaks()[0]).toStartWith(
      'server dropped 2 thinking blocks from messages.193; ',
    )
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b'), user('c')])
    await checkResponseForCacheBreak(SOURCE, 251_500, 1_000, [], undefined, null, null, null, dropped)
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b'), user('c'), user('d')])
    await checkResponseForCacheBreak(SOURCE, 12_700, 240_000, [], undefined, null, null, null, dropped)
    expect(getCurrentTurnCacheBreaks()).toHaveLength(2)
    expect(getCurrentTurnCacheBreaks()[1]).not.toContain('thinking')
  })
})

// Session 501d7261 (2026-09-28) ran batches of 10–12 concurrent sub-agents.
// With 10 tracked sources evicted by insertion order, the main thread went
// first and the `[Cache:]` line reported 9 of ~40 rewrites.
describe('tracking through a fan-out', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  async function mainRequest(read: number, written: number): Promise<void> {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, read, written, [])
  }

  test('the main thread keeps its state while sub-agents come and go', async () => {
    await mainRequest(200_000, 0)
    for (let i = 0; i < 20; i++) primeAgent(`a-${i}` as AgentId)
    // The main thread is still talking: that refreshes its entry.
    await mainRequest(201_000, 1_000)
    for (let i = 20; i < 40; i++) primeAgent(`a-${i}` as AgentId)
    await mainRequest(15_000, 190_000)
    expect(getCurrentTurnCacheBreaks()).toHaveLength(1)
  })

  test('a dozen concurrent sub-agents all keep their state', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c-${i}` as AgentId)
    await mainRequest(200_000, 0)
    for (const id of ids) {
      primeAgent(id)
      recordRenderedMessages(AGENT_SOURCE, id, [user('a')])
      await checkResponseForCacheBreak(AGENT_SOURCE, 100_000, 0, [], id)
    }
    for (const id of ids) {
      primeAgent(id)
      recordRenderedMessages(AGENT_SOURCE, id, [user('a')])
      await checkResponseForCacheBreak(AGENT_SOURCE, 12_000, 90_000, [], id)
    }
    expect(getCurrentTurnCacheBreaks()).toHaveLength(12)
  })

  test("a clip announced under the agent's id is an expected drop for that agent", async () => {
    const id = 'clip-1' as AgentId
    primeAgent(id)
    recordRenderedMessages(AGENT_SOURCE, id, [user('a')])
    await checkResponseForCacheBreak(AGENT_SOURCE, 400_000, 0, [], id)
    primeAgent(id)
    recordRenderedMessages(AGENT_SOURCE, id, [user('a')])
    notifyCacheDeletion(AGENT_SOURCE, id, 'relief clip (3 tool results, ~90k tokens, window lane)')
    await checkResponseForCacheBreak(AGENT_SOURCE, 12_000, 300_000, [], id)
    expect(getCurrentTurnCacheBreaks()).toEqual([])
  })
})

describe('the break flight recorder (CLAUDIN_CACHE_BREAK_DUMP)', () => {
  const saved = process.env.CLAUDIN_CACHE_BREAK_DUMP
  let dir: string

  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
    dir = mkdtempSync(join(tmpdir(), 'cache-break-dump-'))
    process.env.CLAUDIN_CACHE_BREAK_DUMP = dir
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_CACHE_BREAK_DUMP
    else process.env.CLAUDIN_CACHE_BREAK_DUMP = saved
    rmSync(dir, { recursive: true, force: true })
  })

  const body = (tail: string) => ({ model: 'm', messages: [user('a'), user(tail)] })

  async function request(tail: string, read: number, written: number): Promise<void> {
    prime()
    recordWireBody(SOURCE, undefined, body(tail))
    recordRenderedMessages(SOURCE, undefined, body(tail).messages)
    await checkResponseForCacheBreak(SOURCE, read, written, [])
  }

  test('a break writes the previous and the current body as they were sent', async () => {
    await request('b', 200_000, 0)
    await request('c', 15_000, 190_000)
    const index = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    expect(index).toHaveLength(1)
    const entry = JSON.parse(index[0]!) as { key: string; prev: string; cur: string; cacheRead: number }
    expect(entry).toMatchObject({ key: SOURCE, cacheRead: 15_000 })
    expect(JSON.parse(gunzipSync(readFileSync(entry.prev)).toString())).toEqual(body('b'))
    expect(JSON.parse(gunzipSync(readFileSync(entry.cur)).toString())).toEqual(body('c'))
  })

  test('a healthy response writes nothing', async () => {
    await request('b', 200_000, 0)
    await request('c', 201_000, 1_000)
    expect(readdirSync(dir)).toEqual([])
  })

  test('a retry of the same body does not push the previous one out', () => {
    recordWireBody(SOURCE, undefined, body('b'))
    recordWireBody(SOURCE, undefined, body('c'))
    recordWireBody(SOURCE, undefined, body('c'))
    expect(JSON.parse(_getWireBodiesForTesting(SOURCE)?.previous ?? 'null')).toEqual(body('b'))
  })

  test('off (unset or 0): nothing is held', () => {
    for (const value of [undefined, '0']) {
      resetPromptCacheBreakDetection()
      if (value === undefined) delete process.env.CLAUDIN_CACHE_BREAK_DUMP
      else process.env.CLAUDIN_CACHE_BREAK_DUMP = value
      recordWireBody(SOURCE, undefined, body('b'))
      expect(_getWireBodiesForTesting(SOURCE)).toBeUndefined()
    }
  })
})

describe('recordMarkerAdvance', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  test('the advance reaches the turn line and is consumed by the response', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, 200_011, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b')])
    recordMarkerAdvance(SOURCE, undefined, { positions: 25, lagPlaced: false })
    expect(_getPendingMarkerAdvanceForTesting(SOURCE)).toEqual({
      positions: 25,
      lagPlaced: false,
    })
    await checkResponseForCacheBreak(SOURCE, 27_532, 191_892, [])
    expect(getCurrentTurnCacheBreaks()).toEqual([
      'marker advanced 25 positions past the last write (lookback window is 20) — client-side placement — read 200k→27.5k, rewrote 191.9k',
    ])
    expect(_getPendingMarkerAdvanceForTesting(SOURCE)).toBeNull()
  })

  test('an untracked source records nothing', () => {
    recordMarkerAdvance('speculation', undefined, { positions: 99, lagPlaced: false })
    expect(_getPendingMarkerAdvanceForTesting('speculation')).toBeNull()
  })
})

// cache-diagnosis: the server names the cause itself when the request carried
// diagnostics.previous_message_id.
describe('the server cache-miss diagnosis', () => {
  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
  })

  test('reads it from a message_start message and from a message_delta event', () => {
    const diagnostics = {
      cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 182_825 },
    }
    expect(readServerCacheMissReason({ id: 'msg_01', diagnostics })).toEqual({
      type: 'messages_changed',
      cacheMissedInputTokens: 182_825,
    })
    expect(readServerCacheMissReason({ type: 'message_delta', diagnostics })).toEqual({
      type: 'messages_changed',
      cacheMissedInputTokens: 182_825,
    })
  })

  test('a hit, or anything malformed, reads as no diagnosis', () => {
    for (const source of [
      undefined,
      'x',
      {},
      { diagnostics: null },
      { diagnostics: { cache_miss_reason: null } },
      { diagnostics: { cache_miss_reason: { type: '' } } },
    ]) {
      expect(readServerCacheMissReason(source)).toBeNull()
    }
  })

  test('leads the break line when the request asked for it', async () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a')])
    await checkResponseForCacheBreak(SOURCE, 205_000, 0, [])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('a'), user('b')])
    await checkResponseForCacheBreak(SOURCE, 25_853, 182_825, [], undefined, null, null, {
      type: 'system_changed',
      cacheMissedInputTokens: 182_825,
    })
    expect(getCurrentTurnCacheBreaks()).toEqual([
      'server: system changed (182.8k missed); unknown cause — read 205k→25.9k, rewrote 182.8k',
    ])
  })
})

// CLAUDIN_CACHE_STRICT=1: the request-side verdict as an assertion, for the
// suites that drive the built CLI against a mock (no cache read to drop).
describe('strict mode', () => {
  const savedStrict = process.env.CLAUDIN_CACHE_STRICT
  let written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)

  beforeEach(() => {
    resetPromptCacheBreakDetection()
    resetSessionCacheStats()
    process.env.CLAUDIN_CACHE_STRICT = '1'
    written = []
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    process.stderr.write = realWrite
    if (savedStrict === undefined) delete process.env.CLAUDIN_CACHE_STRICT
    else process.env.CLAUDIN_CACHE_STRICT = savedStrict
  })

  const strictLines = () => written.filter(l => l.startsWith(CACHE_STRICT_MARKER))

  test('a message changed behind the tail is reported, with the bytes around it', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'full result')])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'other result'), user('next')])
    expect(strictLines()).toHaveLength(1)
    expect(strictLines()[0]).toContain('messages mutated at 1/2 (user: tool_result)')
    expect(strictLines()[0]).toContain('full result')
  })

  test('the system prompt or the tools changing mid-session is reported', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask')])
    recordPromptState({ system: [{ type: 'text', text: 'sys, changed' }], toolSchemas: [], querySource: SOURCE, model: 'claude-opus-5' })
    recordRenderedMessages(SOURCE, undefined, [user('ask'), user('next')])
    expect(strictLines()[0]).toContain('system prompt changed')
  })

  test('an append, an announced clip and a model switch are not', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'full result')])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'full result'), user('next')])
    notifyCacheDeletion(SOURCE, undefined, 'relief clip')
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', '[clipped]'), user('next'), user('more')])
    recordPromptState({ system: [{ type: 'text', text: 'sys for another model' }], toolSchemas: [], querySource: SOURCE, model: 'claude-sonnet-5' })
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', '[clipped]'), user('next'), user('more'), user('x')])
    expect(strictLines()).toEqual([])
  })

  // addCacheBreakpoints turns the marked message's string into a block; the
  // next request sends the string again. Same prompt (count_tokens, 10-01).
  test('a string content re-sent as its one text block is not a change', () => {
    prime()
    recordRenderedMessages(SOURCE, undefined, [
      { role: 'user', content: [{ type: 'text', text: 'ask', cache_control: { type: 'ephemeral' } }] },
    ])
    prime()
    recordRenderedMessages(SOURCE, undefined, [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
    ])
    prime()
    recordRenderedMessages(SOURCE, undefined, [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }] }] },
      { role: 'user', content: 'next' },
    ])
    expect(strictLines()).toEqual([])
  })

  // The fingerprint in block 0 moves between a session's first request and
  // the next (the first user message the fingerprint reads changes); the API
  // keeps the block out of the cache.
  test('a billing header with another fingerprint is not a system change', () => {
    const withHeader = (fp: string) =>
      recordPromptState({
        system: [
          { type: 'text', text: `x-anthropic-billing-header: cc_version=99.0.0.${fp}; cc_entrypoint=cli;` },
          { type: 'text', text: 'sys' },
        ],
        toolSchemas: [],
        querySource: SOURCE,
        model: 'claude-opus-5',
      })
    withHeader('be0')
    recordRenderedMessages(SOURCE, undefined, [user('ask')])
    withHeader('3af')
    recordRenderedMessages(SOURCE, undefined, [user('ask'), user('next')])
    expect(strictLines()).toEqual([])
  })

  test('off by default', () => {
    delete process.env.CLAUDIN_CACHE_STRICT
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'full result')])
    prime()
    recordRenderedMessages(SOURCE, undefined, [user('ask'), toolResult('t1', 'other'), user('next')])
    expect(strictLines()).toEqual([])
  })
})
