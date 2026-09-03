/**
 * Usage/tool accounting shared by the CLI A/B benches: stream-json parsing,
 * per-message usage timelines (deduped by message id across the stream and
 * the transcript), tool-call extraction and a list-price cost estimate.
 * Extracted from cli-search-edit-ab.ts so context-relief-ab.ts can reuse it
 * without importing that script's main().
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Stream/transcript parsing.
//
// Same rules as `build-tool-ab.ts` (:186, :200, :226, :284): dedupe usage rows
// by message id, and read the on-disk transcript as well as the stream. Three
// deviations, all deliberate and all load-bearing:
//  - MAX per field per message id, not last-wins: usage rows are emitted per
//    CONTENT BLOCK, sharing one id, and output_tokens GROWS as the message
//    streams while the input/cache terms repeat.
//  - the stream and the transcript are MERGED, not one a fallback for the
//    other. Measured 2026-08-12: claude's stream carries an EARLY usage
//    snapshot, so its stream output summed to 242 tokens against the
//    transcript's 4,333 — a 17.9x undercount on the one column where the two
//    CLIs disagree about when usage is flushed (in/cacheR/cacheW matched to the
//    token). Claudin's stream and transcript agreed exactly on that same run,
//    so a fallback keyed on "the stream is empty" would have fired for neither.
//  - the transcript is looked up in both ~/.claudin/projects and
//    ~/.claude/projects, since the two CLIs write to different roots.
// ---------------------------------------------------------------------------

export type TimelineRow = { in: number; out: number; cR: number; cW: number }

export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      // A truncated final line is expected while a run is in flight.
    }
  }
  return out
}

export function timelineFrom(sources: Record<string, unknown>[][]): TimelineRow[] {
  const byId = new Map<string, TimelineRow & { order: number }>()
  let order = 0
  sources.forEach((events, si) => {
    let anon = 0
    for (const v of events) {
      if (v.type !== 'assistant') continue
      const msg = (v.message ?? {}) as Record<string, unknown>
      const u = msg.usage as Record<string, unknown> | undefined
      if (!u) continue
      // The anon key is per SOURCE: an id-less row in the stream and one in the
      // transcript are different messages and must not merge into each other.
      const id = String(msg.id ?? `__anon_${si}_${anon++}`)
      const row: TimelineRow = {
        in: Number(u.input_tokens ?? 0),
        out: Number(u.output_tokens ?? 0),
        cR: Number(u.cache_read_input_tokens ?? 0),
        cW: Number(u.cache_creation_input_tokens ?? 0),
      }
      const prev = byId.get(id)
      if (!prev) {
        byId.set(id, { ...row, order: order++ })
        continue
      }
      byId.set(id, {
        in: Math.max(prev.in, row.in),
        out: Math.max(prev.out, row.out),
        cR: Math.max(prev.cR, row.cR),
        cW: Math.max(prev.cW, row.cW),
        order: prev.order,
      })
    }
  })
  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...r }) => r)
}

export function sessionIdFrom(events: Record<string, unknown>[]): string | null {
  for (const v of events) {
    if (v.type === 'system' && v.subtype === 'init' && typeof v.session_id === 'string') return v.session_id
  }
  return null
}

export function transcriptPath(sessionId: string): string | null {
  const roots = [process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin'), join(homedir(), '.claude')]
  for (const root of roots) {
    const projectsDir = join(root, 'projects')
    if (!existsSync(projectsDir)) continue
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function scalarsFrom(events: Record<string, unknown>[]): {
  costUsd: number | null
  numTurns: number | null
  model: string | null
} {
  let costUsd: number | null = null
  let numTurns: number | null = null
  let model: string | null = null
  for (const v of events) {
    if (v.type === 'assistant') {
      const msg = (v.message ?? {}) as Record<string, unknown>
      if (typeof msg.model === 'string' && !model) model = msg.model
    }
    if (v.type !== 'result') continue
    if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd
    if (typeof v.num_turns === 'number') numTurns = v.num_turns
  }
  return { costUsd, numTurns, model }
}

// ---------------------------------------------------------------------------
// Tool accounting — the half of the comparison the token totals cannot show.
// ---------------------------------------------------------------------------

/** Bash that is really a code search: the lane each CLI's Grep/Glob replaces. */
const BASH_SEARCH_RE = /\b(rg|grep|ag|ack|find|fd|ls -R|sed -n)\b/

export type ToolCall = { name: string; id: string; search: boolean; resultChars: number }

export function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
  const calls: ToolCall[] = []
  const resultChars = new Map<string, number>()

  for (const v of events) {
    if (v.type !== 'user') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const body = block.content
      const chars =
        typeof body === 'string'
          ? body.length
          : Array.isArray(body)
            ? (body as Record<string, unknown>[]).reduce((a, b) => a + (typeof b.text === 'string' ? b.text.length : 0), 0)
            : 0
      resultChars.set(block.tool_use_id, (resultChars.get(block.tool_use_id) ?? 0) + chars)
    }
  }

  for (const v of events) {
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const id = typeof block.id === 'string' ? block.id : ''
      if (id && calls.some(c => c.id === id)) continue
      const input = (block.input ?? {}) as Record<string, unknown>
      const command = typeof input.command === 'string' ? input.command : ''
      const search =
        block.name === 'Grep' ||
        block.name === 'Glob' ||
        block.name === 'Search' ||
        (block.name === 'Bash' && BASH_SEARCH_RE.test(command))
      calls.push({ name: block.name, id, search, resultChars: resultChars.get(id) ?? 0 })
    }
  }
  return calls
}

/** Public list price, USD per 1M: [input, output, base-input, cache-read]. */
export const PRICES: Array<[string, [number, number, number, number]]> = [
  ['haiku', [1, 5, 1, 0.1]],
  ['sonnet', [3, 15, 3, 0.3]],
  ['opus', [15, 75, 15, 1.5]],
]

/**
 * List-price estimate, a CROSS-CHECK only: the cache-write term is priced at
 * the 5m rate (1.25x base). Claudin can write 1h (2x), so this understates it.
 * `cost usd (CLI)` is authoritative — it knows the real TTL per request.
 */
export function estimateCost(model: string, u: { input: number; output: number; cacheRead: number; cacheCreation: number }): number {
  const m = (model || 'sonnet').toLowerCase()
  const [, rate] = PRICES.find(([k]) => m.includes(k)) ?? PRICES[1]!
  const [pIn, pOut, pBase, pRead] = rate
  return (
    (u.input / 1e6) * pIn + (u.output / 1e6) * pOut + (u.cacheCreation / 1e6) * (pBase * 1.25) + (u.cacheRead / 1e6) * pRead
  )
}
