import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { ALL_MODEL_CONFIGS } from 'src/providers/model/configs.js'
import { getModelCosts } from 'src/providers/usage/modelCost.js'
import { REPO_ROOT } from '../../repoRoot.js'
import { buildReport, parseArgs, priceFor, print, walk } from './session-census.ts'

// The census mirrors the app's price table because a bare script cannot load
// it (see the header of session-census.ts). This is what keeps the mirror
// honest: until 2026-10-24 Opus 5.5 and Haiku 5.5 had no row, and every census
// reported about twice the spend. The list is every registered Claude model,
// not a copy of it: Fable 5.2 shipped on 2026-11-10 with no row, fell to the
// Fable 5 one (read $1.00 where the app charges $0.20), and a hand-kept list
// had no way to notice.
const CLAUDE_MODELS = Object.values(ALL_MODEL_CONFIGS).map(config => config.firstParty)

function appRates(model: string, promptTokens: number) {
  const app = getModelCosts(model, { input_tokens: promptTokens, output_tokens: 1 } as never)
  const long = app.longPrompt && promptTokens > app.longPrompt.abovePromptTokens ? app.longPrompt : app
  return {
    input: long.inputTokens,
    write5m: long.promptCacheWriteTokens,
    write1h: long.promptCacheWrite1hTokens,
    read: long.promptCacheReadTokens,
    output: long.outputTokens,
  }
}

describe('session-census prices', () => {
  test('every Claude row matches modelCost.ts', () => {
    for (const model of CLAUDE_MODELS) {
      expect({ model, ...priceFor(model) }).toEqual({ model, ...appRates(model, 1) })
    }
  })

  test('a long prompt bills at the long-prompt tier where the app has one', () => {
    for (const model of CLAUDE_MODELS) {
      expect({ model, ...priceFor(model, 150_000) }).toEqual({ model, ...appRates(model, 150_000) })
    }
    expect(priceFor('claude-haiku-5-5', 150_000).input).toBe(0.5)
    expect(priceFor('claude-haiku-5-5', 100_000).input).toBe(0.1)
  })
})

// ---------------------------------------------------------------------------
// Walk, report and print, over synthetic transcripts
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>

const SINCE = Date.parse('2026-11-14T00:00:00Z')
const OPUS = 'claude-opus-5-5'
const SCRIPT = join(import.meta.dir, 'session-census.ts')

function usage(input: number, output: number, read = 0, created = 0, extra: Rec = {}): Rec {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: created, ...extra }
}

/** One assistant record; `time` is `DDTHH:MM:SS` of November 2026, UTC. */
function reply(id: string, time: string, model: string, u: Rec, content: unknown, extra: Rec = {}): Rec {
  return { type: 'assistant', timestamp: `2026-11-${time}Z`, message: { id, model, usage: u, content }, ...extra }
}

const say = (text: string): Rec => ({ type: 'text', text })
const use = (id: string, name: string, input: Rec): Rec => ({ type: 'tool_use', id, name, input })
const bash = (id: string, command: string): Rec => use(id, 'Bash', { command })

function result(id: string, content: unknown, permissionDecision?: Rec): Rec {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(permissionDecision ? { permissionDecision } : {}) }
}

function costState(sources?: Record<string, [calls: number, costUSD: number]>): Rec {
  if (!sources) return { type: 'cost-state', totalCostUSD: 1 }
  const sourceUsage: Rec = {}
  for (const [source, [calls, costUSD]] of Object.entries(sources)) {
    sourceUsage[source] = { calls, costUSD, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  }
  return { type: 'cost-state', sourceUsage }
}

const M1_FIRST = reply(
  'm1',
  '14T10:00:00',
  OPUS,
  usage(1000, 10, 0, 20_000, { cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 15_000 } }),
  [say('Checking the log.'), bash('tu1', 'git log --oneline -5')],
)
const FLAT = usage(10, 5, 21_600)
const BLOCKED_CAT = 'Blocked: `cat secret.txt` reads a file. Use Read instead.'
const BLOCKED_ENV = '<tool_use_error>Blocked: `FOO=bar grep x` followed by: rm -rf x</tool_use_error>'

// Session A, eight calls in the window: a streamed first message, a 28 min
// and an 86 min gap that each drop the cache, and four no-write calls between.
const A_MAIN: (Rec | string)[] = [
  { type: 'summary', summary: 's' },
  M1_FIRST,
  // The stream's last record: the final output count, and no 5m/1h split.
  reply('m1', '14T10:00:01', OPUS, usage(1000, 200, 0, 20_000), [bash('tu2', 'sleep 30')]),
  result('tu1', 'abc1234 subject', { decision: 'accept', source: 'automatic', reason: 'rule', detail: 'Bash(git log:*)' }),
  result('tu2', 'pane', { decision: 'accept', source: 'user_temporary', waitMs: 4000 }),
  costState({ repl_main_thread: [1, 0.1] }),
  'not json',
  { type: 'assistant', message: { id: 'nousage', content: [say('x')] } },
  reply('', '14T10:01:00', OPUS, usage(1, 1), [say('no id')]),
  reply('m2', '14T10:02:00', OPUS, usage(500, 100, 21_000), [use('tu3', 'Read', { file_path: '/repo/a.ts' })]),
  result('tu3', [{ type: 'text', text: 'x'.repeat(100) }]),
  reply('m3', '14T10:30:00', OPUS, usage(100, 50, 0, 21_500), [bash('tu4', 'cat secret.txt')]),
  result('tu4', BLOCKED_CAT),
  reply('m4', '14T10:31:00', OPUS, FLAT, [bash('tu5', 'grep -r foo .')]),
  result('tu5', BLOCKED_ENV),
  reply('m5', '14T10:32:00', OPUS, FLAT, [bash('tu6', 'ls -la')]),
  result('tu6', 'a\nb', { decision: 'accept', source: 'automatic', reason: 'classifier', detail: 'read-only' }),
  reply('m6', '14T10:33:00', OPUS, FLAT, [bash('tu7', 'bun test x.test.ts')]),
  reply('m7', '14T10:34:00', OPUS, FLAT, [bash('tu8', 'bun run build')]),
  reply('m8', '14T12:00:00', OPUS, usage(20, 5, 100, 9000, { cache_creation: { ephemeral_1h_input_tokens: 9000 } }), [
    say('Now editing.'),
    bash('tu9', 'bun run typecheck'),
    bash('tu10', 'FOO=1 tmux send-keys -t s q'),
    bash('tu11', 'echo hi'),
    use('tu12', 'Edit', { file_path: '/repo/a.ts' }),
    bash('tu13', 'tmux capture-pane -p'),
  ]),
  result('tu12', 'rejected', { decision: 'reject', source: 'user_reject', waitMs: 10_000 }),
  costState({ repl_main_thread: [8, 1.5], auto_mode_classifier: [3, 0.25] }),
]

// Its fork: the parent's first message again, a call from before the window
// (and that call's later stream record), then two calls of its own.
const A_SUB: Rec[] = [
  { ...M1_FIRST, isSidechain: true },
  reply('old1', '13T23:59:59', OPUS, usage(9000, 9000), [bash('told', 'ls')], { isSidechain: true }),
  reply('old1', '14T00:00:05', OPUS, usage(9000, 9999), [say('late record')], { isSidechain: true }),
  reply('s1', '14T10:05:00', 'claude-haiku-5-5', usage(1000, 100, 150_000), [use('su1', 'Grep', { pattern: 'x' })], { isSidechain: true }),
  result('su1', 'x'),
  reply('s2', '14T10:06:00', 'mystery-model-1', usage(260_000, 1000, 0, 0, { output_tokens_details: { thinking_tokens: 400 } }), [say('Done.')], {
    isSidechain: true,
  }),
]

// Session B: every call is from before the window, and it has a cost-state.
const B_MAIN: Rec[] = [
  reply('b1', '10T09:00:00', OPUS, usage(1000, 100), [bash('tb1', 'ls')]),
  result('tb1', 'x', { decision: 'accept', source: 'user_temporary', waitMs: 99_000 }),
  costState({ repl_main_thread: [40, 57.67], auto_dream: [2, 3.49] }),
]

// Session C: one call in the window, and a cost-state from before `sourceUsage` existed.
const C_MAIN: Rec[] = [reply('c1', '15T09:00:00', 'claude-sonnet-5', usage(1000, 1000), 'plain text'), costState()]

describe('session census over synthetic transcripts', () => {
  let root = ''
  let files: string[] = []

  const put = (rel: string, recs: readonly (Rec | string)[], mtime: string): string => {
    const path = join(root, 'projects', '-proj', rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, recs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n\n')
    utimesSync(path, new Date(mtime), new Date(mtime))
    return path
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'session-census-test-'))
    // Newest first is the order main() walks them in.
    files = [
      put('aaaaaaaa-1111.jsonl', A_MAIN, '2026-11-16T04:00:00Z'),
      put('aaaaaaaa-1111/subagents/agent-f1.jsonl', A_SUB, '2026-11-16T03:00:00Z'),
      put('bbbbbbbb-2222.jsonl', B_MAIN, '2026-11-16T02:00:00Z'),
      put('cccccccc-3333.jsonl', C_MAIN, '2026-11-16T01:00:00Z'),
      join(root, 'projects', '-proj', 'removed-since-listing.jsonl'),
    ]
    put('dddddddd-4444.jsonl', [reply('d1', '01T09:00:00', OPUS, usage(1, 1), [])], '2026-11-01T09:00:00Z')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const report = () => buildReport(walk(files, SINCE))

  test('a call counts once: stream records merge, a fork mirror and a call from before the window stay out', () => {
    const w = walk(files, SINCE)
    expect(w.calls.map(c => c.id)).toEqual(['m1', 'm2', 's1', 's2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'c1'])
    const m1 = w.calls[0]!
    // The last stream record's usage, with the split the first one carried.
    expect(m1.usage.output_tokens).toBe(200)
    expect(m1.usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 15_000 })
    expect(m1.tools).toEqual(['Bash', 'Bash'])
    // The parent's file was walked first, so the mirrored message is the parent's.
    expect(m1.sidechain).toBe(false)
    expect(m1.file).toBe(files[0]!)
    expect(w.uses.size).toBe(14)
    expect(w.uses.has('told')).toBe(false)
    expect(w.uses.has('tb1')).toBe(false)
    expect(w.results.get('tu3')).toBe('x'.repeat(100))
    expect([...w.permissions.keys()]).toEqual(['tu1', 'tu2', 'tu6', 'tu12', 'tb1'])
    // Last cost-state of each file that has one.
    expect([...w.costStates.keys()]).toEqual([files[0]!, files[2]!, files[3]!])
    expect(Object.keys(w.costStates.get(files[0]!)?.sourceUsage ?? {})).toEqual(['repl_main_thread', 'auto_mode_classifier'])
  })

  test('totals, per session and per model, priced by the 5m/1h split and the long-prompt tier', () => {
    const r = report()
    expect(r.range).toEqual({ first: Date.parse('2026-11-14T10:00:00Z'), last: Date.parse('2026-11-15T09:00:00Z') })
    expect(r.totals.all.calls).toBe(11)
    expect(r.totals.main.calls).toBe(9)
    expect(r.totals.side.calls).toBe(2)
    expect(r.totals.all.w5).toBe(26_500)
    expect(r.totals.all.w1h).toBe(24_000)
    expect(r.totals.all.output).toBe(2475)
    expect(r.totals.all.thinking).toBe(400)
    expect(r.totals.all.total).toBeCloseTo(1.70539, 5)
    expect(r.totals.all.cost.write).toBeCloseTo(0.145 + 0.1075 + 0.072, 6)
    expect(r.totals.side.total).toBeCloseTo(0.00825 + 1.325, 6)
    expect(r.totals.side.read).toBeCloseTo(0.0075, 6)
    expect(r.sessions.map(s => [s.key, s.calls, s.models])).toEqual([
      ['aaaaaaaa-1111/sub', 2, ['claude-haiku-5-5', 'mystery-model-1']],
      ['aaaaaaaa-1111', 8, [OPUS]],
      ['cccccccc-3333', 1, ['claude-sonnet-5']],
    ])
    expect(r.sessions[1]!.total).toBeCloseTo(0.36014, 5)
    expect(r.models.map(m => [m.model, m.calls])).toEqual([
      [OPUS, 8],
      ['claude-haiku-5-5', 1],
      ['mystery-model-1', 1],
      ['claude-sonnet-5', 1],
    ])
    // A model with no row bills at the default tier: 260k in at $5, 1k out at $25.
    expect(r.models[2]!.total).toBeCloseTo(1.325, 6)
  })

  test('context sizes, cache drops, flat stretches and gaps, per transcript', () => {
    const r = report()
    expect(r.context).toEqual({ n: 11, p10: 9120, p50: 21_610, p90: 151_000, max: 260_000, over150k: 2, over250k: 1 })
    const at = (time: string): number => Date.parse(`2026-11-14T${time}Z`)
    expect(r.drops).toEqual([
      { session: 'aaaaaaaa-1111', ts: at('10:30:00'), prev: 21_000, now: 0, created: 21_500 },
      { session: 'aaaaaaaa-1111', ts: at('12:00:00'), prev: 21_600, now: 100, created: 9000 },
    ])
    expect(r.flats).toEqual([{ session: 'aaaaaaaa-1111', calls: 4, tailIn: 10, nextRead: 100, nextCreated: 9000, wiped: true }])
    expect(r.gaps.under5).toBe(6)
    expect(r.gaps.from5to60).toBe(1)
    expect(r.gaps.over60).toBe(1)
    expect(r.gaps.premium1h).toBeCloseTo(0.045 + 0.027, 6)
    expect(r.gaps.rewrite5m).toBeCloseTo(0.105 + 0.108, 6)
  })

  test('tool census, Bash shapes, refusals by command head, wait turns and narration', () => {
    const r = report()
    expect(r.tools).toEqual([
      { name: 'Bash', n: 11, chars: 'abc1234 subject'.length + 'pane'.length + BLOCKED_CAT.length + BLOCKED_ENV.length + 'a\nb'.length },
      { name: 'Read', n: 1, chars: 100 },
      { name: 'Edit', n: 1, chars: 8 },
      { name: 'Grep', n: 1, chars: 1 },
    ])
    expect(Object.fromEntries(r.bash.map(b => [b.cat, b.n]))).toEqual({
      git: 1,
      sleep: 1,
      'file-read': 1,
      grep: 1,
      list: 1,
      'bun-test': 1,
      'bun-build': 1,
      typecheck: 1,
      tmux: 2,
      other: 1,
    })
    expect(r.bash[0]).toEqual({ cat: 'tmux', n: 2, chars: 0 })
    // Heads only: the file name and the arguments are gone.
    expect(r.refusals).toEqual([
      ['`cat…` reads a file', 1],
      ['`FOO=……` followed by: rm…', 1],
    ])
    // m1 and m8, once each though m8 carries two capture commands.
    expect(r.wait.turns).toBe(2)
    expect(r.wait.ctxTokens).toBe(21_000 + 9120)
    expect(r.wait.cost).toBeCloseTo(0.153 + 0.0722, 6)
    // The fork's mirror record appends m1's text a second time: 2 × 17 + 12.
    expect(r.narration).toEqual({ messagesWithTools: 9, withText: 2, chars: 46 })
  })

  test('permission decisions pair with the tool uses of the window', () => {
    const p = report().permissions
    expect(p.uses).toBe(14)
    expect(p.recorded).toBe(4)
    expect(p.verdicts).toEqual([
      ['accept automatic (rule)', 1],
      ['accept user_temporary', 1],
      ['accept automatic (classifier)', 1],
      ['reject user_reject', 1],
    ])
    expect(p.prompted).toEqual([
      ['Bash(sleep…)', 1],
      ['Edit', 1],
    ])
    expect(p.waitMs).toEqual({ n: 2, p50: 10_000, p90: 10_000 })
    expect(p.rules).toEqual([['Bash(git…)', 1]])
  })

  // KNOWN DEFECT (census 2026-11-16): session B has no call in the window, and
  // its whole cost-state is counted all the same.
  test('spend by source takes every walked cost-state, whatever the dates of its calls', () => {
    const { sources } = report()
    expect(sources.sessions).toBe(2)
    expect(sources.rows).toEqual([
      { source: 'repl_main_thread', calls: 48, costUSD: 59.17, sessions: 2 },
      { source: 'auto_dream', calls: 2, costUSD: 3.49, sessions: 1 },
      { source: 'auto_mode_classifier', calls: 3, costUSD: 0.25, sessions: 1 },
    ])
  })

  function printed(r: ReturnType<typeof buildReport>): string[] {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      print(r)
      return log.mock.calls.map(args => String(args[0]))
    } finally {
      log.mockRestore()
    }
  }

  test('print renders every section from the report', () => {
    const lines = printed(report())
    expect(lines[0]).toBe('=== SESSION CENSUS 2026-11-14T10:00 → 2026-11-15T09:00 ===')
    expect(lines[1]).toBe('calls=11 (main 9, sidechain 2)  total=$1.71')
    expect(lines[2]).toBe(
      'split: input $1.31 • cache write $0.32 (5m 26,500 / 1h 24,000 tok) • cache read $0.03 • output $0.04 (thinking 16%)',
    )
    expect(lines).toContain('aaaaaaaa      opus-5-5     calls=   8 avgCtx=  20k dur= 120min    $0.36 (in $0.01 / w $0.32 / r $0.02 / out $0.01)')
    expect(lines).toContain('\n--- context per call --- n=11 p10=9,120 p50=21,610 p90=151,000 max=260,000 | >150k: 2  >250k: 1')
    expect(lines).toContain('sidechain: 2 calls, cache reads $0.01 of $1.33')
    expect(lines).toContain("\n--- cache drops (the previous call's prefix not read back, created > 8k) --- n=2 re-written=30,500 tok")
    expect(lines).toContain('  aaaaaaaa      2026-11-14T10:30 cached 21,000 → read 0  created=21,500')
    expect(lines).toContain('--- flat no-write stretches (≥4 calls) --- n=1, 1 ended in a drop')
    expect(lines).toContain('  aaaaaaaa      flat= 4 tailIn=    10 → next read=100 created=9,000  <<< DROP')
    expect(lines).toContain('Bash                         n=   11 resultChars=       159 avg=     14')
    expect(lines).toContain('tmux         n=   2 chars=0')
    expect(lines).toContain('--- refusals (Blocked:) --- n=2')
    expect(lines).toContain('\n--- wait/poll turns (sleep / tmux capture) --- turns=2 ctxTokens=30,120 cost≈$0.23')
    expect(lines).toContain('\n--- inter-call gaps --- <5min=6  5-60min=1  >60min=1')
    expect(lines).toContain('1h TTL premium paid $0.07; a 5m policy would have re-written ≈$0.21 at the ≥5min gaps')
    expect(lines).toContain('\n--- narration (text beside a tool_use) --- 2 of 9 messages, 46 chars')
    // KNOWN DEFECT, as above: B's $57.67 is in the first row.
    expect(lines).toContain('\n--- spend by source (whole sessions, last cost-state) --- 2 sessions carry it')
    expect(lines).toContain('  repl_main_thread                 calls=   48   $59.17  sessions=2')
    expect(lines).toContain('\n--- permission decisions --- 4 of 14 tool uses carry one')
    expect(lines).toContain('prompts answered: 2  wait p50=10.0s p90=10.0s')
    expect(lines).toContain('     1× Bash(sleep…)')
    expect(lines).toContain('rule hits (heads only): 1')
  })

  test('an empty walk prints an empty report', () => {
    const lines = printed(buildReport(walk([], SINCE)))
    expect(lines[0]).toBe('=== SESSION CENSUS - → - ===')
    expect(lines[1]).toBe('calls=0 (main 0, sidechain 0)  total=$0.00')
    expect(lines).toContain('\n--- spend by source (whole sessions, last cost-state) --- 0 sessions carry it')
  })

  test('parseArgs reads --since as a UTC day and defaults to the last seven', () => {
    expect(parseArgs(['--since=2026-11-14', '--project=-proj', '--json'])).toEqual({ since: SINCE, project: '-proj', json: true })
    const fallback = parseArgs([])
    expect(fallback.project).toBeNull()
    expect(fallback.json).toBe(false)
    expect(Date.now() - fallback.since).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000)
    expect(Date.now() - fallback.since).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000)
    expect(() => parseArgs(['--since=yesterday'])).toThrow('--since must be YYYY-MM-DD')
  })

  // main() itself: the corpus root follows CLAUDIN_CONFIG_DIR, in the child only.
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: REPO_ROOT, env: { ...process.env, CLAUDIN_CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe' })

  test('the script walks the transcripts modified since the date, newest first', () => {
    const json = run('--since=2026-11-14', '--project=-proj', '--json')
    expect(json.stderr.toString()).toBe('')
    expect(json.exitCode).toBe(0)
    const r = JSON.parse(json.stdout.toString()) as ReturnType<typeof buildReport>
    expect(r.totals.all.calls).toBe(11)
    expect(r.totals.main.calls).toBe(9)
    expect(r.sources.sessions).toBe(2)

    const text = run('--since=2026-11-14', '--project=-proj')
    expect(text.exitCode).toBe(0)
    const lines = text.stdout.toString().split('\n')
    // Four of the five on disk: the fifth was last modified on 11-01.
    expect(lines[0]).toBe('transcripts=4 projects=-proj')
    expect(lines[1]).toBe('=== SESSION CENSUS 2026-11-14T10:00 → 2026-11-15T09:00 ===')
    expect(lines).toContain('(unpriced models billed at the Opus 4.5 tier: mystery-model-1)')
  })

  test('the script exits 1 when no transcript was modified since the date', () => {
    const none = run('--since=2026-11-14', '--project=-missing')
    expect(none.exitCode).toBe(1)
    expect(none.stdout.toString()).toBe('')
    expect(none.stderr.toString()).toContain('no transcripts modified since 2026-11-14 under ')
  })
})
