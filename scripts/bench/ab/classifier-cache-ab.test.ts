import { describe, expect, test } from 'bun:test'

import {
  type Arm,
  bashLatencies,
  buildWorkload,
  evaluateGates,
  noteFile,
  parseArgs,
  parseClassifierDebug,
  type SessionStats,
  sessionStats,
  wideGaps,
} from './classifier-cache-ab.ts'

const PROSE = 'lorem ipsum '.repeat(2_000)

describe('parseArgs', () => {
  test('the defaults are the pre-registered run', () => {
    const args = parseArgs([])
    expect(args).toMatchObject({ model: 'claude-sonnet-5-5', reps: 2, turns: 54, wideEvery: 6, reads: 24, chars: 5_500, budgetUsd: 45 })
    expect(args.arms).toEqual(['base', 'placebo', 'candidate'])
  })

  test('--only keeps the arms in their order and refuses a name it does not know', () => {
    expect(parseArgs(['--only=candidate,base']).arms).toEqual(['base', 'candidate'])
    expect(() => parseArgs(['--only=control'])).toThrow('unknown arm: control')
  })

  test('an unknown flag or a non-positive number is refused', () => {
    expect(() => parseArgs(['--turn=3'])).toThrow('unknown argument: --turn=3')
    expect(() => parseArgs(['--turns=0'])).toThrow('--turns must be a positive number')
  })
})

describe('buildWorkload', () => {
  const opts = { turns: 6, wideEvery: 3, reads: 4, chars: 100 }

  test('every turn carries its slice of the prose and one judged command', () => {
    const turns = buildWorkload(PROSE, opts, 'tag-1')
    expect(turns).toHaveLength(6)
    expect(turns[1]!.text).toContain(PROSE.slice(100, 200))
    expect(turns[1]!.text).toContain('python3 -c "print(2 * 7)"')
    expect(turns[1]!.wide).toBe(false)
  })

  test('a wide turn names its own files, a fresh set each time', () => {
    const turns = buildWorkload(PROSE, opts, 'tag-1')
    expect(turns.filter(t => t.wide).map(t => t.index)).toEqual([3, 6])
    expect(turns[2]!.files).toEqual([noteFile(1, 1), noteFile(1, 2), noteFile(1, 3), noteFile(1, 4)])
    expect(turns[5]!.files[0]).toBe('notes/w02/n01.txt')
    expect(turns[2]!.text).toContain('one Read call per file: notes/w01/n01.txt, ')
  })

  test('only the first message differs between two sessions', () => {
    const a = buildWorkload(PROSE, opts, 'tag-a')
    const b = buildWorkload(PROSE, opts, 'tag-b')
    expect(a[0]!.text.startsWith('[session tag-a] ')).toBe(true)
    expect(a[0]!.text).not.toBe(b[0]!.text)
    expect(a.slice(1)).toEqual(b.slice(1))
  })

  test('prose too short for the turns is refused', () => {
    expect(() => buildWorkload('short', opts, 't')).toThrow('6 turns of 100 need 600')
  })
})

const line = (truncated: boolean, budget: number, lag: string, blocks: number): string =>
  `2026-11-11T20:00:00.000Z [DEBUG] [auto-mode] context comparison: mainLoopTokens=1 classifierChars=2 ` +
  `transcriptEntries=3 earlierCalls=0 truncated=${truncated} budget=${budget} lag=${lag}/${blocks} messages=9`

describe('parseClassifierDebug and wideGaps', () => {
  test('one call per context-comparison line, other lines ignored', () => {
    const log = [line(false, 200_000, 'none', 2), '[auto-mode] new action being classified: Bash x', line(true, 800_000, '5', 31)].join('\n')
    expect(parseClassifierDebug(log)).toEqual([
      { truncated: false, budget: 200_000, lag: null, blocks: 2 },
      { truncated: true, budget: 800_000, lag: 5, blocks: 31 },
    ])
  })

  test('a call is wide when its transcript grew by more than 20 blocks, and counted as marked when it has a lag block', () => {
    const calls = parseClassifierDebug(
      [line(false, 1, 'none', 2), line(false, 1, '2', 4), line(false, 1, '4', 30), line(false, 1, 'none', 56), line(false, 1, '56', 76)].join('\n'),
    )
    // +2, +26 (marked), +26 (not marked), +20 (not past the lookback).
    expect(wideGaps(calls)).toEqual({ wide: 2, marked: 1 })
  })

  test('a transcript that shrank (the cut moved) is not a wide gap', () => {
    expect(wideGaps(parseClassifierDebug([line(false, 1, 'none', 90), line(true, 1, 'none', 40)].join('\n')))).toEqual({ wide: 0, marked: 0 })
  })
})

const use = (at: number, id: string, name = 'Bash') => ({
  at,
  event: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } },
})
const result = (at: number, id: string) => ({
  at,
  event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } },
})

describe('bashLatencies', () => {
  test('from a Bash tool_use to its result; other tools and a repeated event are left out', () => {
    const stream = [use(1_000, 'a'), use(1_050, 'a'), result(1_900, 'a'), use(2_000, 'r', 'Read'), result(2_010, 'r'), use(3_000, 'b'), result(3_400, 'b')]
    expect(bashLatencies(stream)).toEqual([900, 400])
  })
})

describe('sessionStats', () => {
  test('reads the last cost-state, the decisions and the debug log', () => {
    const stats = sessionStats('candidate', 1, {
      turnsDone: 2,
      sessionId: 's1',
      transcript: [
        { type: 'cost-state', totalCostUSD: 1, sourceUsage: {} },
        { type: 'user', permissionDecision: { decision: 'accept', source: 'automatic', reason: 'classifier' } },
        { type: 'user', permissionDecision: { decision: 'reject', source: 'automatic', reason: 'classifier' } },
        { type: 'user', permissionDecision: { decision: 'accept', source: 'automatic', reason: 'mode' } },
        {
          type: 'cost-state',
          totalCostUSD: 5,
          sourceUsage: { auto_mode: { calls: 4, costUSD: 1.5, cacheReadInputTokens: 900, cacheCreationInputTokens: 300 } },
        },
      ],
      debug: [line(false, 800_000, 'none', 2), line(false, 800_000, '2', 30)].join('\n'),
      stream: [use(0, 'a'), result(700, 'a')],
    })
    expect(stats).toMatchObject({
      arm: 'candidate',
      totalUsd: 5,
      classifierUsd: 1.5,
      classifierCalls: 4,
      classifierWrites: 300,
      classifierReads: 900,
      restUsd: 3.5,
      judged: 2,
      rejects: 1,
      latencyP50Ms: 700,
      debugCalls: 2,
      truncatedCalls: 0,
      wide: 1,
      marked: 1,
      maxBudget: 800_000,
    })
  })

  test('a session that left nothing behind reads as zeros, not as a crash', () => {
    const stats = sessionStats('base', 1, { turnsDone: 0, sessionId: null, transcript: [], debug: '', stream: [] })
    expect(stats).toMatchObject({ totalUsd: 0, classifierWrites: 0, judged: 0, debugCalls: 0, latencyP50Ms: 0 })
  })
})

function session(arm: Arm, rep: number, over: Partial<SessionStats> = {}): SessionStats {
  return {
    arm,
    rep,
    sessionId: `${arm}-${rep}`,
    turnsDone: 54,
    totalUsd: 6,
    classifierUsd: 3,
    classifierCalls: 60,
    classifierWrites: 700_000,
    classifierReads: 3_000_000,
    restUsd: 3,
    judged: 54,
    rejects: 5,
    latencyP50Ms: 2_000,
    debugCalls: 60,
    truncatedCalls: 12,
    wide: 9,
    marked: 0,
    maxBudget: 200_000,
    ...over,
  }
}

const WINNING: Partial<SessionStats> = {
  classifierUsd: 1,
  classifierWrites: 120_000,
  truncatedCalls: 0,
  marked: 9,
  maxBudget: 800_000,
}

function run(candidate: Partial<SessionStats> = WINNING, placebo: Partial<SessionStats> = {}): SessionStats[] {
  return [1, 2].flatMap(rep => [session('base', rep), session('placebo', rep, placebo), session('candidate', rep, candidate)])
}

const failed = (sessions: SessionStats[]): string[] =>
  evaluateGates(sessions)
    .filter(g => !g.pass)
    .map(g => g.name.slice(0, 1))

describe('evaluateGates', () => {
  test('a candidate that writes a sixth, with the lag block on every wide call, passes all six', () => {
    expect(failed(run())).toEqual([])
  })

  test('gate 1 fails when one rep is over 0.6, or when the placebo moved more than 10%', () => {
    const oneRepOver = run()
    oneRepOver.find(s => s.arm === 'candidate' && s.rep === 2)!.classifierWrites = 430_000
    expect(failed(oneRepOver)).toEqual(['1'])
    expect(failed(run(WINNING, { classifierWrites: 600_000 }))).toEqual(['1'])
  })

  test('gate 2 is the spend, gate 4 the rejects, gate 5 the latency, gate 6 the rest of the session', () => {
    expect(failed(run({ ...WINNING, classifierUsd: 2.5 }))).toEqual(['2'])
    expect(failed(run({ ...WINNING, rejects: 7 }))).toEqual(['4'])
    expect(failed(run({ ...WINNING, rejects: 6 }))).toEqual([])
    expect(failed(run({ ...WINNING, latencyP50Ms: 2_600 }))).toEqual(['5'])
    expect(failed(run({ ...WINNING, restUsd: 3.2 }))).toEqual(['6'])
  })

  test('gate 3 needs the lag block on four wide calls in five, and no truncated candidate call', () => {
    expect(failed(run({ ...WINNING, marked: 7 }))).toEqual(['3'])
    expect(failed(run({ ...WINNING, marked: 8 }))).toEqual([])
    expect(failed(run({ ...WINNING, truncatedCalls: 1 }))).toEqual(['3'])
    expect(failed(run({ ...WINNING, wide: 0, marked: 0 }))).toEqual(['3'])
  })

  test('gate 3 fails when base never passed its budget: the run did not exercise the cut', () => {
    const sessions = run()
    for (const s of sessions) if (s.arm === 'base' && s.rep === 1) s.truncatedCalls = 0
    expect(failed(sessions)).toEqual(['3'])
  })

  test('a run missing an arm in a rep passes nothing', () => {
    const sessions = run().filter(s => !(s.arm === 'candidate' && s.rep === 2))
    expect(failed(sessions)).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})
