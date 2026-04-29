import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { compressToolHistory, getTiers } from './compressToolHistory.js'

// Mock the two dependencies so tests are deterministic and don't read disk config.
const mockState = {
  enabled: true,
  effectiveWindow: 100_000,
}

// Spread into a plain object so afterAll restores the original bindings,
// not the mock factory's exports. Live ESM namespaces mutate after
// mock.module replaces the factory.
const realConfig_compress = { ...(await import('../../utils/config.js')) }
mock.module('../../utils/config.js', () => ({
  ...realConfig_compress,
  getGlobalConfig: () => ({
    toolHistoryCompressionEnabled: mockState.enabled,
  }),
}))

mock.module('../compact/autoCompact.js', () => ({
  getEffectiveContextWindowSize: () => mockState.effectiveWindow,
}))

beforeEach(() => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
})

afterEach(() => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
})

afterAll(() => {
  mock.module('../../utils/config.js', () => realConfig_compress)
})

type Block = Record<string, unknown>
type Msg = { role: string; content: Block[] | string }

function bigText(n: number): string {
  return 'x'.repeat(n)
}

function buildToolExchange(id: number, resultLength: number): Msg[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `toolu_${id}`,
          name: 'Read',
          input: { file_path: `/path/to/file${id}.ts` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `toolu_${id}`,
          content: bigText(resultLength),
        },
      ],
    },
  ]
}

function buildConversation(numToolExchanges: number, resultLength = 5_000): Msg[] {
  const out: Msg[] = [{ role: 'user', content: 'Initial request' }]
  for (let i = 0; i < numToolExchanges; i++) {
    out.push(...buildToolExchange(i, resultLength))
  }
  return out
}

function getResultMessages(messages: Msg[]): Msg[] {
  return messages.filter(
    m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
  )
}

function getResultBlock(msg: Msg): Block {
  return (msg.content as Block[]).find((b: any) => b.type === 'tool_result') as Block
}

function getResultText(msg: Msg): string {
  const block = getResultBlock(msg)
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
  }
  return ''
}

// ---------- getTiers ----------

test('getTiers: < 16k window → recent=2, mid=3', () => {
  expect(getTiers(8_000)).toEqual({ recent: 2, mid: 3 })
})

test('getTiers: 16k–32k → recent=3, mid=5', () => {
  expect(getTiers(20_000)).toEqual({ recent: 3, mid: 5 })
})

test('getTiers: 32k–64k → recent=4, mid=8', () => {
  expect(getTiers(48_000)).toEqual({ recent: 4, mid: 8 })
})

test('getTiers: 64k–128k (Copilot gpt-4o) → recent=5, mid=10', () => {
  expect(getTiers(100_000)).toEqual({ recent: 5, mid: 10 })
})

test('getTiers: 128k–256k (Copilot Claude) → recent=8, mid=15', () => {
  expect(getTiers(200_000)).toEqual({ recent: 8, mid: 15 })
})

test('getTiers: 256k–500k → recent=12, mid=25', () => {
  expect(getTiers(400_000)).toEqual({ recent: 12, mid: 25 })
})

test('getTiers: ≥ 500k (gpt-4.1 1M) → recent=25, mid=50', () => {
  expect(getTiers(1_000_000)).toEqual({ recent: 25, mid: 50 })
})

// ---------- master switch ----------

test('pass-through when toolHistoryCompressionEnabled is false', () => {
  mockState.enabled = false
  const messages = buildConversation(20)
  const result = compressToolHistory(messages, 'gpt-4o')
  expect(result).toBe(messages) // same reference (no transformation)
})

test('pass-through when total tool_results <= recent tier', () => {
  // 100k effective → recent=5; only 4 exchanges → no compression
  const messages = buildConversation(4)
  const result = compressToolHistory(messages, 'gpt-4o')
  expect(result).toBe(messages)
})

// ---------- per-tier behavior ----------

test('recent tier: tool_result content untouched', () => {
  // 100k effective → recent=5, mid=10. With 6 exchanges, only the oldest is touched.
  const messages = buildConversation(6, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // Last 5 should be untouched (full 5000 chars)
  for (let i = resultMsgs.length - 5; i < resultMsgs.length; i++) {
    expect(getResultText(resultMsgs[i]).length).toBe(5_000)
  }
})

test('mid tier: long content truncated to MID_MAX_CHARS with marker', () => {
  // 100k → recent=5, mid=10. 10 exchanges: 5 recent + 5 mid (none old).
  const messages = buildConversation(10, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // First 5 are mid tier — should be truncated to ~2000 chars + marker
  for (let i = 0; i < 5; i++) {
    const text = getResultText(resultMsgs[i])
    expect(text).toContain('[…truncated')
    expect(text).toContain('chars from tool history]')
    // Should be roughly 2000 chars + marker (under 2200)
    expect(text.length).toBeLessThan(2_200)
    expect(text.length).toBeGreaterThan(2_000)
  }
})

test('mid tier: short content (< MID_MAX_CHARS) untouched', () => {
  const messages = buildConversation(10, 500) // 500 < MID_MAX_CHARS
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  for (let i = 0; i < 5; i++) {
    expect(getResultText(resultMsgs[i])).toBe(bigText(500))
  }
})

test('old tier: content replaced with stub [name args={...} → N chars omitted]', () => {
  // 100k → recent=5, mid=10, old=rest. 20 exchanges → 5 old + 10 mid + 5 recent.
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // First 5 are old tier — should be stubs
  for (let i = 0; i < 5; i++) {
    const text = getResultText(resultMsgs[i])
    expect(text).toMatch(/^\[Read args=\{.*\} → 5000 chars omitted\]$/)
  }
})

test('old tier: stub args truncated to 200 chars', () => {
  const longArg = bigText(500)
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'Bash',
          input: { command: longArg },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_x', content: 'output' },
      ],
    },
    // Pad with enough recent exchanges to push the above into old tier
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)
  const text = getResultText(resultMsgs[0])

  // Stub format: [Bash args=<json≤200chars> → N chars omitted]
  // The args portion (between args= and →) must be ≤ 200 chars.
  const argsMatch = text.match(/args=(.*?) →/)
  expect(argsMatch).not.toBeNull()
  expect(argsMatch![1].length).toBeLessThanOrEqual(200)
})

test('old tier: orphan tool_result (no matching tool_use) falls back to "tool"', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    // Orphan: tool_result without matching tool_use in history
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'orphan_id', content: 'data' },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)
  const text = getResultText(resultMsgs[0])

  expect(text).toMatch(/^\[tool args=\{\} → 4 chars omitted\]$/)
})

// ---------- structural preservation ----------

test('tool_use blocks always preserved', () => {
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')

  const useCount = (msgs: Msg[]) =>
    msgs.reduce((sum, m) => {
      if (!Array.isArray(m.content)) return sum
      return sum + m.content.filter((b: any) => b.type === 'tool_use').length
    }, 0)

  expect(useCount(result as Msg[])).toBe(useCount(messages))
})

test('text blocks always preserved', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reasoning before tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: bigText(5000) }],
    },
    ...buildConversation(20, 5_000).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const assistantMsg = (result as Msg[])[1]
  const textBlock = (assistantMsg.content as Block[]).find((b: any) => b.type === 'text')

  expect(textBlock).toEqual({ type: 'text', text: 'reasoning before tool' })
})

test('thinking blocks always preserved', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: bigText(5000) }],
    },
    ...buildConversation(20, 5_000).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const assistantMsg = (result as Msg[])[1]
  const thinking = (assistantMsg.content as Block[]).find((b: any) => b.type === 'thinking')

  expect(thinking).toEqual({
    type: 'thinking',
    thinking: 'internal reasoning',
    signature: 'sig',
  })
})

test('non-array content (string) handled gracefully', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'plain string content' },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  expect((result as Msg[])[0].content).toBe('plain string content')
})

test('empty content array handled gracefully', () => {
  const messages: Msg[] = [
    { role: 'user', content: [] },
    ...buildConversation(20, 100).slice(1),
  ]
  expect(() => compressToolHistory(messages, 'gpt-4o')).not.toThrow()
})

// ---------- message shape compatibility ----------

test('wrapped shape ({ message: { role, content } }) handled', () => {
  type WrappedMsg = { message: { role: string; content: Block[] | string } }
  const wrap = (m: Msg): WrappedMsg => ({ message: { role: m.role, content: m.content } })
  const messages = buildConversation(20, 5_000).map(wrap)
  const result = compressToolHistory(messages as any, 'gpt-4o')

  // First wrapped tool-result message should have stub content (old tier)
  const firstResultMsg = (result as WrappedMsg[]).find(
    m =>
      Array.isArray(m.message.content) &&
      m.message.content.some((b: any) => b.type === 'tool_result'),
  )
  const block = (firstResultMsg!.message.content as Block[]).find(
    (b: any) => b.type === 'tool_result',
  ) as Block
  const text = ((block.content as Block[])[0] as any).text
  expect(text).toMatch(/^\[Read args=.*→ 5000 chars omitted\]$/)
})

test('flat shape ({ role, content }) handled', () => {
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  expect(getResultText(resultMsgs[0])).toMatch(/^\[Read args=.*→ 5000 chars omitted\]$/)
})

// ---------- tier boundary correctness ----------

test('tier boundaries: 6 exchanges → 1 mid + 5 recent (recent=5)', () => {
  const messages = buildConversation(6, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // Oldest: mid (truncated)
  expect(getResultText(resultMsgs[0])).toContain('[…truncated')
  // Last 5: untouched
  for (let i = 1; i < 6; i++) {
    expect(getResultText(resultMsgs[i]).length).toBe(5_000)
  }
})

test('tier boundaries: 16 exchanges → 1 old + 10 mid + 5 recent', () => {
  const messages = buildConversation(16, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // Oldest 1: stub (old tier)
  expect(getResultText(resultMsgs[0])).toMatch(/^\[Read .*chars omitted\]$/)
  // Next 10: mid (truncated)
  for (let i = 1; i < 11; i++) {
    expect(getResultText(resultMsgs[i])).toContain('[…truncated')
  }
  // Last 5: untouched
  for (let i = 11; i < 16; i++) {
    expect(getResultText(resultMsgs[i]).length).toBe(5_000)
  }
})

test('large window (1M) with 30 exchanges: all untouched (recent=25 ≥ 30 - 5)', () => {
  // ≥500k → recent=25, mid=50. 30 exchanges → 5 mid + 25 recent. None old.
  mockState.effectiveWindow = 1_000_000
  const messages = buildConversation(30, 5_000)
  const result = compressToolHistory(messages, 'gpt-4.1')
  const resultMsgs = getResultMessages(result)

  // Last 25: untouched
  for (let i = 5; i < 30; i++) {
    expect(getResultText(resultMsgs[i]).length).toBe(5_000)
  }
})

// ---------- attribute preservation ----------

test('is_error flag preserved in mid tier', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_err',
          is_error: true,
          content: bigText(5_000),
        },
      ],
    },
    // Pad with enough recent exchanges to push the above into MID tier
    ...buildConversation(10, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)
  const block = getResultBlock(resultMsgs[0]) as { is_error?: boolean; content: unknown }

  expect(block.is_error).toBe(true)
  expect(getResultText(resultMsgs[0])).toContain('[…truncated')
})

test('is_error flag preserved in old tier (stub)', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_err',
          is_error: true,
          content: bigText(5_000),
        },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)
  const block = getResultBlock(resultMsgs[0]) as { is_error?: boolean; content: unknown }

  expect(block.is_error).toBe(true)
  expect(getResultText(resultMsgs[0])).toMatch(/^\[Bash .*chars omitted\]$/)
})

// ---------- COMPACTABLE_TOOLS filter ----------

test('non-compactable tool (e.g. Task/Agent) is NEVER compressed', () => {
  // Build conversation where the OLDEST exchange uses a non-compactable tool name
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'task_1', name: 'Task', input: { goal: 'plan' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'task_1', content: bigText(5_000) },
      ],
    },
    // Pad with 20 compactable exchanges to push Task into old tier
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // First tool_result is for Task (non-compactable) → must remain full
  expect(getResultText(resultMsgs[0]).length).toBe(5_000)
  expect(getResultText(resultMsgs[0])).not.toContain('chars omitted')
  expect(getResultText(resultMsgs[0])).not.toContain('[…truncated')
})

test('mcp__ prefixed tools ARE compactable (matches microCompact behavior)', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'mcp_1', name: 'mcp__github__get_issue', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'mcp_1', content: bigText(5_000) },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // MCP tool result is compressed (gets stub since it's in old tier)
  expect(getResultText(resultMsgs[0])).toMatch(/^\[mcp__github__get_issue .*chars omitted\]$/)
})

// ---------- skip already-cleared blocks ----------

test('blocks already cleared by microCompact are NOT re-compressed', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'cleared_1', name: 'Read', input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'cleared_1',
          content: '[Old tool result content cleared]', // microCompact's marker
        },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)

  // Already-cleared marker survives untouched (no double processing)
  expect(getResultText(resultMsgs[0])).toBe('[Old tool result content cleared]')

  // Corresponding tool_use.input also left alone — not stubbed
  const clearedUseBlock = (result[1].content as Block[]).find((b: any) => b.type === 'tool_use')
  expect((clearedUseBlock?.input as any)?._stub).toBeUndefined()
})

// ---------- tool_use.input compression ----------

function getUseBlocks(msg: Msg): Block[] {
  if (!Array.isArray(msg.content)) return []
  return (msg.content as Block[]).filter((b: any) => b.type === 'tool_use')
}

function getUseMessages(messages: Msg[]): Msg[] {
  return messages.filter(
    m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'),
  )
}

test('old-tier tool_use.input is stubbed with char count', () => {
  // 100k → recent=5, mid=10. 20 exchanges → 5 old.
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsgs = getUseMessages(result as Msg[])

  // First 5 are old tier — their inputs should be stubbed
  for (let i = 0; i < 5; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
  }
})

test('recent-tier tool_use.input preserved (mid-tier is now stubbed)', () => {
  // 100k → recent=5, mid=10. 20 exchanges → 5 old + 10 mid + 5 recent.
  // Mid-tier inputs are now stubbed; only recent-tier inputs are fully preserved.
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsgs = getUseMessages(result as Msg[])

  // Last 5 (recent tier) must still have original object input
  for (let i = 15; i < 20; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect((useBlock.input as any).file_path).toMatch(/^\/path\/to\/file\d+\.ts$/)
  }

  // Mid-tier (indices 5–14) must have stubbed inputs
  for (let i = 5; i < 15; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
  }
})

test('non-compactable tool_use (Agent) input never stubbed even in old tier', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'agent_1', name: 'Agent', input: { task: 'do something' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'agent_1', content: bigText(5_000) },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsg = (result as Msg[])[1]
  const useBlock = getUseBlocks(useMsg)[0]

  expect(typeof useBlock.input).toBe('object')
  expect((useBlock.input as any).task).toBe('do something')
})

test('disabled toggle: no tool_use.input changed', () => {
  mockState.enabled = false
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')

  // Should be same reference — no transformation at all
  expect(result).toBe(messages)
  const useMsgs = getUseMessages(result as Msg[])
  for (const msg of useMsgs) {
    for (const block of getUseBlocks(msg)) {
      expect(typeof block.input).toBe('object')
    }
  }
})

test('parallel tool calls: only old-tier inputs stubbed, recent untouched', () => {
  // 100k → recent=5, mid=10. We need 16 exchanges total so position 0 is old-tier.
  // First assistant turn has 2 parallel tool_use blocks: toolu_A, toolu_B.
  // Padding pushes them into old-tier. toolu_C is in a separate later exchange
  // that lands in recent-tier — only toolu_A and toolu_B should be stubbed.
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    // First assistant turn with 3 parallel tool calls
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_A', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/b.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_A', content: bigText(5_000) },
        { type: 'tool_result', tool_use_id: 'toolu_B', content: bigText(5_000) },
      ],
    },
    // Pad 14 more compactable exchanges to push above into old tier
    ...buildConversation(14, 100).slice(1),
    // One recent-tier exchange using toolu_C
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_C', name: 'Read', input: { file_path: '/c.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_C', content: bigText(5_000) },
      ],
    },
  ]
  const result = compressToolHistory(messages, 'gpt-4o')

  // Find the assistant message with toolu_A and toolu_B
  const firstAssistant = (result as Msg[])[1]
  const blocks = getUseBlocks(firstAssistant)
  const blockA = blocks.find((b: any) => b.id === 'toolu_A')!
  const blockB = blocks.find((b: any) => b.id === 'toolu_B')!

  expect(typeof blockA.input).toBe('object')
  expect(blockA.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
  expect(typeof blockB.input).toBe('object')
  expect(blockB.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })

  // Find the assistant message with toolu_C (recent tier)
  const lastAssistant = (result as Msg[]).slice().reverse().find(
    (m: Msg) => Array.isArray(m.content) && (m.content as Block[]).some((b: any) => b.id === 'toolu_C'),
  )!
  const blockC = getUseBlocks(lastAssistant).find((b: any) => b.id === 'toolu_C')!

  expect(typeof blockC.input).toBe('object')
  expect((blockC.input as any).file_path).toBe('/c.ts')
})

test('wrapped assistant message: tool_use.input stubbed via message.content (not content)', () => {
  type WrappedMsg = { message: { role: string; content: Block[] | string } }
  const wrap = (m: { role: string; content: Block[] | string }): WrappedMsg => ({
    message: { role: m.role, content: m.content },
  })
  // 100k → recent=5, mid=10. 20 wrapped exchanges → 5 old-tier.
  const messages = buildConversation(20, 5_000).map(wrap)
  const result = compressToolHistory(messages as any, 'gpt-4o')

  // Find the first wrapped assistant message (position 0 is old-tier)
  const firstAssistant = (result as WrappedMsg[]).find(
    m =>
      Array.isArray(m.message.content) &&
      m.message.content.some((b: any) => b.type === 'tool_use'),
  )!

  // Stub must be written into message.content, not a top-level content key
  expect((firstAssistant as any).content).toBeUndefined()
  const useBlock = (firstAssistant.message.content as Block[]).find(
    (b: any) => b.type === 'tool_use',
  ) as Block
  expect(typeof useBlock.input).toBe('object')
  expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
})

test('orphan tool_use (no matching tool_result) input left untouched even in old-tier position', () => {
  // Build a conversation where the very first assistant message has a tool_use
  // with no corresponding tool_result anywhere. Pad with 20 normal exchanges to
  // push it deep into old-tier position, but buildOldTierToolUseIds only adds
  // ids that appear in old-tier tool_result messages, so the orphan id is never
  // added to the set.
  const orphanInput = { file_path: '/orphan.ts' }
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_orphan',
          name: 'Read',
          input: orphanInput,
        },
      ],
    },
    // No user message with tool_result for toolu_orphan here — it is orphaned.
    ...buildConversation(20, 5_000).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')

  const orphanAssistant = (result as Msg[])[1]
  const useBlock = getUseBlocks(orphanAssistant)[0]

  expect(typeof useBlock.input).toBe('object')
  expect((useBlock.input as any).file_path).toBe('/orphan.ts')
  expect((useBlock.input as any)._stub).toBeUndefined()
})

// ---------- mid-tier tool_use.input compression ----------

test('mid-tier tool_use.input is stubbed with char count', () => {
  // 100k → recent=5, mid=10. 20 exchanges → 5 old + 10 mid + 5 recent.
  // mid-tier inputs (indices 5-14) must now be stubbed.
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsgs = getUseMessages(result as Msg[])

  // Indices 5..14 are mid-tier — their inputs should be stubbed
  for (let i = 5; i < 15; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
  }
})

test('recent-tier tool_use.input preserved while mid-tier is stubbed', () => {
  // 100k → recent=5, mid=10. 20 exchanges → 5 old + 10 mid + 5 recent.
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsgs = getUseMessages(result as Msg[])

  // Last 5 (recent tier) must still have original object input
  for (let i = 15; i < 20; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect((useBlock.input as any).file_path).toMatch(/^\/path\/to\/file\d+\.ts$/)
  }
})

test('non-compactable tool (Agent) in mid-tier: input never stubbed', () => {
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'agent_mid', name: 'Agent', input: { task: 'mid task' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'agent_mid', content: bigText(5_000) },
      ],
    },
    // Pad with 9 more compactable exchanges to push agent_mid into mid-tier
    ...buildConversation(9, 100).slice(1),
    // Add 5 recent-tier exchanges
    ...buildConversation(5, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const useMsg = (result as Msg[])[1]
  const useBlock = getUseBlocks(useMsg)[0]

  expect(typeof useBlock.input).toBe('object')
  expect((useBlock.input as any).task).toBe('mid task')
  expect((useBlock.input as any)._stub).toBeUndefined()
})

test('disabled toggle: mid-tier tool_use.input unchanged', () => {
  mockState.enabled = false
  const messages = buildConversation(20, 5_000)
  const result = compressToolHistory(messages, 'gpt-4o')

  // Should be same reference — no transformation at all
  expect(result).toBe(messages)
  const useMsgs = getUseMessages(result as Msg[])
  // Mid-tier indices (5-14) must not be stubbed
  for (let i = 5; i < 15; i++) {
    const useBlock = getUseBlocks(useMsgs[i])[0]
    expect(typeof useBlock.input).toBe('object')
    expect((useBlock.input as any)._stub).toBeUndefined()
  }
})

test('parallel tool calls: old+mid inputs stubbed, recent preserved', () => {
  // 100k → recent=5, mid=10. We build: 1 old-tier exchange (toolu_A+toolu_B),
  // 9 mid-tier exchanges to fill out mid, 5 recent-tier exchanges (toolu_C).
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    // Old-tier: 2 parallel tool calls
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_A2', name: 'Read', input: { file_path: '/a2.ts' } },
        { type: 'tool_use', id: 'toolu_B2', name: 'Read', input: { file_path: '/b2.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_A2', content: bigText(5_000) },
        { type: 'tool_result', tool_use_id: 'toolu_B2', content: bigText(5_000) },
      ],
    },
    // Mid-tier: 9 more compactable exchanges (positions 1-9 from oldest)
    ...buildConversation(9, 100).slice(1),
    // Recent: 1 exchange that lands in recent tier
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_C2', name: 'Read', input: { file_path: '/c2.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_C2', content: bigText(5_000) },
      ],
    },
    ...buildConversation(4, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')

  // Old-tier: toolu_A2 and toolu_B2 should be stubbed
  const firstAssistant = (result as Msg[])[1]
  const blocks = getUseBlocks(firstAssistant)
  const blockA = blocks.find((b: any) => b.id === 'toolu_A2')!
  const blockB = blocks.find((b: any) => b.id === 'toolu_B2')!

  expect(blockA.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
  expect(blockB.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })

  // Recent-tier: toolu_C2 should be untouched
  const recentAssistant = (result as Msg[]).slice().reverse().find(
    (m: Msg) => Array.isArray(m.content) && (m.content as Block[]).some((b: any) => b.id === 'toolu_C2'),
  )!
  const blockC = getUseBlocks(recentAssistant).find((b: any) => b.id === 'toolu_C2')!

  expect(typeof blockC.input).toBe('object')
  expect((blockC.input as any).file_path).toBe('/c2.ts')
})

test('wrapped assistant message: mid-tier tool_use.input stubbed via message.content', () => {
  type WrappedMsg = { message: { role: string; content: Block[] | string } }
  const wrap = (m: { role: string; content: Block[] | string }): WrappedMsg => ({
    message: { role: m.role, content: m.content },
  })
  // 100k → recent=5, mid=10. 20 wrapped exchanges → indices 5-14 mid-tier.
  const messages = buildConversation(20, 5_000).map(wrap)
  const result = compressToolHistory(messages as any, 'gpt-4o')

  // Find the 6th assistant message (index 5 in useMsgs) which is mid-tier
  const allAssistants = (result as WrappedMsg[]).filter(
    m =>
      Array.isArray(m.message.content) &&
      m.message.content.some((b: any) => b.type === 'tool_use'),
  )
  // First 5 are old-tier, next 10 are mid-tier — check index 5 (first mid)
  const midAssistant = allAssistants[5]

  // Stub must be written into message.content, not a top-level content key
  expect((midAssistant as any).content).toBeUndefined()
  const useBlock = (midAssistant.message.content as Block[]).find(
    (b: any) => b.type === 'tool_use',
  ) as Block
  expect(typeof useBlock.input).toBe('object')
  expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
})

test('orphan mid-tier tool_use (no matching tool_result): input untouched', () => {
  // An orphan tool_use has no tool_result to pull its id into buildMidTierToolUseIds,
  // so even deep in mid-tier position its input must survive intact.
  const orphanInput = { file_path: '/mid-orphan.ts' }
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_mid_orphan',
          name: 'Read',
          input: orphanInput,
        },
      ],
    },
    // No tool_result for toolu_mid_orphan — orphaned.
    // Pad with exchanges that push into mid-tier (5 old + starts of mid)
    ...buildConversation(9, 5_000).slice(1),
    // Add 5 recent-tier exchanges so orphan lands in mid-tier range
    ...buildConversation(5, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')

  const orphanAssistant = (result as Msg[])[1]
  const useBlock = getUseBlocks(orphanAssistant)[0]

  expect(typeof useBlock.input).toBe('object')
  expect((useBlock.input as any).file_path).toBe('/mid-orphan.ts')
  expect((useBlock.input as any)._stub).toBeUndefined()
})

// ---------- mid-tier tool_use.input compression: savings ----------

import { describe } from 'bun:test'

describe('mid-tier tool_use.input compression: savings', () => {
  test('quantifies savings per tool type in mid-tier', () => {
    // Build one exchange each for Read, Bash, Grep in mid-tier position.
    // Push them to mid-tier by adding 5 old-tier + 5 recent-tier padding.
    const readInput = { file_path: '/home/user/projects/claudio/src/services/api/compressToolHistory.ts' }
    const bashInput = { command: 'find /home/user/projects -name "*.ts" | xargs grep -l "compressToolHistory" | head -20' }
    const grepInput = { pattern: 'buildMidTierToolUseIds', path: '/home/user/projects/claudio/src', glob: '**/*.ts' }

    const messages: Msg[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tr_read', name: 'Read', input: readInput }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr_read', content: bigText(5_000) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tr_bash', name: 'Bash', input: bashInput }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr_bash', content: bigText(5_000) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tr_grep', name: 'Grep', input: grepInput }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr_grep', content: bigText(5_000) }] },
      // 2 more mid-tier exchanges to ensure the 3 above land in mid (not old)
      ...buildConversation(7, 100).slice(1),
      // 5 recent-tier exchanges
      ...buildConversation(5, 100).slice(1),
    ]
    const result = compressToolHistory(messages, 'gpt-4o')
    const useMsgs = getUseMessages(result as Msg[])

    // First 3 assistant messages are our Read/Bash/Grep mid-tier calls
    for (const msg of useMsgs.slice(0, 3)) {
      const useBlock = getUseBlocks(msg)[0]
      expect(useBlock.input).toMatchObject({ _stub: expect.stringContaining('chars omitted') })
    }

    // Each stub is dramatically smaller than the original serialized input
    const readOrigSize = JSON.stringify(readInput).length
    const readStubSize = JSON.stringify((getUseBlocks(useMsgs[0])[0].input as any)).length
    expect(readStubSize).toBeLessThan(readOrigSize)
  })

  test('estimated savings for typical session (10 mid-tier calls)', () => {
    // 100k → recent=5, mid=10. 20 exchanges → 5 old + 10 mid + 5 recent.
    // Each mid-tier tool_use has a realistic input (~80 chars for file_path).
    const longPath = '/home/user/projects/claudio/src/services/api/compressToolHistory.ts'
    const messages = buildConversation(20, 5_000)
    // Replace tool_use inputs in indices 5-14 (mid-tier) with realistic long paths
    // buildConversation uses file_path: /path/to/fileN.ts (~22 chars) — that's fine,
    // we measure savings on the actual result.

    const before = JSON.stringify(getUseMessages(messages as Msg[]).slice(5, 15).map(m => getUseBlocks(m)[0].input))
    const result = compressToolHistory(messages, 'gpt-4o')
    const after = JSON.stringify(getUseMessages(result as Msg[]).slice(5, 15).map(m => getUseBlocks(m)[0].input))

    const totalBefore = before.length
    const totalAfter = after.length
    // Each original input is ~22 chars serialized; stub is ~36 chars — for short inputs
    // the stubs are actually larger. Use a custom long-input session to show real savings.

    // Build a session where mid-tier inputs are large (longPath).
    const longMessages: Msg[] = [
      { role: 'user', content: 'start' },
      ...Array.from({ length: 20 }, (_, i) => [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `lng_${i}`, name: 'Read', input: { file_path: longPath + i.toString().padStart(3, '0') } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `lng_${i}`, content: bigText(5_000) }],
        },
      ]).flat() as Msg[],
    ]
    const longResult = compressToolHistory(longMessages, 'gpt-4o')
    const longUseBefore = getUseMessages(longMessages as Msg[]).slice(5, 15)
    const longUseAfter = getUseMessages(longResult as Msg[]).slice(5, 15)

    const longBefore = longUseBefore.reduce((s, m) => s + JSON.stringify(getUseBlocks(m)[0].input).length, 0)
    const longAfter = longUseAfter.reduce((s, m) => s + JSON.stringify(getUseBlocks(m)[0].input).length, 0)

    // longPath ≈ 75 chars + index → ~78 chars per input. Stub ≈ 36 chars.
    // 10 calls × (78 - 36) = ~420 chars saved → well over 100 estimated tokens
    expect(longBefore - longAfter).toBeGreaterThan(500)
    const savedTokens = Math.floor((longBefore - longAfter) / 4) // ~4 chars/token
    expect(savedTokens).toBeGreaterThan(100)
  })

  test('cumulative savings grow linearly with input size', () => {
    // For each input size, confirm savings ≈ inputChars - stubSize
    const sizes = [100, 500, 1_000, 5_000]
    for (const inputChars of sizes) {
      const largeInput = { data: 'x'.repeat(inputChars) }
      const messages: Msg[] = [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tlu_sz', name: 'Read', input: largeInput }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tlu_sz', content: bigText(5_000) }],
        },
        // Push into mid-tier: 4 more mid + 5 recent
        ...buildConversation(9, 100).slice(1),
        ...buildConversation(5, 100).slice(1),
      ]
      const result = compressToolHistory(messages, 'gpt-4o')
      const useMsg = (result as Msg[])[1]
      const useBlock = getUseBlocks(useMsg)[0]

      const originalSize = JSON.stringify(largeInput).length
      const stubSize = JSON.stringify(useBlock.input).length
      const savings = originalSize - stubSize

      // Savings should be positive for all input sizes tested
      expect(savings).toBeGreaterThan(0)
      // The stub format is `{ _stub: "input: N chars omitted" }` where N = originalSize.
      // Compute expected stub size independently from the input, not from the output,
      // so a format change (e.g. embedding more data) actually fails this assertion.
      const expectedStubSize = JSON.stringify({ _stub: `input: ${originalSize} chars omitted` }).length
      expect(Math.abs(stubSize - expectedStubSize)).toBeLessThan(5)
    }
  })
})

test('extra block attributes (e.g. cache_control) preserved across rewrites', () => {
  const cacheControl = { type: 'ephemeral' }
  const messages: Msg[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_cc', name: 'Read', input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_cc',
          cache_control: cacheControl,
          content: bigText(5_000),
        },
      ],
    },
    ...buildConversation(20, 100).slice(1),
  ]
  const result = compressToolHistory(messages, 'gpt-4o')
  const resultMsgs = getResultMessages(result)
  const block = getResultBlock(resultMsgs[0]) as { cache_control?: unknown }

  // The custom attribute survived the stub rewrite via ...block spread
  expect(block.cache_control).toEqual(cacheControl)
})
