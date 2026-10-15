import { afterEach, describe, expect, test } from 'bun:test'

import {
  armOrder,
  armProcessEnv,
  clippedIdsFrom,
  parseArgs,
  pricedUsd,
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
