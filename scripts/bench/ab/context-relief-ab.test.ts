import { afterEach, describe, expect, test } from 'bun:test'

import {
  armOrder,
  armProcessEnv,
  clippedIdsFrom,
  compactionGate,
  compactionsIn,
  modelWarning,
  parseArgs,
  pricedUsd,
  rereadsOutsideScript,
  summaryTable,
  type ArmResult,
  type UsageRow,
} from './context-relief-ab'

describe('parseArgs', () => {
  test('bin-a, bin-b, then the variants, each variant on bin-a with its own env', () => {
    const a = parseArgs([
      '--variant=clipall:CLAUDIN_RELIEF_CLIP_ALL=1',
      '--bin-a=dev:/tmp/x/claudin',
      '--bin-b=claude:/tmp/y/claude',
      '--variant=both:A=1,B=x=y',
      '--parallel',
      '--reps=5',
      '--window=140000',
    ])
    expect(a.arms).toEqual([
      { label: 'dev', path: '/tmp/x/claudin', env: {} },
      { label: 'claude', path: '/tmp/y/claude', env: {} },
      { label: 'clipall', path: '/tmp/x/claudin', env: { CLAUDIN_RELIEF_CLIP_ALL: '1' } },
      { label: 'both', path: '/tmp/x/claudin', env: { A: '1', B: 'x=y' } },
    ])
    expect(a).toMatchObject({ parallel: true, reps: 5, window: 140_000 })
  })

  test('defaults: one rep, one arm at a time, the native window', () => {
    expect(parseArgs(['--bin-a=dev:/x', '--bin-b=b:/y'])).toMatchObject({ reps: 1, parallel: false, window: null })
  })

  test('a variant with no bin-a, a pair without =, a repeated label and an unknown flag are errors', () => {
    expect(() => parseArgs(['--variant=x:A=1'])).toThrow('--bin-a')
    expect(() => parseArgs(['--bin-a=dev:/x', '--variant=x:A'])).toThrow('K=V')
    expect(() => parseArgs(['--bin-a=dev:/x', '--variant=:A=1'])).toThrow('<label>')
    expect(() => parseArgs(['--bin-a=dev:/x', '--variant=dev:A=1'])).toThrow('dev')
    expect(() => parseArgs(['--nope'])).toThrow('unknown arg')
  })
})

describe('armOrder', () => {
  test('rep r starts at arm r − 1 and wraps; with two arms it alternates', () => {
    expect(armOrder(['a', 'b', 'c'], 1)).toEqual(['a', 'b', 'c'])
    expect(armOrder(['a', 'b', 'c'], 2)).toEqual(['b', 'c', 'a'])
    expect(armOrder(['a', 'b', 'c'], 4)).toEqual(['a', 'b', 'c'])
    expect(armOrder(['a', 'b'], 2)).toEqual(['b', 'a'])
  })
})

describe('armProcessEnv', () => {
  const KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDIN_HOST_ONLY', 'CLAUDIN_CONFIG_DIR'] as const
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test("the host's CLI variables never reach an arm; the window reaches both CLIs; the arm's own win", () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.CLAUDIN_HOST_ONLY = '1'
    process.env.CLAUDIN_CONFIG_DIR = '/tmp/cfg'
    const env = armProcessEnv(
      { label: 'v', path: '/x', env: { CLAUDIN_RELIEF_CLIP_ALL: '1', CLAUDIN_DISABLE_EXPERIMENTAL_BETAS: 'false' } },
      140_000,
    )
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDIN_HOST_ONLY).toBeUndefined()
    expect(env.CLAUDIN_CONFIG_DIR).toBe('/tmp/cfg')
    expect(env.CLAUDIN_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(env.CLAUDIN_AUTO_COMPACT_WINDOW).toBe('140000')
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('140000')
    expect(env.CLAUDIN_RELIEF_CLIP_ALL).toBe('1')
    expect(env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS).toBe('false')
  })

  test('without --window no window variable is set; experimental betas stay off', () => {
    const env = armProcessEnv({ label: 'a', path: '/x', env: {} }, null)
    expect(env.CLAUDIN_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS).toBe('true')
  })
})

describe('pricedUsd', () => {
  test('sums the calls and prices 1h writes at the 1h rate (Sonnet 5.x: $2 / $10 / $4 / $0.2)', () => {
    const rows: UsageRow[] = [
      { in: 2, out: 1_000, cR: 0, cW: 16_000, cW5m: 0, cW1h: 16_000 },
      { in: 2, out: 500, cR: 16_000, cW: 2_000, cW5m: 0, cW1h: 2_000 },
    ]
    expect(pricedUsd('claude-sonnet-5-5', rows)).toBeCloseTo((4 * 2 + 1_500 * 10 + 18_000 * 4 + 16_000 * 0.2) / 1e6, 9)
  })

  test('a write the API did not split by TTL is priced at 5m', () => {
    const unsplit: UsageRow = { in: 0, out: 0, cR: 0, cW: 1_000_000, cW5m: 0, cW1h: 0 }
    expect(pricedUsd('claude-sonnet-5-5', [unsplit])).toBeCloseTo(2.5, 9)
  })
})

describe('clippedIdsFrom', () => {
  const line = (o: object) => JSON.stringify(o)

  test('the last clip-state wins, results plus inputs', () => {
    const transcript = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'clip-state', resultIds: ['a', 'b'], inputFields: {} }),
      'not json "clip-state"',
      line({ type: 'clip-state', resultIds: ['a', 'b', 'c'], inputFields: { p: ['patchText'] } }),
      '',
    ].join('\n')
    expect(clippedIdsFrom(transcript)).toBe(4)
  })

  test('no clip-state, or only a message quoting one, is 0', () => {
    expect(clippedIdsFrom(line({ type: 'assistant' }))).toBe(0)
    expect(clippedIdsFrom(line({ type: 'user', message: { content: '"clip-state"' } }))).toBe(0)
  })
})

describe('summaryTable', () => {
  function run(label: string, pricedUsd: number, clippedIds: number): ArmResult {
    return {
      label, bin: '/x', rep: 1, exitCode: 0, wallMs: 0, turnsDone: 30, turnsPlanned: 30, apiCalls: 66,
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rw: 0, prefixBreaks: 1, breakTokens: 0,
      peakContext: 0, endContext: 0, costUsd: null, pricedUsd, model: null, toolCalls: 0, toolMix: {},
      reads: 0, rereads: 0, editLookups: 0, clippedIds,
      verdict: { landed: 10, expected: 10, duplicated: 0 }, timeline: [], workspace: '', stderrHead: '',
    }
  }

  test('every arm against the first: SEPARATED once the ranges split, overlap otherwise', () => {
    const runs = [
      run('dev', 1.3, 7), run('dev', 1.28, 7),
      run('clip', 1.1, 20), run('clip', 1.12, 21),
      run('placebo', 1.29, 7), run('placebo', 1.31, 7),
    ]
    const out = summaryTable(runs, ['dev', 'clip', 'placebo'])
    const cost = out.split('\n').find(l => l.includes('cost, one price table'))!
    expect(cost).toContain('SEPARATED')
    expect(cost).toContain('(overlap)')
    expect(out.split('\n').find(l => l.includes('clipped ids'))).toContain('21 [20–21]')
  })

  test('one run per arm: medians only, no range verdict', () => {
    const out = summaryTable([run('dev', 1.3, 7), run('clip', 1.1, 20)], ['dev', 'clip'])
    expect(out).not.toContain('SEPARATED')
    expect(out).not.toContain('overlap')
  })
})

// The 1M compaction run (plan of 10-30): 24 turns per phase over a bigger
// corpus, Opus is the model, and the gate is pre-registered.
describe('rereadsOutsideScript', () => {
  test('a Read the script asked for twice is not a re-read; one it never asked for again is', () => {
    const asked = ['a.ts', 'b.ts', 'a.ts']
    const reads = ['a.ts', 'b.ts', 'a.ts', 'b.ts', 'a.ts']
    // a.ts asked twice and read three times, b.ts asked once and read twice.
    expect(rereadsOutsideScript(reads, asked)).toEqual([3, 4])
  })

  test('no extra reads is none', () => {
    expect(rereadsOutsideScript(['a.ts', 'a.ts'], ['a.ts', 'a.ts'])).toEqual([])
  })
})

describe('compactionsIn', () => {
  test('the index of each compact_boundary event, once per uuid', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'compact_boundary', uuid: 'u1' },
      { type: 'system', subtype: 'compact_boundary', uuid: 'u1' },
      { type: 'system', subtype: 'compact_boundary', uuid: 'u2' },
    ]
    expect(compactionsIn(events)).toEqual([1, 3])
  })
})

describe('modelWarning', () => {
  test('a served model of the requested family is fine, whatever the family', () => {
    expect(modelWarning('claude-opus-5-5', 'claude-opus-5-5')).toBeNull()
    expect(modelWarning('claude-sonnet-5', 'claude-sonnet-5-5')).toBeNull()
  })

  test('another family is flagged', () => {
    expect(modelWarning('claude-opus-5-5', 'claude-sonnet-5-5')).toContain('claude-sonnet-5-5')
  })
})

describe('compactionGate — the plan\'s pre-registered gates', () => {
  type Over = { lookups?: number; rereadTurns?: number[]; compactionTurns?: number[]; clipped?: number; landed?: number }
  function arm(label: string, priced: number[], o: Over = {}): ArmResult[] {
    return priced.map((p, i) => ({
      label, bin: '/x', rep: i + 1, exitCode: 0, wallMs: 0, turnsDone: 72, turnsPlanned: 72, apiCalls: 160,
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0, rw: 0, prefixBreaks: 0, breakTokens: 0,
      peakContext: 0, endContext: 0, costUsd: null, pricedUsd: p, model: null, toolCalls: 0, toolMix: {},
      reads: 0, rereads: (o.rereadTurns ?? []).length, editLookups: o.lookups ?? 10, clippedIds: o.clipped ?? 0,
      compactionTurns: o.compactionTurns ?? [], rereadTurns: o.rereadTurns ?? [],
      verdict: { landed: o.landed ?? 24, expected: 24, duplicated: 0 }, timeline: [], workspace: '', stderrHead: '',
    }) as ArmResult)
  }
  const BASE = arm('base', [10, 10.5, 11], { lookups: 18, rereadTurns: [40, 50, 60] })
  const PLACEBO = arm('placebo', [10.2, 10.6, 10.9], { lookups: 18 })
  const good = (o: Over = {}, priced = [6, 6.2, 6.5]) => arm('compact', priced, { lookups: 30, rereadTurns: [41, 52, 61, 65], compactionTurns: [30, 50], ...o })

  test('cheaper by 15% and separated, edits, lookups ≤2×, re-reads after compacting ≤1.5×: pass', () => {
    expect(compactionGate([...BASE, ...PLACEBO, ...good()], 'base', 'placebo', 'compact').verdict).toBe('PASS')
  })

  test('a candidate that compacted fewer than twice, or a base that clipped, is not the comparison', () => {
    expect(compactionGate([...BASE, ...PLACEBO, ...good({ compactionTurns: [30] })], 'base', 'placebo', 'compact').verdict).toBe('NOT EXERCISED')
    const clipped = arm('base', [10, 10.5, 11], { clipped: 30 })
    expect(compactionGate([...clipped, ...PLACEBO, ...good()], 'base', 'placebo', 'compact').verdict).toBe('NOT EXERCISED')
  })

  test('lookups past twice the base fail', () => {
    expect(compactionGate([...BASE, ...PLACEBO, ...good({ lookups: 48 })], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
  })

  test('re-reads after the first compaction past 1.5× the base from the same turn fail', () => {
    const many = good({ rereadTurns: [31, 33, 35, 41, 52, 61, 65] })
    const g = compactionGate([...BASE, ...PLACEBO, ...many], 'base', 'placebo', 'compact')
    expect(g.verdict).toBe('FAIL')
    expect(g.detail).toContain('re-reads after compacting NO')
  })

  test("the base's re-reads before the candidate first compacted do not count toward the ceiling", () => {
    // The base re-reads twice early (turns 10, 20) and three times after turn
    // 30; the candidate five times after it: 5 > 1.5 × 3, though 5 ≤ 1.5 × 5.
    const base = arm('base', [10, 10.5, 11], { lookups: 18, rereadTurns: [10, 20, 40, 50, 60] })
    const cand = good({ rereadTurns: [31, 41, 52, 61, 65] })
    expect(compactionGate([...base, ...PLACEBO, ...cand], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
  })

  test('cheaper by less than 15%, or overlapping the base range, fails', () => {
    expect(compactionGate([...BASE, ...PLACEBO, ...good({}, [9, 9.2, 9.5])], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
    expect(compactionGate([...BASE, ...PLACEBO, ...good({}, [6, 6.2, 10.2])], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
  })

  test('a lost edit fails it', () => {
    expect(compactionGate([...BASE, ...PLACEBO, ...good({ landed: 23 })], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
  })

  test('a placebo whose range misses the base\'s fails it: the run is noise', () => {
    const far = arm('placebo', [7, 7.2, 7.5])
    expect(compactionGate([...BASE, ...far, ...good()], 'base', 'placebo', 'compact').verdict).toBe('FAIL')
  })
})

describe('parseArgs — the corpus flags', () => {
  test('a count that is not a positive integer is an error, not zero turns', () => {
    expect(() => parseArgs(['--per-phase=20+'])).toThrow('--per-phase expects a positive integer')
    expect(() => parseArgs(['--large=0'])).toThrow('--large expects a positive integer')
  })

  test('dirs, large and effort; the defaults are the corpus older runs used', () => {
    const d = parseArgs([])
    expect(d.dirs).toEqual(['src/agent/compact', 'src/agent/cache'])
    expect(d.large).toBe(12)
    expect(d.effort).toBeNull()
    const a = parseArgs(['--dirs=src/plugins,src/mcp', '--large=24', '--effort=medium'])
    expect(a.dirs).toEqual(['src/plugins', 'src/mcp'])
    expect(a.large).toBe(24)
    expect(a.effort).toBe('medium')
  })
})
