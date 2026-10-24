/**
 * Relief-ceiling simulator: what a lower window-lane trigger for sub-agents
 * would have bought on recorded sub-agent transcripts, before building one.
 *
 * The 2026-09-26..28 census found fresh Code sub-agents running to 400-700k
 * context with no relief at all: on a 1M window the window lane triggers near
 * 750k, and 33 of 62 such agents never got there. This replays each recorded
 * sub-agent thread call by call against a trigger T and applies the policy's
 * shape (`src/agent/compact/reliefPolicy.ts`): once usage passes T, clip the
 * oldest clearable results and inputs outside the last two turns down to
 * T − band, where band = clamp(max(60k, 0.15·T), ≤ 0.3·T); an event that frees
 * under 4k is starved and does nothing. A clipped result keeps a 2,000-char head.
 *
 * Per event it charges one rewrite of the post-clip prompt at the 5m write
 * price (minus the read it replaces), and from then on credits the freed tokens
 * as reads avoided on every later call of the thread.
 *
 * It is an UPPER bound on the saving: the model's re-reads of what was clipped
 * are not simulated (recorded agents never lost anything), and thinking, which
 * the relief clip cannot touch, stays resident either way. Tokens are chars/3
 * for tool content.
 *
 * Two policy switches replay the 2026-10 changes, and `--main` replays main
 * threads instead (1h write price; their recorded context already reflects
 * the real clips, so the absolute numbers understate usage — compare arms):
 *   --min-event=band   an event must free one band, not a flat 4k
 *   --starved-compact  a starved event compacts: the summary call reads the
 *                      prompt and writes ~15k of output, the thread restarts
 *                      at --post-compact tokens (default 40k) and grows by the
 *                      recorded deltas from there; nothing older is clippable
 *
 * Two more replay candidate selections the policy does not have (yet):
 *   --clip-all         an event clips EVERY clearable block outside the last
 *                      two calls, not just one band's worth: the rewrite
 *                      starts at the oldest clipped block either way, so the
 *                      extra clips shrink what is rewritten (2026-10-15)
 *   --band=N           a fixed band instead of clamp(max(60k, 0.15·T), ≤0.3·T)
 *
 * And one the policy has since 2026-10-19:
 *   --input-keep=N     a tool INPUT stays whole for the last N calls (default
 *                      KEEP_RECENT_INPUT_RESULTS); results keep the last two
 *                      either way. `--input-keep=2` replays the policy before
 *                      it. The policy counts tool results and this counts
 *                      API calls, so with parallel calls the replay protects a
 *                      little more than the app does
 *
 * Three for the 1M main-thread question of 2026-10-24 ("compact earlier, or
 * clip earlier?"), each off by default so older runs replay unchanged:
 *   --compact-at       crossing the trigger compacts at once, with no clip
 *                      lane: the shape of CLAUDIN_DISABLE_RELIEF_POLICY=1
 *                      with the autocompact threshold at the trigger
 *   --thinking-drop=S  a thread's FIRST clip also frees S of the prompt after
 *                      the first clipped block: on Opus/Sonnet/Haiku 5.5 the
 *                      server drops every thinking block after it
 *                      (`microCompact.ts`, `thinkingTokensAfter`). 0.34 is the
 *                      thinking share measured in 9 main threads over 300k
 *   --regrowth=X       after a thread's first event, the recorded growth per
 *                      call is multiplied by X: what is re-read. 1.55 is the
 *                      mean over the 6 real clip events of 10-20..24 (growth
 *                      over the 40 calls after each, against the 40 before)
 *
 * With the last two the replay is no longer only an upper bound on re-reads;
 * it is still one on how much a compaction costs in lost working context,
 * which no token count sees.
 *
 * Run:
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-09-26
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-09-26 --session=501d7261 --triggers=250000,300000,400000
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-10-02 --main --session=ed9c2e1c --triggers=735000 --min-event=band --starved-compact
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-09-17 --main --triggers=735000 --min-event=band --starved-compact --clip-all
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-10-20 --main --triggers=735000,490000 --compact-at --regrowth=1.55 --post-compact=60000
 *
 * Transcripts are DATA: only aggregates are printed.
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import { contentText, projectDirs, transcriptFiles } from './transcriptCorpus.js'

const CHARS_PER_TOKEN = 3
const HEAD_CHARS = 2_000
const KEEP_RECENT_CALLS = 2
// Mirror of KEEP_RECENT_INPUT_RESULTS in src/agent/compact/stableStubState/clipFrontier.ts,
// which relief-ceiling-sim.test.ts pins equal: importing it loads the app's
// module graph, which a bare `bun scripts/…` run cannot resolve.
const KEEP_RECENT_INPUT_RESULTS = 10
const BAND_MIN = 60_000
const BAND_TRIGGER_FRACTION = 0.15
const BAND_MAX_FRACTION = 0.3
const MIN_EVENT_TOKENS = 4_000
// Opus 5.5, $/Mtok (mirror of modelCost.ts; relief-ceiling-sim.test.ts compares
// it with getModelCosts). Until 2026-10-24 these were Opus 5's 0.5 read and
// 10 write: a write cost 20 reads instead of 40, so every replay made a
// rewrite look half as expensive as it is and overstated what a clip saves.
export const PRICE = { read: 0.2, write5m: 5, write1h: 8, output: 20 } as const
const READ = PRICE.read
const WRITE_5M = PRICE.write5m
const WRITE_1H = PRICE.write1h
const OUTPUT = PRICE.output
const SUMMARY_OUTPUT_TOKENS = 15_000

// Mirrors the tools' own declarations: `clearableResult: true` and
// `clearableInputFields` (grep src/tools for either).
const CLEARABLE_RESULT = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Git', 'WaitFor', 'Typecheck',
  'RunTests', 'Build', 'Container', 'Monitor', 'PowerShell', 'LSP',
])
const CLEARABLE_INPUT: Record<string, readonly string[]> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  NotebookEdit: ['new_source'],
  Patch: ['patchText'],
  Agent: ['prompt'],
}

export type Args = {
  since: number
  session: string | null
  triggers: number[]
  main: boolean
  bandFloor: boolean
  starvedCompact: boolean
  postCompact: number
  clipAll: boolean
  band: number | null
  inputKeep: number
  compactAt: boolean
  thinkingDrop: number
  regrowth: number
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (k: string) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const since = Date.parse(`${get('since') ?? '2026-09-26'}T00:00:00`)
  if (Number.isNaN(since)) throw new Error('--since=YYYY-MM-DD')
  const triggers = (get('triggers') ?? '200000,250000,300000,400000,500000').split(',').map(Number)
  const band = get('band') === undefined ? null : Number(get('band'))
  if (band !== null && !(band > 0)) throw new Error('--band=<tokens>')
  const inputKeep = Number(get('input-keep') ?? KEEP_RECENT_INPUT_RESULTS)
  if (!Number.isInteger(inputKeep) || inputKeep < 0) throw new Error('--input-keep=<calls>')
  const thinkingDrop = Number(get('thinking-drop') ?? 0)
  if (!(thinkingDrop >= 0 && thinkingDrop < 1)) throw new Error('--thinking-drop=<share in [0, 1)>')
  const regrowth = Number(get('regrowth') ?? 1)
  if (!(regrowth >= 1)) throw new Error('--regrowth=<factor ≥ 1>')
  return {
    since,
    session: get('session') ?? null,
    triggers,
    main: argv.includes('--main'),
    bandFloor: get('min-event') === 'band',
    starvedCompact: argv.includes('--starved-compact'),
    postCompact: Number(get('post-compact') ?? 40_000),
    clipAll: argv.includes('--clip-all'),
    band,
    inputKeep,
    compactAt: argv.includes('--compact-at'),
    thinkingDrop,
    regrowth,
  }
}

type Block = { call: number; tokens: number; input?: boolean }
export type Thread = { name: string; ctx: number[]; blocks: Block[] }

/** Whether call `k`'s request keeps `b` whole: inputs keep at least what results do. */
function isProtected(b: Block, k: number, inputKeep: number): boolean {
  return b.call >= k - (b.input ? Math.max(KEEP_RECENT_CALLS, inputKeep) : KEEP_RECENT_CALLS)
}

function loadThread(path: string, main: boolean): Thread | null {
  const order: string[] = []
  const ctxById = new Map<string, number>()
  const callOfTool = new Map<string, { call: number; name: string }>()
  const blocks: Block[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let o: { type?: string; message?: { id?: string; model?: string; usage?: Record<string, number>; content?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const m = o.message
    if (o.type === 'assistant' && m?.id && m.model !== '<synthetic>') {
      if (!ctxById.has(m.id)) order.push(m.id)
      const u = m.usage ?? {}
      const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      ctxById.set(m.id, Math.max(ctxById.get(m.id) ?? 0, ctx))
      const call = order.indexOf(m.id)
      for (const b of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
        if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
        callOfTool.set(b.id, { call, name: b.name })
        const input = (b.input ?? {}) as Record<string, unknown>
        let chars = 0
        for (const field of CLEARABLE_INPUT[b.name] ?? []) {
          const v = input[field]
          if (typeof v === 'string') chars += v.length
        }
        if (chars > 0) blocks.push({ call, tokens: chars / CHARS_PER_TOKEN, input: true })
      }
    } else if (o.type === 'user' && Array.isArray(m?.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const use = callOfTool.get(b.tool_use_id)
        if (!use || !CLEARABLE_RESULT.has(use.name)) continue
        const chars = contentText(b.content).length - HEAD_CHARS
        if (chars > 0) blocks.push({ call: use.call, tokens: chars / CHARS_PER_TOKEN })
      }
    }
  }
  if (order.length < 3) return null
  const name = main
    ? basename(path, '.jsonl').slice(0, 8)
    : `${basename(dirname(dirname(path))).slice(0, 8)}/${basename(path, '.jsonl')}`
  return { name, ctx: order.map(id => ctxById.get(id) ?? 0), blocks }
}

export type Outcome = {
  events: number
  starved: number
  compactions: number
  rewrite: number
  compact: number
  saved: number
  reads: number
}

export function simulate(t: Thread, trigger: number, args: Args): Outcome {
  const band = args.band ?? Math.min(Math.max(BAND_MIN, trigger * BAND_TRIGGER_FRACTION), trigger * BAND_MAX_FRACTION)
  const target = trigger - band
  const minEvent = args.bandFloor ? Math.max(MIN_EVENT_TOKENS, band) : MIN_EVENT_TOKENS
  const write = args.main ? WRITE_1H : WRITE_5M
  const clipped = new Set<number>()
  let freed = 0
  // What compactions removed, and the last call they swallowed.
  let compactedAway = 0
  let compactedThrough = -1
  // Tokens the model added on top of the recorded growth after its first
  // event (`--regrowth`): what it re-read.
  let regrown = 0
  let hadEvent = false
  const out: Outcome = { events: 0, starved: 0, compactions: 0, rewrite: 0, compact: 0, saved: 0, reads: 0 }
  const compactNow = (ctx: number, k: number, used: number): void => {
    out.compactions++
    out.compact += (used * READ + SUMMARY_OUTPUT_TOKENS * OUTPUT + args.postCompact * write) / 1e6
    compactedAway = ctx - args.postCompact
    compactedThrough = k
    freed = 0
    regrown = 0
    hadEvent = true
  }
  t.ctx.forEach((ctx, k) => {
    out.reads += (ctx * READ) / 1e6
    if (hadEvent && k > 0) regrown += (args.regrowth - 1) * Math.max(0, ctx - (t.ctx[k - 1] ?? ctx))
    let used = ctx - compactedAway - freed + regrown
    if (used > trigger && args.compactAt) {
      compactNow(ctx, k, used)
    } else if (used > trigger) {
      let got = 0
      const picked: number[] = []
      t.blocks.forEach((b, i) => {
        if ((!args.clipAll && got >= used - target) || clipped.has(i) || b.call <= compactedThrough || isProtected(b, k, args.inputKeep)) return
        picked.push(i)
        got += b.tokens
      })
      if (got < minEvent) {
        out.starved++
        if (args.starvedCompact) compactNow(ctx, k, used)
      } else {
        // The prefix up to the oldest newly clipped block still reads from
        // cache: clips go oldest-first, so everything freed before now sits
        // behind it. Only the rest of the prompt is written again.
        const firstCall = t.blocks[picked[0]!]!.call
        const cachedPrefix = Math.max(0, (t.ctx[firstCall] ?? 0) - compactedAway - freed)
        // The first clip of a thread also takes the thinking after it.
        if (clipped.size === 0) got += args.thinkingDrop * Math.max(0, used - got - cachedPrefix)
        for (const i of picked) clipped.add(i)
        freed += got
        used -= got
        out.events++
        hadEvent = true
        out.rewrite += (Math.max(0, used - cachedPrefix) * (write - READ)) / 1e6
      }
    }
    out.saved += ((compactedAway + freed - regrown) * READ) / 1e6
  })
  return out
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const threads = transcriptFiles(projectDirs(null))
    .filter(t => t.isSubagent !== args.main && t.mtimeMs >= args.since)
    .filter(t => !args.session || t.path.includes(`/${args.session}`))
    .map(t => loadThread(t.path, args.main))
    .filter((t): t is Thread => t !== null)
  const reach = (t: Thread) => Math.max(...t.ctx)
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  // What a clip could ever reach: clearable tokens (past their head) over the
  // context at the thread's last call. The rest — thinking, text, system,
  // injections, heads — is the floor no relief lowers.
  const share = threads.map(t => {
    const last = t.ctx.length - 1
    const clearable = t.blocks.filter(b => !isProtected(b, last, args.inputKeep)).reduce((s, b) => s + b.tokens, 0)
    return clearable / Math.max(1, t.ctx[last] ?? 1)
  })
  console.log(
    `${args.main ? 'main' : 'sub-agent'} threads=${threads.length}  max ctx p50=${Math.round(median(threads.map(reach)) / 1000)}k  clearable share of the final context p50=${(100 * median(share)).toFixed(0)}%` +
      (args.compactAt
        ? `  compact-at the trigger→${args.postCompact / 1000}k`
        : `  min-event=${args.bandFloor ? 'band' : '4k'}${args.starvedCompact ? ` starved→compact@${args.postCompact / 1000}k` : ''}` +
          `${args.clipAll ? '  clip-all' : ''}${args.band !== null ? `  band=${args.band / 1000}k` : ''}  input-keep=${args.inputKeep}`) +
      `${args.thinkingDrop > 0 ? `  thinking-drop=${args.thinkingDrop}` : ''}${args.regrowth > 1 ? `  regrowth=${args.regrowth}` : ''}`,
  )
  console.log('trigger  threads-reached  events  starved  compactions  rewrite$  compact$   saved$    net$   net/reads')
  for (const trigger of args.triggers) {
    const sum: Outcome = { events: 0, starved: 0, compactions: 0, rewrite: 0, compact: 0, saved: 0, reads: 0 }
    let reached = 0
    for (const t of threads) {
      const o = simulate(t, trigger, args)
      if (reach(t) > trigger) reached++
      sum.events += o.events
      sum.starved += o.starved
      sum.compactions += o.compactions
      sum.rewrite += o.rewrite
      sum.compact += o.compact
      sum.saved += o.saved
      sum.reads += o.reads
    }
    const net = sum.saved - sum.rewrite - sum.compact
    console.log(
      `${String(trigger / 1000).padStart(5)}k  ${String(reached).padStart(15)}  ${String(sum.events).padStart(6)}  ${String(sum.starved).padStart(7)}  ${String(sum.compactions).padStart(11)}  ${sum.rewrite.toFixed(2).padStart(8)}  ${sum.compact.toFixed(2).padStart(8)}  ${sum.saved.toFixed(2).padStart(8)}  ${net.toFixed(2).padStart(7)}  ${((100 * net) / sum.reads).toFixed(1).padStart(8)}%`,
    )
  }
}

if (import.meta.main) main()
