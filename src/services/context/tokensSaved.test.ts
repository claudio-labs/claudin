import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  getBytesSaved,
  recordBytesSaved,
  resetBytesSaved,
} from 'src/services/context/tokensSaved.js'
import { maybeSummarizeToolResult } from 'src/services/tools/toolResultSummarizer.js'
import {
  processPreMappedToolResultBlock,
  unlinkSessionSpillDir,
} from 'src/services/tools/toolResultStorage.js'
import { resetCostState } from 'src/cost-tracker.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

// ---------------------------------------------------------------------------
// Unit — the accumulator itself
// ---------------------------------------------------------------------------

describe('tokensSaved accumulator', () => {
  beforeEach(() => resetBytesSaved())

  test('records a positive delta', () => {
    recordBytesSaved(1000, 200)
    expect(getBytesSaved()).toBe(800)
  })

  test('accumulates across calls', () => {
    recordBytesSaved(1000, 200)
    recordBytesSaved(500, 100)
    expect(getBytesSaved()).toBe(1200)
  })

  test('ignores a non-positive delta (no-win transform)', () => {
    recordBytesSaved(200, 200) // delta 0
    recordBytesSaved(100, 300) // delta negative (marker overhead)
    expect(getBytesSaved()).toBe(0)
  })

  test('ignores non-finite inputs', () => {
    recordBytesSaved(Number.NaN, 100)
    recordBytesSaved(1000, Number.POSITIVE_INFINITY)
    expect(getBytesSaved()).toBe(0)
  })

  test('reset zeroes the total', () => {
    recordBytesSaved(1000, 200)
    resetBytesSaved()
    expect(getBytesSaved()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Chokepoint guards — each test fails if its recordBytesSaved wire is removed.
// ---------------------------------------------------------------------------

describe('tokensSaved chokepoints', () => {
  let savedSummarizerEnabled: boolean | undefined

  beforeEach(() => {
    resetBytesSaved()
    savedSummarizerEnabled = getGlobalConfig().toolResultSummarizerEnabled
    saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: true }))
  })

  afterEach(() => {
    saveGlobalConfig(c => ({
      ...c,
      toolResultSummarizerEnabled: savedSummarizerEnabled ?? true,
    }))
  })

  test('summarizer string path records the reduction', () => {
    const big =
      Array.from({ length: 500 }, (_, i) => `output line ${i} padding padding`).join('\n') +
      '\n'
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'probe-str',
      content: big,
      is_error: false,
    }
    const out = maybeSummarizeToolResult(block, BASH_TOOL_NAME)
    expect(out.content).not.toBe(big) // it actually summarized
    expect(getBytesSaved()).toBeGreaterThan(0)
  })

  test('summarizer array path records the reduction', () => {
    const bigText =
      Array.from({ length: 500 }, (_, i) => `agent step ${i} padding padding`).join('\n') +
      '\n'
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'probe-arr',
      content: [{ type: 'text' as const, text: bigText }],
      is_error: false,
    }
    const out = maybeSummarizeToolResult(block, AGENT_TOOL_NAME)
    expect(out.content).not.toBe(block.content) // summarized to a string marker
    expect(getBytesSaved()).toBeGreaterThan(0)
  })

  test('large-output persistence records the reduction', async () => {
    const big = 'X'.repeat(60_000)
    const block = {
      type: 'tool_result' as const,
      tool_use_id: `probe-persist-${Date.now()}`,
      content: big,
      is_error: false,
    }
    try {
      // Tool name absent from the summarizer dispatch → goes straight to the
      // >50KB persistence path.
      const out = await processPreMappedToolResultBlock(
        block,
        'PersistProbeTool',
        50_000,
      )
      expect(String(out.content)).toContain('<persisted-output>')
      expect(getBytesSaved()).toBeGreaterThan(0)
    } finally {
      await unlinkSessionSpillDir(getSessionId())
    }
  })
})

// ---------------------------------------------------------------------------
// Reset wiring — resetCostState() (cost-tracker) must zero the counter.
// ---------------------------------------------------------------------------

test('resetCostState clears the tokens-saved counter', () => {
  recordBytesSaved(1000, 100)
  expect(getBytesSaved()).toBeGreaterThan(0)
  resetCostState()
  expect(getBytesSaved()).toBe(0)
})
