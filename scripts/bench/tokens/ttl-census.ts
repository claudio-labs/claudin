/**
 * TTL census over a wire-proxy log: where a CLI places `cache_control` and at
 * which TTL, per kind of request, and what the responses wrote at 5m and 1h.
 *
 * Claudin's tiering (`should1hCacheTTL`: main thread 1h, `agent:*` 5m, side
 * queries 5m) was inherited, not measured against what Claude Code sends now.
 * Run both CLIs through `scripts/bench/ab/wire-proxy.ts` on the same task and
 * read the two logs here.
 *
 * Groups:
 *   main        the agent loop whose system prompt the session opened with
 *   sub-agent   agent-loop requests under any other system prompt
 *   side        requests that are not the agent loop (summaries, titles, …)
 *   classifier  the auto-mode permission classifier
 *   ping        a body asking for one token (a keep-alive)
 *
 * Run:
 *   bun scripts/bench/tokens/ttl-census.ts <logDir> [label ...]
 *
 * Prints aggregates only; the bodies stay in the log.
 */
import { readdirSync } from 'fs'
import {
  isMessagesPath,
  readBody,
  readProxyRecords,
  requestKind,
} from '../ab/wire-proxy.ts'

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export type TtlRequest = { body: Json; usage: Json | null }
export type Group = 'main' | 'sub-agent' | 'side' | 'classifier' | 'ping'
export type Tally = { '5m': number; '1h': number }
export type GroupStats = {
  requests: number
  /** Distinct system prompts seen in the group (sub-agent types, roughly). */
  systems: number
  /** `cache_control` markers by where they sit, split by TTL. */
  markers: { system: Tally; tools: Tally; messages: Tally }
  write5m: number
  write1h: number
  read: number
}

function emptyStats(): GroupStats {
  const t = (): Tally => ({ '5m': 0, '1h': 0 })
  return { requests: 0, systems: 0, markers: { system: t(), tools: t(), messages: t() }, write5m: 0, write1h: 0, read: 0 }
}

const ttlOf = (block: Json): '5m' | '1h' | null => {
  const cc = block.cache_control
  if (!isRecord(cc)) return null
  return cc.ttl === '1h' ? '1h' : '5m'
}

function blocksOf(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function systemKey(body: Json): string {
  const text = typeof body.system === 'string' ? body.system : blocksOf(body.system).map(b => String(b.text ?? '')).join('\n')
  return text
}

function groupOf(body: Json, mainSystem: string | null): Group {
  if (typeof body.max_tokens === 'number' && body.max_tokens <= 1) return 'ping'
  const kind = requestKind(body)
  if (kind === 'classifier') return 'classifier'
  if (kind === 'other') return 'side'
  return systemKey(body) === mainSystem ? 'main' : 'sub-agent'
}

/** Pure core: requests in the order they were sent. */
export function ttlCensus(requests: readonly TtlRequest[]): Record<Group, GroupStats> {
  const out = {
    main: emptyStats(),
    'sub-agent': emptyStats(),
    side: emptyStats(),
    classifier: emptyStats(),
    ping: emptyStats(),
  } satisfies Record<Group, GroupStats>
  const systems = new Map<Group, Set<string>>()
  // The session opens on its main thread: the first agent-loop request names it.
  const first = requests.find(r => requestKind(r.body) === 'main' && !(typeof r.body.max_tokens === 'number' && r.body.max_tokens <= 1))
  const mainSystem = first ? systemKey(first.body) : null
  for (const { body, usage } of requests) {
    const group = groupOf(body, mainSystem)
    const s = out[group]
    s.requests++
    const seen = systems.get(group) ?? new Set<string>()
    seen.add(systemKey(body))
    systems.set(group, seen)
    for (const b of typeof body.system === 'string' ? [] : blocksOf(body.system)) {
      const ttl = ttlOf(b)
      if (ttl) s.markers.system[ttl]++
    }
    for (const t of blocksOf(body.tools)) {
      const ttl = ttlOf(t)
      if (ttl) s.markers.tools[ttl]++
    }
    for (const m of blocksOf(body.messages)) {
      for (const b of blocksOf(m.content)) {
        const ttl = ttlOf(b)
        if (ttl) s.markers.messages[ttl]++
      }
    }
    if (usage) {
      const cc = isRecord(usage.cache_creation) ? usage.cache_creation : {}
      s.write5m += Number(cc.ephemeral_5m_input_tokens ?? 0)
      s.write1h += Number(cc.ephemeral_1h_input_tokens ?? 0)
      s.read += Number(usage.cache_read_input_tokens ?? 0)
    }
  }
  for (const [group, seen] of systems) out[group].systems = seen.size
  return out
}

function formatTally(t: Tally): string {
  return t['5m'] + t['1h'] === 0 ? '-' : `5m×${t['5m']} 1h×${t['1h']}`
}

function main(): void {
  const [logDir, ...only] = process.argv.slice(2)
  if (!logDir) {
    console.error('usage: ttl-census.ts <logDir> [label ...]')
    process.exit(1)
  }
  const labels = only.length > 0
    ? only
    : readdirSync(logDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  for (const label of labels) {
    const requests = readProxyRecords(logDir, label)
      .filter(r => r.reqFile && r.status < 400 && isMessagesPath(r.path))
      .sort((a, b) => a.n - b.n)
      .map(r => ({ body: readBody(logDir, label, r.reqFile!), usage: r.response?.usage ?? null }))
    const census = ttlCensus(requests)
    console.log(`\n== ${label} (${requests.length} requests)`)
    console.log('group        reqs  systems  system markers    tools markers     message markers   write 5m / 1h        read')
    for (const [group, s] of Object.entries(census)) {
      if (s.requests === 0) continue
      console.log(
        `${group.padEnd(11)} ${String(s.requests).padStart(5)}  ${String(s.systems).padStart(7)}  ${formatTally(s.markers.system).padEnd(16)}  ${formatTally(s.markers.tools).padEnd(16)}  ${formatTally(s.markers.messages).padEnd(16)}  ${String(s.write5m).padStart(9)} / ${String(s.write1h).padEnd(9)}  ${s.read}`,
      )
    }
  }
}

if (import.meta.main) main()
