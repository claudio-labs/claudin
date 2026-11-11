/**
 * Keep-alive simulator: what pinging the MAIN thread's 1h prompt cache through
 * an idle gap would have cost and saved on recorded sessions, per model price.
 *
 * `src/agent/cache/anthropic/keepAlive.ts` pings the 5m tier only. The main
 * thread writes at 1h, every read of the prefix refreshes that hour, and after
 * more than 60 minutes without a request the next one writes the whole prefix
 * again. A ping (the last body with `max_tokens: 1`) is one cache READ of the
 * context and buys another hour. A scratch version of this on 2026-10-30 came
 * to +$13.9 of rewrites avoided against −$13.5 of extra reads, +$0.59 in five
 * days at Opus 5.5 prices, where a write costs 40 reads. On Fable 5.2 it costs
 * 80, which is the question this answers.
 *
 * The model. Main-thread API calls in order, one per assistant `message.id`;
 * context = input + cache read + cache write. Policy K pings at `--ping-min`
 * (55) minutes of idle and every 55 after that, at most K times, so a gap G
 * gets pings = min(K, floor(G / 55)) and the cache is warm until
 * pings × 55 + 60 minutes. A gap over 60 minutes is an expiry today. Three
 * terms, per gap between two calls of a thread:
 *
 *   rewrites avoided  an expiry the policy keeps warm: (W − tail) tokens stop
 *                     being written at the 1h price and are read instead, so
 *                     they are worth (write1h − read). W is what the call
 *                     after the gap wrote; `tail` is what it would have
 *                     written anyway, estimated as the thread's median write
 *                     after a gap under 5 minutes;
 *   pings             pings × context before the gap × read, whether the gap
 *                     was covered, too long for K (wasted) or under 60 minutes
 *                     (55–60: one wasted ping);
 *   extra reads       the term that cancelled the saving at Opus 5.5 prices.
 *                     When the cache is already cold the harness clips old
 *                     tool results for free before the rewrite (the idle-gap
 *                     clip, `microCompact.ts`), so the context after the gap
 *                     is smaller than before it. A warm cache gets no such
 *                     clip: max(0, before − after) tokens are read on every
 *                     later call until a reset — a gap the policy does not
 *                     cover, a call whose context is ≥20% smaller than the one
 *                     before it (a relief clip or a compaction), a compact
 *                     boundary, or the end of the thread. Covered gaps add up.
 *
 * Each term is priced with the recorded model of the call that pays it, and
 * again as if every call were on each `--as=<model>`. Prices come from
 * `priceFor` in session-census.ts, the mirror its test compares with
 * modelCost.ts; the rates used are printed.
 *
 * What it cannot see:
 *   - the subscription quota's weighting of a ping. A ping is a request; if
 *     the plan counts a cache read at more than its API price, pings cost
 *     more than this says (`docs/tech/cache/keep-alive.md`);
 *   - a clip that would have happened later anyway. The extra reads run to
 *     the next RECORDED reset, but a thread that kept its old tool results
 *     reaches the window-lane relief sooner than the recorded one did. That
 *     ends the extra reads earlier than modeled, and charges a rewrite the
 *     idle-gap clip had made free; neither is counted;
 *   - whether a process was there to ping. A gap that spans a quit and a
 *     `--resume` counts as covered, and its pings as sent. And the pings after
 *     a thread's LAST call are not in the net at all: the policy cannot know
 *     the user is gone. `end pings` prints their ceiling (up to K per thread,
 *     if every process stayed open) next to the net;
 *   - a compaction inside a covered gap. The drop there is the summary, not
 *     an idle clip, so the gap gets its pings and neither a saving nor extra
 *     reads; the summary call's own read of a warm prefix is not in the
 *     transcript;
 *   - a fork that read the prefix during the gap (`extract_memories`,
 *     `auto_dream`). W is then small and the saving with it, but the gap
 *     still counts as an expiry: `rewrote` says how many really wrote half
 *     their context or more.
 *
 * Calls are bounded by their own timestamp, so a session's first call in the
 * window has no gap before it. A call copied into a second transcript (a
 * branch, a fork) counts once, in the first file by path.
 *
 * Run:
 *   bun scripts/bench/tokens/keepalive-sim.ts --since=2026-11-04 --as=claude-opus-5-5 --as=claude-fable-5-2
 *   bun scripts/bench/tokens/keepalive-sim.ts --since=2026-11-04 --exclude=d44cf59f --ping-min=50
 *
 * Transcripts are DATA: only aggregates and 8-char session ids are printed.
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import { priceFor } from './session-census.js'
import { pad, padLeft, projectDirs, transcriptFiles } from './transcriptCorpus.js'

const MIN_MS = 60_000
const DAY_MS = 24 * 60 * MIN_MS
const TTL_MIN = 60
const DEFAULT_PING_MIN = 55
/** A call this soon after the last one wrote only its own tail. */
const TAIL_GAP_MIN = 5
/** A context this much smaller than the previous call's is a clip or a compaction. */
const RESET_DROP = 0.2
const POLICIES = [1, 2, 3] as const
const LARGEST_GAPS = 5

// ---------------------------------------------------------------------------
// Gap model (pure; tested in keepalive-sim.test.ts)
// ---------------------------------------------------------------------------

export type Rates = ReturnType<typeof priceFor>

export type Call = {
  readonly atMs: number
  readonly model: string
  readonly input: number
  readonly read: number
  readonly write5m: number
  readonly write1h: number
  readonly output: number
  /** A compact boundary sits between this call and the one before it. */
  readonly afterCompact?: boolean
}

type Policy = { maxPings: number; pingMin: number }

type CoveredGap = {
  gapMin: number
  pings: number
  before: number
  after: number
  tail: number
  tokensAvoided: number
  /** Calls after the gap that read the un-clipped context. */
  callsUntilReset: number
}

type Outcome = {
  /** Gaps over the TTL: the prefix expires today. */
  expiries: number
  /** Of those, the ones whose next call wrote half its context or more. */
  rewrote: number
  covered: number
  /** Covered gaps with a compact boundary in them: pings, no saving, no extra reads. */
  compacted: number
  usefulPings: number
  wastedPings: number
  avoidedUsd: number
  pingUsd: number
  extraReadUsd: number
  gaps: CoveredGap[]
}

export const contextOf = (c: Call): number => c.input + c.read + c.write5m + c.write1h
const writtenBy = (c: Call): number => c.write5m + c.write1h
export const netOf = (o: Pick<Outcome, 'avoidedUsd' | 'pingUsd' | 'extraReadUsd'>): number =>
  o.avoidedUsd - o.pingUsd - o.extraReadUsd

function median(xs: readonly number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
}

/** What a gap of `gapMin` minutes gets under a policy. */
export function planGap(gapMin: number, policy: Policy): { pings: number; expired: boolean; covered: boolean } {
  const pings = Math.min(policy.maxPings, Math.floor(gapMin / policy.pingMin))
  const expired = gapMin > TTL_MIN
  return { pings, expired, covered: expired && gapMin <= pings * policy.pingMin + TTL_MIN }
}

/** What a call writes with the cache warm: the thread's median write after a short gap. */
export function tailEstimate(calls: readonly Call[]): number {
  const tails: number[] = []
  for (let i = 1; i < calls.length; i++) {
    if (calls[i]!.atMs - calls[i - 1]!.atMs < TAIL_GAP_MIN * MIN_MS) tails.push(writtenBy(calls[i]!))
  }
  return median(tails)
}

/** One thread's calls in time order, replayed under a policy. */
export function simulateThread(
  calls: readonly Call[],
  policy: Policy,
  rateOf: (c: Call) => Rates,
  tail: number = tailEstimate(calls),
): Outcome {
  const out: Outcome = {
    expiries: 0,
    rewrote: 0,
    covered: 0,
    compacted: 0,
    usefulPings: 0,
    wastedPings: 0,
    avoidedUsd: 0,
    pingUsd: 0,
    extraReadUsd: 0,
    gaps: [],
  }
  // Tokens the warm thread still holds that the recorded one clipped for free.
  let carry = 0
  let open: CoveredGap[] = []
  const reset = (): void => {
    carry = 0
    open = []
  }
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]!
    const cur = calls[i]!
    const gapMin = (cur.atMs - prev.atMs) / MIN_MS
    const before = contextOf(prev)
    const after = contextOf(cur)
    const plan = planGap(gapMin, policy)
    // A ping re-sends the last body. The carried tokens it would also read are
    // left out: a few pings against the hundreds of calls that read them below.
    out.pingUsd += (plan.pings * before * rateOf(prev).read) / 1e6
    if (plan.expired) {
      out.expiries++
      if (writtenBy(cur) >= after / 2) out.rewrote++
    }
    if (!plan.covered) {
      out.wastedPings += plan.pings
      // The prefix expires under the policy too, or the recorded thread shrank
      // on its own: either way the clip the policy skipped has now happened.
      if (plan.expired || cur.afterCompact || after <= before * (1 - RESET_DROP)) reset()
    } else {
      out.covered++
      out.usefulPings += plan.pings
      if (cur.afterCompact) {
        out.compacted++
        reset()
      } else {
        const tokensAvoided = Math.max(0, writtenBy(cur) - tail)
        const rates = rateOf(cur)
        out.avoidedUsd += (tokensAvoided * (rates.write1h - rates.read)) / 1e6
        carry += Math.max(0, before - after)
        const gap: CoveredGap = { gapMin, pings: plan.pings, before, after, tail, tokensAvoided, callsUntilReset: 0 }
        out.gaps.push(gap)
        open.push(gap)
      }
    }
    out.extraReadUsd += (carry * rateOf(cur).read) / 1e6
    for (const gap of open) gap.callsUntilReset++
  }
  return out
}

/** What the calls cost as recorded: the main-thread spend the net is compared with. */
export function spendOf(calls: readonly Call[], rateOf: (c: Call) => Rates): number {
  let usd = 0
  for (const c of calls) {
    const r = rateOf(c)
    usd += (c.input * r.input + c.write5m * r.write5m + c.write1h * r.write1h + c.read * r.read + c.output * r.output) / 1e6
  }
  return usd
}

/** Pings after a thread's last call, if its process stayed open: a ceiling, not in the net. */
export function endPingsUsd(calls: readonly Call[], policy: Policy, rateOf: (c: Call) => Rates, nowMs: number): number {
  const last = calls.at(-1)
  if (!last) return 0
  const pings = Math.min(policy.maxPings, Math.floor((nowMs - last.atMs) / MIN_MS / policy.pingMin))
  return (Math.max(0, pings) * contextOf(last) * rateOf(last).read) / 1e6
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Args = { since: number; exclude: string[]; as: string[]; pingMin: number }

export function parseArgs(argv: readonly string[], nowMs: number = Date.now()): Args {
  const a: Args = { since: nowMs - 7 * DAY_MS, exclude: [], as: [], pingMin: DEFAULT_PING_MIN }
  for (const s of argv) {
    if (s.startsWith('--since=')) a.since = Date.parse(`${s.slice(8)}T00:00:00Z`)
    else if (s.startsWith('--exclude=')) a.exclude.push(s.slice(10))
    else if (s.startsWith('--as=')) a.as.push(s.slice(5))
    else if (s.startsWith('--ping-min=')) a.pingMin = Number(s.slice(11))
  }
  if (Number.isNaN(a.since)) throw new Error('--since must be YYYY-MM-DD')
  // A ping at or past the TTL reads nothing: it is the rewrite it was meant to avoid.
  if (!(a.pingMin > 0 && a.pingMin < TTL_MIN)) throw new Error(`--ping-min must be between 0 and ${TTL_MIN} minutes`)
  return a
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

type Rec = {
  type?: string
  subtype?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { id?: string; model?: string; usage?: Usage }
}

type Thread = { id: string; calls: Call[] }

let tornLines = 0

/** A streamed message is several records under one id: the final usage, the first timestamp. */
function toCall(atMs: number, model: string, u: Usage, afterCompact: boolean): Call {
  const written = u.cache_creation_input_tokens ?? 0
  const split = u.cache_creation
  // No split recorded: the main thread writes at 1h.
  const write5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : 0
  const write1h = split ? (split.ephemeral_1h_input_tokens ?? 0) : written
  return {
    atMs,
    model,
    input: u.input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    write5m,
    write1h,
    output: u.output_tokens ?? 0,
    ...(afterCompact ? { afterCompact } : {}),
  }
}

/** One main transcript's API calls inside the window, in time order. */
function readThread(path: string, since: number, seen: Set<string>): Thread {
  type Pending = { atMs: number; model: string; usage: Usage; afterCompact: boolean }
  const byId = new Map<string, Pending>()
  let compactPending = false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let r: Rec
    try {
      r = JSON.parse(line) as Rec
    } catch {
      // A torn last line from a session still being written; reported at the end.
      tornLines++
      continue
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      compactPending = true
      continue
    }
    const m = r.message
    if (r.type !== 'assistant' || r.isSidechain === true || !m?.id || !m.usage || m.model === '<synthetic>') continue
    const known = byId.get(m.id)
    if (!known) {
      byId.set(m.id, { atMs: Date.parse(r.timestamp ?? ''), model: m.model ?? '', usage: m.usage, afterCompact: compactPending })
      compactPending = false
      continue
    }
    const split = known.usage.cache_creation ?? m.usage.cache_creation
    if ((m.usage.output_tokens ?? 0) >= (known.usage.output_tokens ?? 0)) known.usage = m.usage
    if (split && !known.usage.cache_creation) known.usage = { ...known.usage, cache_creation: split }
  }
  const calls: Call[] = []
  for (const [id, p] of byId) {
    if (seen.has(id)) continue
    seen.add(id)
    const call = toCall(p.atMs, p.model, p.usage, p.afterCompact)
    if (!(call.atMs >= since) || contextOf(call) + call.output === 0) continue
    calls.push(call)
  }
  calls.sort((a, b) => a.atMs - b.atMs)
  return { id: basename(path, '.jsonl').slice(0, 8), calls }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type Pricing = { label: string; rateOf: (c: Call) => Rates }

const usd = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const signed = (n: number): string => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`
const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

function main(): void {
  const now = Date.now()
  const args = parseArgs(process.argv.slice(2), now)
  const seen = new Set<string>()
  const files = transcriptFiles(projectDirs(null), (now - args.since) / DAY_MS + 1)
    .filter(f => !f.isSubagent)
    .filter(f => !basename(dirname(f.path)).startsWith('-tmp') && !f.path.includes('/-tmp'))
    .filter(f => !args.exclude.some(prefix => basename(f.path).startsWith(prefix)))
    .sort((a, b) => a.path.localeCompare(b.path))
  const threads = files.map(f => readThread(f.path, args.since, seen)).filter(t => t.calls.length > 0)
  const windowDays = (now - args.since) / DAY_MS
  const calls = threads.reduce((n, t) => n + t.calls.length, 0)
  const projects = new Set(files.map(f => basename(dirname(f.path))))

  console.log(`=== KEEP-ALIVE 1H SIM since ${new Date(args.since).toISOString().slice(0, 10)} ===`)
  console.log(
    `window=${windowDays.toFixed(1)}d  main threads=${threads.length}  calls=${calls}  projects=${projects.size}` +
      `  ping at ${args.pingMin}min then every ${args.pingMin}min, TTL ${TTL_MIN}min` +
      (args.exclude.length > 0 ? `  excluded=${args.exclude.join(',')}` : ''),
  )
  if (tornLines > 0) console.log(`(${tornLines} unparsable transcript lines skipped)`)

  const models = new Map<string, number>()
  for (const t of threads) for (const c of t.calls) models.set(c.model, (models.get(c.model) ?? 0) + 1)
  console.log(`recorded models: ${[...models].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}×${n}`).join('  ')}`)
  console.log('\nrates, $/Mtok (priceFor in session-census.ts):')
  for (const model of new Set([...args.as, ...models.keys()])) {
    const r = priceFor(model)
    console.log(
      `  ${pad(model, 22)} input ${r.input}  write5m ${r.write5m}  write1h ${r.write1h}  read ${r.read}  output ${r.output}` +
        `  (one 1h write = ${Math.round(r.write1h / r.read)} reads)`,
    )
  }

  const pricings: Pricing[] = [
    { label: 'as recorded', rateOf: c => priceFor(c.model, contextOf(c)) },
    ...args.as.map(model => ({ label: `as ${model}`, rateOf: (c: Call) => priceFor(model, contextOf(c)) })),
  ]
  const labelWidth = Math.max(...pricings.map(p => p.label.length))

  console.log(
    `\n${pad('pricing', labelWidth)}  K  expiries  rewrote  covered  pings useful/wasted  avoided$   pings$  extra reads$      net$  net/week  % of main   main$  end pings≤`,
  )
  let widest: Array<CoveredGap & { session: string }> = []
  let compacted = 0
  for (const pricing of pricings) {
    const main$ = threads.reduce((s, t) => s + spendOf(t.calls, pricing.rateOf), 0)
    for (const maxPings of POLICIES) {
      const policy: Policy = { maxPings, pingMin: args.pingMin }
      const sum = { expiries: 0, rewrote: 0, covered: 0, usefulPings: 0, wastedPings: 0, avoidedUsd: 0, pingUsd: 0, extraReadUsd: 0 }
      let endPings = 0
      const gaps: Array<CoveredGap & { session: string }> = []
      let compactedHere = 0
      for (const t of threads) {
        const o = simulateThread(t.calls, policy, pricing.rateOf)
        sum.expiries += o.expiries
        sum.rewrote += o.rewrote
        sum.covered += o.covered
        sum.usefulPings += o.usefulPings
        sum.wastedPings += o.wastedPings
        sum.avoidedUsd += o.avoidedUsd
        sum.pingUsd += o.pingUsd
        sum.extraReadUsd += o.extraReadUsd
        compactedHere += o.compacted
        endPings += endPingsUsd(t.calls, policy, pricing.rateOf, now)
        for (const g of o.gaps) gaps.push({ ...g, session: t.id })
      }
      // The gaps are the same under every pricing; keep the widest policy's.
      if (pricing === pricings[0] && maxPings === POLICIES.at(-1)) {
        widest = gaps
        compacted = compactedHere
      }
      const net = netOf(sum)
      console.log(
        `${pad(pricing.label, labelWidth)}  ${maxPings}  ${padLeft(String(sum.expiries), 8)}  ${padLeft(String(sum.rewrote), 7)}  ${padLeft(String(sum.covered), 7)}  ` +
          `${padLeft(`${sum.usefulPings} / ${sum.wastedPings}`, 19)}  ${padLeft(usd(sum.avoidedUsd), 8)}  ${padLeft(usd(sum.pingUsd), 7)}  ${padLeft(usd(sum.extraReadUsd), 12)}  ` +
          `${padLeft(signed(net), 8)}  ${padLeft(signed((net * 7) / windowDays), 8)}  ${padLeft(`${((100 * net) / Math.max(main$, 1e-9)).toFixed(2)}%`, 9)}  ${padLeft(usd(main$), 6)}  ${padLeft(usd(endPings), 10)}`,
      )
    }
  }

  const tails = widest.map(g => g.tail)
  console.log(
    `\ntail estimate (a thread's median write after a gap under ${TAIL_GAP_MIN}min), over the ${widest.length} gaps K=${POLICIES.at(-1)} covers: ` +
      (tails.length > 0 ? `p50 ${k(median(tails))}  min ${k(Math.min(...tails))}  max ${k(Math.max(...tails))} tokens` : 'none'),
  )
  if (compacted > 0) {
    console.log(`${compacted} covered gap(s) had a compaction in them: pings counted, no saving and no extra reads.`)
  }
  console.log(`end pings≤ is NOT in the net: up to K pings after each thread's last call, if its process stayed open.`)

  console.log(`\n${LARGEST_GAPS} largest covered gaps (K=${POLICIES.at(-1)}, by tokens avoided):`)
  console.log(`${pad('session', 9)} ${padLeft('minutes', 7)} ${padLeft('pings', 5)} ${padLeft('ctx before→after', 17)} ${padLeft('tail', 6)} ${padLeft('avoided', 8)} ${padLeft('calls until reset', 17)}`)
  for (const g of [...widest].sort((a, b) => b.tokensAvoided - a.tokensAvoided).slice(0, LARGEST_GAPS)) {
    console.log(
      `${pad(g.session, 9)} ${padLeft(g.gapMin.toFixed(0), 7)} ${padLeft(String(g.pings), 5)} ${padLeft(`${k(g.before)}→${k(g.after)}`, 17)} ${padLeft(k(g.tail), 6)} ${padLeft(k(g.tokensAvoided), 8)} ${padLeft(String(g.callsUntilReset), 17)}`,
    )
  }
}

if (import.meta.main) main()
