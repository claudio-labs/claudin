import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import {
  clearableToolNamesFromPool,
  getAPIContextManagement,
  TOOLS_CLEARABLE_RESULTS,
} from 'src/agent/cache/anthropic/apiMicrocompact.js'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'

// Every assertion below is profile-gated: `clear_thinking` only appears under
// `historyRedactionEnabled`, which is true for aggressive and false for retain.
// Left unpinned, the mode is `auto`, which resolves through
// `tryGetActiveProvider()` — so these tests passed or failed depending on
// whether some EARLIER file in the run had loaded a real provider profile from
// the developer's own ~/.claudin/settings.json. Six scripts under
// scripts/bench/tokens/ do exactly that, and CI has no settings file to load,
// which is why it only ever showed up locally.
const originalProfile = process.env.CLAUDIN_CACHE_PROFILE

beforeAll(() => {
  process.env.CLAUDIN_CACHE_PROFILE = 'aggressive'
  _resetCacheProfileForTesting()
})

afterAll(() => {
  if (originalProfile === undefined) {
    delete process.env.CLAUDIN_CACHE_PROFILE
  } else {
    process.env.CLAUDIN_CACHE_PROFILE = originalProfile
  }
  _resetCacheProfileForTesting()
})

describe('getAPIContextManagement', () => {
  test('returns undefined when thinking inactive', () => {
    const result = getAPIContextManagement({ hasThinking: false })
    expect(result).toBeUndefined()
  })

  test('keep: thinking_turns value:2 when hasThinking=true and redactThinking=false', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: false,
    })
    expect(result).toBeDefined()
    const thinkingEdit = result!.edits.find(
      e => e.type === 'clear_thinking_20251015',
    )
    expect(thinkingEdit).toBeDefined()
    expect(thinkingEdit).toEqual({
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: 2 },
    })
  })

  test('keep: thinking_turns value:1 when clearAllThinking=true', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: true,
    })
    expect(result).toBeDefined()
    const thinkingEdit = result!.edits.find(
      e => e.type === 'clear_thinking_20251015',
    )
    expect(thinkingEdit).toEqual({
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: 1 },
    })
  })

  test('skips thinking strategy when isRedactThinkingActive=true', () => {
    const result = getAPIContextManagement({
      hasThinking: true,
      isRedactThinkingActive: true,
      clearAllThinking: false,
    })
    // No thinking edit should appear; result may be undefined or have no thinking edit.
    if (result !== undefined) {
      const thinkingEdit = result.edits.find(
        e => e.type === 'clear_thinking_20251015',
      )
      expect(thinkingEdit).toBeUndefined()
    } else {
      expect(result).toBeUndefined()
    }
  })
})

describe('clearableToolNamesFromPool', () => {
  test('keeps only tools that opted in, sorted for byte-stability', () => {
    const pool = [
      { name: 'Read', clearableResult: true },
      { name: 'Edit' },
      { name: 'Bash', clearableResult: true },
      { name: 'Agent', clearableResult: false },
    ]
    expect(clearableToolNamesFromPool(pool)).toEqual(['Bash', 'Read'])
  })

  test('the built-in pool covers the legacy constant and the fork tools', async () => {
    // The list sent to the API is derived from the pool, so a tool dropping
    // its `clearableResult` flag (or a new verbose read-only tool forgetting
    // it) shows up here instead of silently shrinking what a server clear
    // can free.
    const { getAllBaseTools } = await import('src/tools/tools.js')
    const pool = getAllBaseTools()
    const poolNames = new Set(pool.map(t => t.name))
    const derived = clearableToolNamesFromPool(pool)
    // PowerShell (Windows-only) and Monitor (feature-gated) may be absent
    // from the base pool on this platform — only pool members are checked.
    for (const legacy of TOOLS_CLEARABLE_RESULTS) {
      if (poolNames.has(legacy)) expect(derived).toContain(legacy)
    }
    for (const forkTool of [
      'Git',
      'Build',
      'RunTests',
      'Typecheck',
      'LSP',
      'Container',
    ]) {
      expect(derived).toContain(forkTool)
    }
    if (poolNames.has('Monitor')) expect(derived).toContain('Monitor')
    // Mutation evidence must survive a clear.
    for (const keep of ['Edit', 'Write', 'apply_patch', 'Agent', 'ToolSearch']) {
      expect(derived).not.toContain(keep)
    }
  })
})

describe('getAPIContextManagement under retain', () => {
  beforeAll(() => {
    process.env.CLAUDIN_CACHE_PROFILE = 'retain'
    _resetCacheProfileForTesting()
  })
  afterAll(() => {
    process.env.CLAUDIN_CACHE_PROFILE = 'aggressive'
    _resetCacheProfileForTesting()
  })

  const clearToolUses = (names?: string[]) =>
    getAPIContextManagement({ clearableToolNames: names })?.edits.find(
      e => e.type === 'clear_tool_uses_20250919',
    )

  test('sends the pool-derived clear_tool_inputs list when given one', () => {
    const edit = clearToolUses(['Bash', 'Git', 'Read'])
    expect(edit).toBeDefined()
    expect(edit && 'clear_tool_inputs' in edit && edit.clear_tool_inputs).toEqual([
      'Bash',
      'Git',
      'Read',
    ])
  })

  test('falls back to the legacy constant when no pool list is given', () => {
    for (const edit of [clearToolUses(undefined), clearToolUses([])]) {
      expect(edit && 'clear_tool_inputs' in edit && edit.clear_tool_inputs).toEqual(
        TOOLS_CLEARABLE_RESULTS,
      )
    }
  })

  test('keeps the 140k/60k trigger band (near the cost-model optimum)', () => {
    const edit = clearToolUses(['Bash'])
    expect(edit && 'trigger' in edit && edit.trigger).toEqual({
      type: 'input_tokens',
      value: 140_000,
    })
    expect(edit && 'clear_at_least' in edit && edit.clear_at_least).toEqual({
      type: 'input_tokens',
      value: 80_000,
    })
  })
})
