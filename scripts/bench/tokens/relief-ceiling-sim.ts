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
 * Run:
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-09-26
 *   bun scripts/bench/tokens/relief-ceiling-sim.ts --since=2026-09-26 --session=501d7261 --triggers=250000,300000,400000
 *
 * Transcripts are DATA: only aggregates are printed.
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import { contentText, projectDirs, transcriptFiles } from './transcriptCorpus.js'

const CHARS_PER_TOKEN = 3
const HEAD_CHARS = 2_000
const KEEP_RECENT_CALLS = 2
const BAND_MIN = 60_000
const BAND_TRIGGER_FRACTION = 0.15
const BAND_MAX_FRACTION = 0.3
const MIN_EVENT_TOKENS = 4_000
// Opus 5.x, $/Mtok (mirror of modelCost.ts).
const READ = 0.5
const WRITE_5M = 6.25

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

type Args = { since: number; session: string | null; triggers: number[] }

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const since = Date.parse(`${get('since') ?? '2026-09-26'}T00:00:00`)
  if (Number.isNaN(since)) throw new Error('--since=YYYY-MM-DD')
  const triggers = (get('triggers') ?? '200000,250000,300000,400000,500000').split(',').map(Number)
  return { since, session: get('session') ?? null, triggers }
}

type Block = { call: number; tokens: number }
type Thread = { name: string; ctx: number[]; blocks: Block[] }

function loadThread(path: string): Thread | null {
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
        if (chars > 0) blocks.push({ call, tokens: chars / CHARS_PER_TOKEN })
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
  const session = basename(dirname(dirname(path))).slice(0, 8)
  return { name: `${session}/${basename(path, '.jsonl')}`, ctx: order.map(id => ctxById.get(id) ?? 0), blocks }
}

type Outcome = { events: number; starved: number; rewrite: number; saved: number; reads: number }

function simulate(t: Thread, trigger: number): Outcome {
  const band = Math.min(Math.max(BAND_MIN, trigger * BAND_TRIGGER_FRACTION), trigger * BAND_MAX_FRACTION)
  const target = trigger - band
  const clipped = new Set<number>()
  let freed = 0
  const out: Outcome = { events: 0, starved: 0, rewrite: 0, saved: 0, reads: 0 }
  t.ctx.forEach((ctx, k) => {
    out.reads += (ctx * READ) / 1e6
    let used = ctx - freed
    if (used > trigger) {
      let got = 0
      const picked: number[] = []
      t.blocks.forEach((b, i) => {
        if (got >= used - target || clipped.has(i) || b.call >= k - KEEP_RECENT_CALLS) return
        picked.push(i)
        got += b.tokens
      })
      if (got < MIN_EVENT_TOKENS) out.starved++
      else {
        // The prefix up to the oldest newly clipped block still reads from
        // cache: clips go oldest-first, so everything freed before now sits
        // behind it. Only the rest of the prompt is written again.
        const firstCall = t.blocks[picked[0]!]!.call
        const cachedPrefix = Math.max(0, (t.ctx[firstCall] ?? 0) - freed)
        for (const i of picked) clipped.add(i)
        freed += got
        used -= got
        out.events++
        out.rewrite += (Math.max(0, used - cachedPrefix) * (WRITE_5M - READ)) / 1e6
      }
    }
    out.saved += (freed * READ) / 1e6
  })
  return out
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const threads = transcriptFiles(projectDirs(null))
    .filter(t => t.isSubagent && t.mtimeMs >= args.since)
    .filter(t => !args.session || t.path.includes(`/${args.session}`))
    .map(t => loadThread(t.path))
    .filter((t): t is Thread => t !== null)
  const reach = (t: Thread) => Math.max(...t.ctx)
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  // What a clip could ever reach: clearable tokens (past their head) over the
  // context at the thread's last call. The rest — thinking, text, system,
  // injections, heads — is the floor no relief lowers.
  const share = threads.map(t => {
    const last = t.ctx.length - 1
    const clearable = t.blocks.filter(b => b.call < last - KEEP_RECENT_CALLS).reduce((s, b) => s + b.tokens, 0)
    return clearable / Math.max(1, t.ctx[last] ?? 1)
  })
  console.log(`sub-agent threads=${threads.length}  max ctx p50=${Math.round(median(threads.map(reach)) / 1000)}k  clearable share of the final context p50=${(100 * median(share)).toFixed(0)}%`)
  console.log('trigger  threads-reached  events  starved  rewrite$   saved$    net$   net/reads')
  for (const trigger of args.triggers) {
    const sum: Outcome = { events: 0, starved: 0, rewrite: 0, saved: 0, reads: 0 }
    let reached = 0
    for (const t of threads) {
      const o = simulate(t, trigger)
      if (reach(t) > trigger) reached++
      sum.events += o.events
      sum.starved += o.starved
      sum.rewrite += o.rewrite
      sum.saved += o.saved
      sum.reads += o.reads
    }
    const net = sum.saved - sum.rewrite
    console.log(
      `${String(trigger / 1000).padStart(5)}k  ${String(reached).padStart(15)}  ${String(sum.events).padStart(6)}  ${String(sum.starved).padStart(7)}  ${sum.rewrite.toFixed(2).padStart(8)}  ${sum.saved.toFixed(2).padStart(8)}  ${net.toFixed(2).padStart(7)}  ${((100 * net) / sum.reads).toFixed(1).padStart(8)}%`,
    )
  }
}

main()
