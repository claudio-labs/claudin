import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCalls, Call, Price } from './forkBench.ts'
import {
  fixtureSpec,
  gates,
  grade,
  makeFixture,
  observedFacts,
  renderReport,
  rowOf,
  type Arm,
  type FileSpec,
  type Meta,
  type Row,
  type RunRecord,
} from './subagent-batching-ab.ts'

// The fixture is what the gate's "correct" means and the grader is what
// reads it, so both are checked here against git and against replies in the
// shapes a model writes; the gate and table run on synthetic rows.

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'subagent-batching-test-'))
  dirs.push(d)
  return d
}

describe('fixtureSpec', () => {
  test('eight files, touched 1…8 times once each, exporting 2–3 functions apiece', () => {
    for (let rep = 1; rep <= 10; rep++) {
      const spec = fixtureSpec(rep)
      expect(spec.map(f => f.path)).toEqual(Array.from({ length: 8 }, (_, i) => `src/mod${i + 1}.ts`))
      expect(spec.map(f => f.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      for (const f of spec) expect([2, 3]).toContain(f.names.length)
    }
  })

  test('no name contains another, so finding one cannot credit a different one', () => {
    for (let rep = 1; rep <= 10; rep++) {
      const names = fixtureSpec(rep).flatMap(f => f.names)
      expect(new Set(names).size).toBe(names.length)
      for (const a of names) for (const b of names) if (a !== b) expect(b.includes(a)).toBe(false)
    }
  })

  test('a rep draws the same fixture every time, another rep a different one', () => {
    expect(fixtureSpec(3)).toEqual(fixtureSpec(3))
    expect(fixtureSpec(3)).not.toEqual(fixtureSpec(4))
  })
})

describe('makeFixture', () => {
  test('git log and the source say what the returned spec says', () => {
    const dir = join(tempDir(), 'ws')
    const spec = makeFixture(dir, 2)
    expect(spec).toEqual(fixtureSpec(2))
    expect(observedFacts(dir, spec.map(f => f.path))).toEqual(spec)
  })

  test('two builds of one rep are the same repo, so every arm of a rep gets the same task', () => {
    const root = tempDir()
    const head = (d: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(d, '.git') } }).trim()
    makeFixture(join(root, 'a'), 5)
    makeFixture(join(root, 'b'), 5)
    expect(head(join(root, 'a'))).toBe(head(join(root, 'b')))
  })
})

const SPEC: FileSpec[] = [
  { path: 'src/mod1.ts', count: 2, names: ['loadLedger', 'parseToken'] },
  { path: 'src/mod2.ts', count: 1, names: ['mergeFrame', 'splitCursor', 'scoreBucket'] },
  { path: 'src/mod3.ts', count: 3, names: ['flushWindow', 'clampSchema'] },
]
const REPLY = [
  'src/mod1.ts, 2, loadLedger, parseToken',
  'src/mod2.ts, 1, mergeFrame, splitCursor, scoreBucket',
  'src/mod3.ts, 3, flushWindow, clampSchema',
].join('\n')

describe('grade', () => {
  test('passes the requested format: one line per file, path, count, names', () => {
    expect(grade(REPLY, SPEC)).toEqual({ correct: true, missing: [] })
  })

  test('passes a markdown table, a bullet list, and a preamble that names every path first', () => {
    const tableReply = [
      '| path | count | names |',
      '|---|---|---|',
      '| `src/mod1.ts` | 2 | `loadLedger`, `parseToken` |',
      '| `src/mod2.ts` | 1 | `mergeFrame`, `splitCursor`, `scoreBucket` |',
      '| `src/mod3.ts` | 3 | `flushWindow`, `clampSchema` |',
    ].join('\n')
    const bullets = [
      '- **src/mod1.ts** — 2 commits — loadLedger, parseToken',
      '- **src/mod2.ts** — 1 commit — mergeFrame, splitCursor, scoreBucket',
      '- **src/mod3.ts** — 3 commits — flushWindow, clampSchema.',
    ].join('\n')
    const preamble = `The agent checked src/mod1.ts, src/mod2.ts and src/mod3.ts:\n\n${REPLY}`
    for (const text of [tableReply, bullets, preamble]) expect(grade(text, SPEC)).toEqual({ correct: true, missing: [] })
  })

  test('fails a wrong count, naming the file and what it found', () => {
    expect(grade(REPLY.replace('src/mod2.ts, 1,', 'src/mod2.ts, 4,'), SPEC)).toEqual({
      correct: false,
      missing: ['src/mod2.ts: count 1, first number there 4'],
    })
  })

  test('takes the first number after the path as the count, where the requested format puts it', () => {
    const r = grade(REPLY.replace('src/mod1.ts, 2,', 'src/mod1.ts, 3 exports, 2 commits,'), SPEC)
    expect(r.missing).toEqual(['src/mod1.ts: count 2, first number there 3'])
  })

  test('does not read a count out of the path itself', () => {
    const r = grade(REPLY.replace('src/mod3.ts, 3,', 'src/mod3.ts,'), SPEC)
    expect(r.missing).toEqual(['src/mod3.ts: count 3, first number there none'])
  })

  test('fails a missing name, and a name listed under another file', () => {
    expect(grade(REPLY.replace(', splitCursor', ''), SPEC).missing).toEqual(['src/mod2.ts: no splitCursor'])
    const moved = REPLY.replace(', clampSchema', '').replace('parseToken', 'parseToken, clampSchema')
    expect(grade(moved, SPEC).missing).toEqual(['src/mod3.ts: no clampSchema'])
  })

  test('credits a name only as a whole word', () => {
    expect(grade(REPLY.replace('loadLedger', 'loadLedgerAsync'), SPEC).missing).toEqual(['src/mod1.ts: no loadLedger'])
  })

  test('fails an empty reply with every file missing', () => {
    expect(grade('', SPEC)).toEqual({ correct: false, missing: SPEC.map(f => `${f.path}: not in the reply`) })
  })
})

const PRICE: Price = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }
const PER_CALL = (10 * 4 + 1000 * 0.2 + 200 * 8 + 100 * 20) / 1e6
let seq = 0

function call(tools: string[]): Call {
  seq++
  return { id: `m${seq}`, ts: seq, in: 10, read: 1000, write5m: 0, write1h: 200, out: 100, tools }
}

function record(children: AgentCalls[], finalText = ''): RunRecord {
  return {
    arm: 'batching',
    rep: 1,
    cwd: '/tmp/ws',
    sessionId: 's1',
    exitCode: 0,
    finalText,
    expected: SPEC,
    childPrompt: null,
    verbatim: false,
    parent: [call(['Agent']), call([])],
    children,
  }
}

describe('rowOf', () => {
  test('measures the Code child: calls, tool calls per call over the calls that made one, costs', () => {
    const child: AgentCalls = {
      agentId: 'a1',
      agentType: 'Code',
      description: 'exports and counts',
      calls: [call(['Read', 'Read', 'Read']), call(['Bash', 'Bash']), call([])],
    }
    const r = rowOf(record([child], REPLY), PRICE)
    expect(r).toMatchObject({ childType: 'Code', delegated: true, childCalls: 3, toolCalls: 5, meanTools: 2.5, maxTools: 3, correct: true, missing: [] })
    expect(r.childCost).toBeCloseTo(3 * PER_CALL, 12)
    expect(r.sessionCost).toBeCloseTo(5 * PER_CALL, 12)
  })

  test('a session without a Code child is not measured', () => {
    expect(rowOf(record([]), PRICE)).toMatchObject({ childType: 'none', delegated: false, childCalls: 0, correct: false })
    const fork: AgentCalls = { agentId: 'f1', agentType: 'fork', description: '', calls: [call(['Read'])] }
    expect(rowOf(record([fork]), PRICE)).toMatchObject({ childType: 'fork', delegated: false, childCalls: 1 })
  })
})

const META: Meta = {
  started: '2026-09-24T12:00:00.000Z',
  runDir: '/tmp/subagent-batching-ab/20260924-120000',
  workspaces: '/tmp/ws-20260924-120000',
  model: 'claude-opus-5-5',
  effort: 'medium',
  reps: 5,
  bin: 'bin/claudin',
  version: '1.1.35 (Claudin) @ abc1234',
  bundleReadsFlag: true,
  hostEnvRemoved: [],
}

function row(arm: Arm, rep: number, childCalls: number, extra: Partial<Row> = {}): Row {
  return {
    arm,
    rep,
    childType: 'Code',
    delegated: true,
    verbatim: true,
    childCalls,
    toolCalls: 16,
    meanTools: 16 / Math.max(1, childCalls - 1),
    maxTools: 8,
    childCost: childCalls / 100,
    sessionCost: childCalls / 100 + 0.2,
    correct: true,
    missing: [],
    ...extra,
  }
}

/** The table pads every cell and joins them with two spaces; no cell holds two in a row. */
const CELL_SEP_RE = / {2,}/

const armRows = (arm: Arm, calls: number[]): Row[] => calls.map((c, i) => row(arm, i + 1, c))
const BASE = armRows('base', [17, 16, 18, 17, 19])
const PLACEBO = armRows('placebo', [16, 17, 15, 18, 17])
const BATCHING = armRows('batching', [5, 4, 6, 5, 5])
const verdicts = (rows: Row[]) => Object.fromEntries(gates(rows).map(g => [g.key, g.ok]))

describe('gates', () => {
  test('pass: batching at ≤ 70% of base, clear of placebo, every answer right, cheaper', () => {
    expect(verdicts([...BASE, ...BATCHING, ...PLACEBO])).toEqual({ calls: true, ranges: true, correct: true, cost: true, delegated: true })
  })

  test("the calls bar is 70% of base's median: against 17, 11 passes and 12 fails", () => {
    expect(verdicts([...BASE, ...armRows('batching', [11, 11, 11, 11, 11]), ...PLACEBO]).calls).toBe(true)
    expect(verdicts([...BASE, ...armRows('batching', [12, 12, 12, 12, 12]), ...PLACEBO]).calls).toBe(false)
  })

  test("a batching range that touches the placebo's fails, whatever the median", () => {
    const v = verdicts([...BASE, ...armRows('batching', [5, 4, 6, 5, 15]), ...PLACEBO])
    expect(v).toMatchObject({ calls: true, ranges: false })
  })

  test('one wrong answer fails correctness; a session with no Code child fails the precondition and stays out of the medians', () => {
    const wrong = BATCHING.map((r, i) => (i === 0 ? { ...r, correct: false, missing: ['src/mod1.ts: no loadLedger'] } : r))
    const lost = row('base', 6, 0, { childType: 'none', delegated: false, correct: false })
    expect(verdicts([...BASE, lost, ...wrong, ...PLACEBO])).toEqual({ calls: true, ranges: true, correct: false, cost: true, delegated: false })
  })

  test('no rows is no data, and fails every gate', () => {
    expect(gates([]).every(g => !g.ok)).toBe(true)
  })
})

describe('renderReport', () => {
  test('median [min–max] per arm, both comparisons, and the verdict', () => {
    const text = renderReport([...BASE, ...BATCHING, ...PLACEBO], META)
    expect(text).toContain('model=claude-opus-5-5 effort=medium reps=5')
    expect(text).toContain('opus-5-5 (4/20, cache read 0.2, write 5/8)')
    const lines = text.split('\n')
    const cells = (arm: string) => lines.find(l => l.startsWith(`${arm} `))!.split(CELL_SEP_RE)
    expect(cells('base').slice(0, 3)).toEqual(['base', '5/5', '17 [16–19]'])
    expect(cells('batching').slice(0, 3)).toEqual(['batching', '5/5', '5 [4–6]'])
    expect(cells('placebo').slice(0, 3)).toEqual(['placebo', '5/5', '17 [15–18]'])
    expect(cells('batching').slice(5)).toEqual(['0.0500 [0.0400–0.0600]', '0.2500 [0.2400–0.2600]', '5/5', '5/5'])
    expect(text).toContain('child calls, batching vs base: median 5 vs 17 (-70.6%), ranges disjoint')
    expect(text).toContain('child calls, batching vs placebo: median 5 vs 17 (-70.6%), ranges disjoint')
    expect(text).toContain('  PASS  child calls ≤ 70% of base: batching median 5, base 17 (bar 11.9)')
    expect(text).toContain('  PASS  child calls clear of placebo: batching 4–6, placebo 15–18')
    expect(text).toContain('  PASS  answers correct: 15/15 sessions')
    expect(text).toContain('verdict: PASS')
    expect(text).not.toContain('failed sessions')
  })

  test('a failing run says which gate and which sessions', () => {
    const wrong = BATCHING.map((r, i) => (i === 0 ? { ...r, correct: false, missing: ['src/mod1.ts: no loadLedger'] } : r))
    const lost = row('placebo', 6, 0, { childType: 'none', delegated: false, correct: false, missing: ['src/mod1.ts: not in the reply'] })
    const text = renderReport([...BASE, ...wrong, ...PLACEBO, lost], { ...META, bundleReadsFlag: false })
    expect(text).toContain('NO — batching ran as a second placebo')
    expect(text).toContain('  FAIL  answers correct: 14/16 sessions')
    expect(text).toContain('  FAIL  a Code child in every session: 15/16 sessions')
    expect(text).toContain('verdict: FAIL')
    expect(text).toContain('  batching r1: src/mod1.ts: no loadLedger')
    expect(text).toContain('  placebo r6: no Code child (none); src/mod1.ts: not in the reply')
    expect(text.split('\n').find(l => l.startsWith('placebo '))).toContain('5/6')
  })
})
