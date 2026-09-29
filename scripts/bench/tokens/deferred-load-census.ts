#!/usr/bin/env bun
/**
 * Deferred-load census: for tools that wait behind ToolSearch, how often a
 * main-thread session made a round trip only to load one, against what
 * sending them eagerly would have cost the same sessions.
 *
 *   bun scripts/bench/tokens/deferred-load-census.ts --since=YYYY-MM-DD
 *       [--tools=AskUserQuestion,EnterPlanMode,ExitPlanMode] [--projects=<slug>]
 *       [--schema-tokens=Name:N,...]
 *
 * Main-thread transcripts only (sub-agents are not offered these tools), the
 * bench's `-tmp-*` projects skipped, and sessions split by `entrypoint`: `cli`
 * is the interactive TUI, `sdk-cli` is `-p`.
 *
 * A response whose only tool calls are ToolSearch is a load round trip. Making
 * a set of tools eager saves it only when every tool it loaded is in the set —
 * one that also loads a tool left deferred happens anyway — so each tool is
 * reported alone and all of them together.
 *
 * Cost, in uncached-input-token units (Anthropic's list-price ratios: cache
 * read x0.1, 1h cache write x2, 5m write x1.25, output x5):
 *   deferred — each saved round trip's own request, plus one cache write of
 *              the schemas it loaded (they land in the history at the load);
 *   eager    — the schemas on every request up to the first load (all of
 *              them when the session never loads): one 1h write, then a read
 *              per later request. After a load both shapes carry the schema.
 * Schema sizes are what Claudin sent on 2026-09-29 (prose chars / 3.3, JSON
 * chars / 2.8); --schema-tokens overrides them.
 *
 * Transcripts are DATA: only aggregates are printed.
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import { pad, pct, projectDirs, transcriptFiles, type Block } from './transcriptCorpus.js'

const USAGE =
  'usage: bun scripts/bench/tokens/deferred-load-census.ts --since=YYYY-MM-DD [--tools=A,B] [--projects=<slug>] [--schema-tokens=Name:N,...]'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SELECT_RE = /^select:(.+)$/
const BENCH_PROJECT_RE = /^-tmp-/
const DEFAULT_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']
const DEFAULT_SCHEMA_TOKENS: Record<string, number> = {
  AskUserQuestion: 1860,
  EnterPlanMode: 1160,
  ExitPlanMode: 1170,
}
const PRICE = { input: 1, read: 0.1, write1h: 2, write5m: 1.25, output: 5 }

type Request = {
  /** Max over the transcript entries of one message: streaming writes one per block. */
  input: number
  read: number
  write1h: number
  write5m: number
  output: number
  tools: string[]
  loaded: string[]
  called: string[]
}

type Session = { project: string; entrypoint: string; requests: Request[] }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function costOf(r: Request): number {
  return r.input * PRICE.input + r.read * PRICE.read + r.write1h * PRICE.write1h + r.write5m * PRICE.write5m + r.output * PRICE.output
}

function loadedFromQuery(query: string): string[] {
  const m = SELECT_RE.exec(query.trim())
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []
}

export function parseSession(raw: string, project: string): Session | null {
  let entrypoint = ''
  const byId = new Map<string, Request>()
  const order: Request[] = []
  const requestOfUse = new Map<string, Request>()
  const queryOfSearch = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (!line) continue
    let r: Block
    try {
      r = JSON.parse(line) as Block
    } catch {
      continue
    }
    if (!entrypoint && typeof r.entrypoint === 'string') entrypoint = r.entrypoint
    if (r.isSidechain === true) continue
    const m = r.message as Block | undefined
    const content = Array.isArray(m?.content) ? (m!.content as Block[]) : []
    if (r.type === 'assistant' && m && typeof m.id === 'string') {
      let req = byId.get(m.id)
      if (!req) {
        req = { input: 0, read: 0, write1h: 0, write5m: 0, output: 0, tools: [], loaded: [], called: [] }
        byId.set(m.id, req)
        order.push(req)
      }
      const u = (m.usage ?? {}) as Block
      const split = (u.cache_creation ?? {}) as Block
      const w1h = num(split.ephemeral_1h_input_tokens)
      const w5m = num(split.ephemeral_5m_input_tokens)
      req.input = Math.max(req.input, num(u.input_tokens))
      req.read = Math.max(req.read, num(u.cache_read_input_tokens))
      // Without the split, a write is priced as 1h: the main thread's TTL.
      req.write1h = Math.max(req.write1h, w1h + w5m > 0 ? w1h : num(u.cache_creation_input_tokens))
      req.write5m = Math.max(req.write5m, w5m)
      req.output = Math.max(req.output, num(u.output_tokens))
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
        req.tools.push(b.name)
        req.called.push(b.name)
        requestOfUse.set(b.id, req)
        if (b.name === 'ToolSearch') queryOfSearch.set(b.id, String((b.input as Block | undefined)?.query ?? ''))
      }
    } else if (r.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const query = queryOfSearch.get(b.tool_use_id)
        const req = requestOfUse.get(b.tool_use_id)
        if (query === undefined || !req) continue
        const tur = r.toolUseResult as Block | undefined
        const matches = Array.isArray(tur?.matches) ? (tur!.matches as unknown[]).filter((x): x is string => typeof x === 'string') : []
        req.loaded.push(...(matches.length > 0 ? matches : loadedFromQuery(query)))
      }
    }
  }
  if (order.length === 0) return null
  return { project, entrypoint: entrypoint || 'unknown', requests: order }
}

/** A response that only called ToolSearch. */
function isLoadRoundTrip(r: Request): boolean {
  return r.tools.length > 0 && r.tools.every(t => t === 'ToolSearch')
}

type SetResult = {
  set: string[]
  sessions: number
  requests: number
  sessionsLoading: number
  sessionsCalling: number
  savedRoundTrips: number
  deferredCost: number
  eagerCost: number
  totalCost: number
}

export function evaluateSet(sessions: readonly Session[], set: readonly string[], schemaTokens: Record<string, number>): SetResult {
  const inSet = new Set(set)
  const schema = set.reduce((s, t) => s + (schemaTokens[t] ?? 0), 0)
  const out: SetResult = { set: [...set], sessions: sessions.length, requests: 0, sessionsLoading: 0, sessionsCalling: 0, savedRoundTrips: 0, deferredCost: 0, eagerCost: 0, totalCost: 0 }
  for (const s of sessions) {
    out.requests += s.requests.length
    for (const r of s.requests) out.totalCost += costOf(r)
    const firstLoad = s.requests.findIndex(r => r.loaded.some(t => inSet.has(t)))
    if (firstLoad >= 0) out.sessionsLoading++
    if (s.requests.some(r => r.called.some(t => inSet.has(t)))) out.sessionsCalling++
    // Eager: the schemas from the first request to the first load.
    const before = firstLoad >= 0 ? firstLoad : s.requests.length
    if (before > 0) out.eagerCost += schema * (PRICE.write1h + PRICE.read * (before - 1))
    for (const r of s.requests) {
      if (!isLoadRoundTrip(r) || r.loaded.length === 0) continue
      if (!r.loaded.every(t => inSet.has(t))) continue
      out.savedRoundTrips++
      const loadedSchema = r.loaded.reduce((sum, t) => sum + (schemaTokens[t] ?? 0), 0)
      out.deferredCost += costOf(r) + loadedSchema * PRICE.write1h
    }
  }
  return out
}

function parseArgs(argv: readonly string[]) {
  const get = (k: string): string | null => {
    const a = argv.find(x => x.startsWith(`--${k}=`))
    return a ? a.slice(k.length + 3) : null
  }
  for (const a of argv) if (!['--since=', '--tools=', '--projects=', '--schema-tokens='].some(p => a.startsWith(p))) throw new Error(`unknown argument: ${a}\n${USAGE}`)
  const since = get('since') ?? ''
  if (!DATE_RE.test(since)) throw new Error(`--since=YYYY-MM-DD is required\n${USAGE}`)
  const tools = (get('tools') ?? DEFAULT_TOOLS.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const schemaTokens = { ...DEFAULT_SCHEMA_TOKENS }
  for (const pair of (get('schema-tokens') ?? '').split(',').filter(Boolean)) {
    const [name, n] = pair.split(':')
    schemaTokens[name] = Number(n)
  }
  return { since, tools, projects: get('projects'), schemaTokens }
}

function main(): void {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
  const sinceMs = Date.parse(`${args.since}T00:00:00`)
  const dirs = projectDirs(args.projects).filter(d => !BENCH_PROJECT_RE.test(basename(d)))
  const files = transcriptFiles(dirs).filter(f => !f.isSubagent && f.mtimeMs >= sinceMs)
  const sessions: Session[] = []
  for (const f of files) {
    let raw: string
    try {
      raw = readFileSync(f.path, 'utf8')
    } catch {
      continue
    }
    const s = parseSession(raw, basename(dirname(f.path)))
    if (s) sessions.push(s)
  }
  const sets = [...args.tools.map(t => [t]), ...(args.tools.length > 1 ? [args.tools] : [])]
  const kinds = [...new Set(sessions.map(s => s.entrypoint))].sort()
  console.log(`Deferred-load census since ${args.since}: ${sessions.length} main-thread sessions in ${new Set(sessions.map(s => s.project)).size} projects`)
  console.log(`schema tokens: ${args.tools.map(t => `${t} ${args.schemaTokens[t] ?? '?'}`).join(', ')}`)
  for (const kind of kinds) {
    const group = sessions.filter(s => s.entrypoint === kind)
    const requests = group.reduce((n, s) => n + s.requests.length, 0)
    console.log(`\n## entrypoint ${kind}: ${group.length} sessions, ${requests} requests`)
    console.log(`${pad('eager set', 44)} ${pad('loading', 9)} ${pad('calling', 9)} ${pad('saved trips', 12)} ${pad('deferred cost', 15)} ${pad('eager cost', 12)} ${pad('Δ eager−deferred', 18)} of spend`)
    for (const set of sets) {
      const r = evaluateSet(group, set, args.schemaTokens)
      const delta = r.eagerCost - r.deferredCost
      console.log(
        `${pad(set.join('+'), 44)} ${pad(String(r.sessionsLoading), 9)} ${pad(String(r.sessionsCalling), 9)} ${pad(String(r.savedRoundTrips), 12)} ${pad(Math.round(r.deferredCost).toLocaleString('en-US'), 15)} ${pad(Math.round(r.eagerCost).toLocaleString('en-US'), 12)} ${pad(`${delta >= 0 ? '+' : ''}${Math.round(delta).toLocaleString('en-US')}`, 18)} ${pct(Math.abs(delta), r.totalCost)}`,
      )
    }
  }
  console.log('\nΔ > 0: eager would cost more than the round trips it saves. Units: uncached input tokens at list-price ratios.')
}

if (import.meta.main) main()
