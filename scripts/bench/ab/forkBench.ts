// Shared pieces for the fork benches in this directory (`fork-vs-fresh-ab.ts`,
// `parallel-forks-probe.ts`): the deterministic fixture corpus the parent reads
// to grow its context, a per-model price table, and a transcript reader that
// attributes every API call to the agent that made it.
//
// Attribution is the part worth reading. A fork child's transcript at
// `<configDir>/projects/<cwd>/<sessionId>/subagents/agent-<id>.jsonl` MIRRORS
// the parent's history (the inherited messages are written with the parent's
// `message.id`s), so a naive sum over every file counts the parent twice per
// child. `loadSession` reads the parent first, collects its ids, and keeps only
// the ids a child file adds. Each assistant record repeats once per content
// block; the copy with the highest `output_tokens` is the final usage.
//
// `fork-clip-ab.ts` predates this module and carries its own copy of the
// fixture generator and the Sonnet price line; it was left untouched so its
// published numbers stay reproducible from the file that produced them.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, transcriptPath } from './headlessProbe.ts'

// $ per Mtok, from src/providers/usage/modelCost.ts. Kept local so the bench
// does not import the model catalog; `priceFor` matches on the model id.
export type Price = { input: number; write5m: number; write1h: number; read: number; output: number }
const PRICES: Array<[RegExp, string, Price]> = [
  [/fable-5-1/, 'fable-5-1 (10/50, read 0.25)', { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 }],
  [/opus-5/, 'opus-5 (5/25)', { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  [/sonnet-5/, 'sonnet-5 (2/10)', { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 }],
  [/sonnet-4|opus-4/, 'claude-4.x (3/15)', { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 }],
]

export function priceFor(model: string | undefined): { label: string; price: Price } {
  for (const [re, label, price] of PRICES) if (model && re.test(model)) return { label, price }
  const [, label, price] = PRICES[2]!
  return { label: `${label} (default — pass --model to price another tier)`, price }
}

export const FILE_BYTES = 50_000
export const SECRET_LINE = 300

// Env for every bench run. A Read whose rough estimate exceeds a quarter of
// the Read cap (25k → 6.25k tokens) confirms the count with the API's
// `count_tokens` endpoint (`FileReadTool/guards.ts::validateContentTokens`),
// and that endpoint is rate-limited separately from `/messages`: measured
// 2026-09-09 on Sonnet 5, each ~20k-token fixture Read stalled 2.5–4.5 min
// on its retry-after, blowing the run timeout before the fork was reached.
// Raising the cap moves the threshold above the fixture size, so the
// estimate is used and no counting request is sent. Nothing under test
// (fork messages, cache markers, TTL) reads this value.
export const BENCH_ENV: Record<string, string> = { CLAUDIN_FILE_READ_MAX_OUTPUT_TOKENS: '100000' }

// xorshift32 — deterministic pseudo-prose so runs are comparable and nothing
// on disk is anyone's real text.
function makeRng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 0xffffffff
  }
}

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega buffer cursor index vector matrix tensor kernel socket packet frame header footer schema record field column table query index cache prefix marker token budget window relief clip stub'.split(' ')

/** ~50 KB of numbered lines (~20k tokens); `secret` replaces line SECRET_LINE. */
export function fixture(seed: number, secret?: string): { text: string; lines: number } {
  const rng = makeRng(seed)
  const lines: string[] = []
  let bytes = 0
  while (bytes < FILE_BYTES) {
    const n = 8 + Math.floor(rng() * 8)
    const words: string[] = []
    for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)]!)
    const line = `${String(lines.length + 1).padStart(4, '0')} ${words.join(' ')}.`
    lines.push(line)
    bytes += line.length + 1
  }
  if (secret) lines[SECRET_LINE - 1] = `SECRET_TOKEN=${secret}`
  return { text: lines.join('\n') + '\n', lines: lines.length }
}

export type Usage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

export type Call = {
  id: string
  /** ms since epoch of the record (first copy seen). */
  ts: number
  in: number
  read: number
  write5m: number
  write1h: number
  out: number
  tools: string[]
}

export type AgentCalls = {
  agentId: string
  /** `fork` for a context-inheriting child, else the named agent type. */
  agentType: string
  description: string
  calls: Call[]
}

export type Session = { parent: Call[]; children: AgentCalls[] }

export type CostSplit = { input: number; write: number; read: number; output: number; total: number }

export function ctx(c: Call): number {
  return c.in + c.read + c.write5m + c.write1h
}

export function cost(calls: Call[], p: Price): CostSplit {
  const s = { input: 0, write: 0, read: 0, output: 0, total: 0 }
  for (const c of calls) {
    s.input += (c.in * p.input) / 1e6
    s.write += (c.write5m * p.write5m + c.write1h * p.write1h) / 1e6
    s.read += (c.read * p.read) / 1e6
    s.output += (c.out * p.output) / 1e6
  }
  s.total = s.input + s.write + s.read + s.output
  return s
}

function toCall(id: string, ts: number, u: Usage): Call {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens
  const split = w5 !== undefined || w1h !== undefined
  return {
    id,
    ts,
    in: u.input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    // Without the split the tier is unknown; charge it as 1h (the fork tier).
    write5m: split ? (w5 ?? 0) : 0,
    write1h: split ? (w1h ?? 0) : (u.cache_creation_input_tokens ?? 0),
    out: u.output_tokens ?? 0,
    tools: [],
  }
}

/** Assistant calls in one transcript, deduped by message.id, minus `exclude`. */
function readCalls(path: string, exclude: ReadonlySet<string>): Call[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const byId = new Map<string, { call: Call; out: number }>()
  const order: string[] = []
  const seenTool = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(line) } catch { continue }
    if (v.type !== 'assistant') continue
    const m = (v.message ?? {}) as Record<string, unknown>
    const id = String(m.id ?? '')
    const u = m.usage as Usage | undefined
    if (!id || !u || exclude.has(id)) continue
    const ts = Date.parse(String(v.timestamp ?? '')) || 0
    let e = byId.get(id)
    if (!e) {
      e = { call: toCall(id, ts, u), out: u.output_tokens ?? 0 }
      byId.set(id, e)
      order.push(id)
    } else if ((u.output_tokens ?? 0) >= e.out) {
      e.call = { ...toCall(id, e.call.ts, u), tools: e.call.tools }
      e.out = u.output_tokens ?? 0
    }
    for (const b of (m.content ?? []) as Array<Record<string, unknown>>) {
      if (b.type !== 'tool_use') continue
      const tid = String(b.id ?? '')
      if (seenTool.has(tid)) continue
      seenTool.add(tid)
      e.call.tools.push(String(b.name))
    }
  }
  return order.map(id => byId.get(id)!.call)
}

/** Parent calls plus each sub-agent's OWN calls (parent ids removed). */
export function loadSession(cwd: string, sessionId: string): Session {
  const parentPath = transcriptPath(cwd, sessionId)
  const parent = readCalls(parentPath, new Set())
  const parentIds = new Set(parent.map(c => c.id))
  const dir = join(configDir(), 'projects', cwd.replace(/\//g, '-'), sessionId, 'subagents')
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()
  } catch {
    names = []
  }
  const children: AgentCalls[] = []
  for (const name of names) {
    const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
    let meta: { agentType?: string; description?: string } = {}
    try {
      meta = JSON.parse(readFileSync(join(dir, name.replace(/\.jsonl$/, '.meta.json')), 'utf8'))
    } catch { /* older transcript without meta */ }
    children.push({
      agentId,
      agentType: meta.agentType ?? 'unknown',
      description: meta.description ?? '',
      calls: readCalls(join(dir, name), parentIds),
    })
  }
  return { parent, children }
}

/** The parent call that spawned agents (its tool_use list holds `Agent`). */
export function spawnCall(parent: Call[]): Call | undefined {
  return parent.find(c => c.tools.includes('Agent'))
}

/** First parent call after `ts` — the request that carries the agents' results. */
export function callAfter(parent: Call[], ts: number): Call | undefined {
  return parent.find(c => c.ts > ts)
}

export function range(xs: number[], digits = 3): string {
  return xs.length ? `${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}` : '–'
}

export function rangesOverlap(a: number[], b: number[]): boolean {
  return Math.min(...a) <= Math.max(...b) && Math.min(...b) <= Math.max(...a)
}
