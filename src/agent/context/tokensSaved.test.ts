import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  getBytesSaved,
  recordBytesSaved,
  resetBytesSaved,
} from 'src/agent/context/tokensSaved.js'
import { maybeCompactToolResult } from 'src/agent/tools/toolResultSummarizer.js'
import {
  processPreMappedToolResultBlock,
  unlinkSessionSpillDir,
} from 'src/agent/tools/toolResultStorage.js'
import { resetCostState } from 'src/agent/cost-tracker.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'

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

  test('the lossless regroup records the reduction', () => {
    const listing = Array.from({ length: 200 }, (_, i) => `src/tools/shared/outputFilter/Bash/file${i}.ts`).join('\n')
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'probe-compact',
      content: listing,
      is_error: false,
    }
    const out = maybeCompactToolResult(block, GLOB_TOOL_NAME)
    expect(String(out.content)).toStartWith('<tool-result-compacted')
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
      // A tool nothing compacts goes straight to the page past its line.
      const out = await processPreMappedToolResultBlock(
        block,
        { name: 'PersistProbeTool', maxResultSizeChars: 50_000 },
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
