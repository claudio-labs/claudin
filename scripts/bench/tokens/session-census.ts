/**
 * Session census: where the tokens went over a date range.
 *
 * Reads the recorded transcripts (`~/.claudin/projects/<slug>/**\/*.jsonl`)
 * and prints the per-session usage and USD, the context-size distribution,
 * the cache-drop events, the tool census, the Bash shapes that should have
 * been a dedicated tool, the wait/poll turns, the inter-call gaps (the 1h vs
 * 5m TTL question) and the narration count. It is the one-command version of
 * the throwaway scripts a weekly review used to write into /tmp.
 *
 * Two traps this walk avoids, both of which inflate a naive grep 2-3×:
 *   - a fork's transcript under `<session>/subagents/` MIRRORS the parent's
 *     history, so assistant messages are deduplicated by `message.id` and
 *     tool uses by `tool_use.id` across every file in the range;
 *   - a streamed assistant message lands as several records with the same
 *     `message.id`; the one with the highest `output_tokens` is the final
 *     usage, and the `cache_creation` split (5m/1h) is carried over from any
 *     record that had it.
 *
 * Transcripts are DATA: nothing here prints a command output, a file body or
 * a user prompt — only aggregates and command HEADS (the first token).
 *
 * Pricing is a LOCAL mirror of `src/providers/usage/modelCost.ts` (same
 * per-Mtok numbers, same 5m/1h cache-write split): importing that module
 * pulls `src/platform/analytics/growthbook.ts`, whose dependency is stubbed
 * only by the build, so `bun scripts/…` cannot load it. Update `PRICES` when
 * the table there changes; a model missing here is priced at the Opus 4.5
 * tier and named in the output.
 *
 * Run:
 *   bun scripts/bench/tokens/session-census.ts --since=2026-09-04
 *   bun scripts/bench/tokens/session-census.ts --since=2026-09-04 --project=-home-me-repo --json
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import {
  contentText,
  pad,
  padLeft,
  projectDirs,
  transcriptFiles,
  type Block,
} from './transcriptCorpus.js'

// ---------------------------------------------------------------------------
// Pricing (mirror of modelCost.ts — $/Mtok)
// ---------------------------------------------------------------------------

type Price = { input: number; write5m: number; write1h: number; read: number; output: number }

const PRICES: ReadonlyArray<{ pattern: RegExp; price: Price }> = [
  { pattern: /fable-5-1/, price: { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 } },
  { pattern: /fable-5\b/, price: { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 } },
  { pattern: /opus-4(-1)?(-\d{8})?$/, price: { input: 15, write5m: 18.75, write1h: 30, read: 1.5, output: 75 } },
  { pattern: /opus-(4-[5-8]|5)/, price: { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 } },
  { pattern: /sonnet-5/, price: { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 } },
  { pattern: /sonnet/, price: { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 } },
  { pattern: /haiku-4-5/, price: { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 } },
  { pattern: /haiku/, price: { input: 0.8, write5m: 1, write1h: 1.6, read: 0.08, output: 4 } },
]
const DEFAULT_PRICE: Price = { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }
const unpricedModels = new Set<string>()

function priceFor(model: string): Price {
  for (const { pattern, price } of PRICES) if (pattern.test(model)) return price
  unpricedModels.add(model)
  return DEFAULT_PRICE
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Args = { since: number; project: string | null; json: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = {
    since: Date.now() - 7 * 24 * 60 * 60 * 1000,
    project: null,
    json: false,
  }
  for (const s of argv) {
    if (s.startsWith('--since=')) a.since = Date.parse(`${s.slice(8)}T00:00:00Z`)
    else if (s.startsWith('--project=')) a.project = s.slice(10)
    else if (s === '--json') a.json = true
  }
  if (Number.isNaN(a.since)) throw new Error('--since must be YYYY-MM-DD')
  return a
}

/** The project slug the app derives from a cwd: every `/` becomes `-`. */
function cwdSlug(): string {
  return process.cwd().replace(/\//g, '-')
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

type Call = {
  id: string
  /** Transcript file (session identity). */
  file: string
  model: string
  ts: number
  usage: Usage
  sidechain: boolean
  tools: string[]
  /** Text alongside a tool_use in the same message — narration. */
  text: string
}

type ToolUse = {
  id: string
  name: string
  input: Block
  callId: string
  file: string
}

type Walk = {
  calls: Call[]
  uses: Map<string, ToolUse>
  results: Map<string, string>
}

function walk(files: readonly string[]): Walk {
  const byId = new Map<string, Call>()
  const uses = new Map<string, ToolUse>()
  const results = new Map<string, string>()
  const order: string[] = []

  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      let rec: Block
      try {
        rec = JSON.parse(line) as Block
      } catch {
        continue
      }
      const message = rec.message as Block | undefined
      const content = Array.isArray(message?.content) ? (message!.content as Block[]) : null

      if (rec.type === 'user' && content) {
        for (const b of content) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            results.set(b.tool_use_id, contentText(b.content))
          }
        }
        continue
      }
      if (rec.type !== 'assistant' || !message?.usage) continue

      const id = String(message.id ?? '')
      if (!id) continue
      const usage = message.usage as Usage
      let call = byId.get(id)
      if (!call) {
        call = {
          id,
          file,
          model: String(message.model ?? ''),
          ts: Date.parse(String(rec.timestamp ?? '')),
          usage,
          sidechain: rec.isSidechain === true,
          tools: [],
          text: '',
        }
        byId.set(id, call)
        order.push(id)
      } else {
        // Streaming: keep the final usage, carry the TTL split forward.
        const split = call.usage.cache_creation ?? usage.cache_creation
        if (usage.output_tokens >= call.usage.output_tokens) call.usage = usage
        if (split && !call.usage.cache_creation) {
          call.usage = { ...call.usage, cache_creation: split }
        }
      }
      if (!content) continue
      for (const b of content) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          if (uses.has(b.id)) continue
          uses.set(b.id, {
            id: b.id,
            name: String(b.name ?? ''),
            input: (b.input as Block) ?? {},
            callId: id,
            file,
          })
          call.tools.push(String(b.name ?? ''))
        } else if (b.type === 'text' && typeof b.text === 'string') {
          call.text += b.text
        }
      }
    }
  }

  const calls = order.map(id => byId.get(id)!).sort((a, b) => a.ts - b.ts)
  return { calls, uses, results }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const usd = (n: number): string => `$${n.toFixed(2)}`
const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function ctxOf(u: Usage): number {
  return (
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  )
}

function split(u: Usage): { w5: number; w1h: number } {
  const cc = u.cache_creation
  if (cc) {
    return {
      w5: cc.ephemeral_5m_input_tokens ?? 0,
      w1h: cc.ephemeral_1h_input_tokens ?? 0,
    }
  }
  return { w5: u.cache_creation_input_tokens ?? 0, w1h: 0 }
}

function costParts(c: Call): { input: number; write: number; read: number; output: number } {
  const u = c.usage
  const p = priceFor(c.model)
  const s = split(u)
  return {
    input: (u.input_tokens / 1e6) * p.input,
    write: (s.w5 / 1e6) * p.write5m + (s.w1h / 1e6) * p.write1h,
    read: ((u.cache_read_input_tokens ?? 0) / 1e6) * p.read,
    output: (u.output_tokens / 1e6) * p.output,
  }
}

type Agg = {
  calls: number
  input: number
  w5: number
  w1h: number
  read: number
  output: number
  thinking: number
  cost: { input: number; write: number; read: number; output: number }
  first: number
  last: number
  models: Set<string>
}

function emptyAgg(): Agg {
  return {
    calls: 0,
    input: 0,
    w5: 0,
    w1h: 0,
    read: 0,
    output: 0,
    thinking: 0,
    cost: { input: 0, write: 0, read: 0, output: 0 },
    first: Infinity,
    last: -Infinity,
    models: new Set(),
  }
}

function add(a: Agg, c: Call): void {
  const u = c.usage
  const s = split(u)
  const p = costParts(c)
  a.calls++
  a.input += u.input_tokens
  a.w5 += s.w5
  a.w1h += s.w1h
  a.read += u.cache_read_input_tokens ?? 0
  a.output += u.output_tokens
  a.thinking += u.output_tokens_details?.thinking_tokens ?? 0
  a.cost.input += p.input
  a.cost.write += p.write
  a.cost.read += p.read
  a.cost.output += p.output
  a.first = Math.min(a.first, c.ts)
  a.last = Math.max(a.last, c.ts)
  a.models.add(c.model)
}

const total = (a: Agg): number => a.cost.input + a.cost.write + a.cost.read + a.cost.output

/** `<session>/subagents/x.jsonl` → `<session>`; `<session>.jsonl` → `<session>`. */
function sessionOf(file: string): string {
  const dir = dirname(file)
  if (basename(dir) === 'subagents') return basename(dirname(dir))
  return basename(file, '.jsonl')
}

// ---------------------------------------------------------------------------
// Bash shapes
// ---------------------------------------------------------------------------

const FILE_READ_HEADS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less'])
const GREP_HEADS = new Set(['grep', 'rg'])
const LIST_HEADS = new Set(['find', 'ls', 'tree', 'du'])
const GIT_HEADS = new Set(['git', 'gh'])
const SLEEP_OR_CAPTURE_RE = /\bsleep\s+\d|tmux (capture-pane|send-keys)/
const BLOCKED_RE = /^(?:<tool_use_error>)?Blocked: ([^\n]{0,80})/
/** `\`git log --oneline -5\`` → `\`git…\``: the head survives, the arguments do not. */
const QUOTED_COMMAND_RE = /`([^\s`]*)[^`]*`?/
const FOLLOWED_BY_RE = /followed by: (\S+)[\s\S]*$/
const ENV_ASSIGN_RE = /`(\w+)=[^…`]*/
const SENTENCE_TAIL_RE = /\.\s[\s\S]*$/
const SESSION_HEAD_RE = /^(.{8})[^/]*/

function bashCategory(command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? ''
  if (FILE_READ_HEADS.has(head)) return 'file-read'
  if (GREP_HEADS.has(head)) return 'grep'
  if (LIST_HEADS.has(head)) return 'list'
  if (GIT_HEADS.has(head)) return 'git'
  if (head === 'bun' && /\btest\b/.test(command)) return 'bun-test'
  if (head === 'bun' && /\bbuild\b/.test(command)) return 'bun-build'
  if (head === 'bun' && /typecheck|tsc/.test(command)) return 'typecheck'
  if (head === 'tmux' || /^\S+ .*\btmux\b/.test(command)) return 'tmux'
  if (head === 'sleep') return 'sleep'
  return 'other'
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type Report = ReturnType<typeof buildReport>

function buildReport(w: Walk) {
  const { calls, uses, results } = w
  const byFile = new Map<string, Call[]>()
  for (const c of calls) {
    const list = byFile.get(c.file) ?? []
    list.push(c)
    byFile.set(c.file, list)
  }

  // (1) per session / model
  const perSession = new Map<string, Agg>()
  const perModel = new Map<string, Agg>()
  const grand = emptyAgg()
  const main = emptyAgg()
  const side = emptyAgg()
  for (const c of calls) {
    const key = `${sessionOf(c.file)}${c.sidechain ? '/sub' : ''}`
    const a = perSession.get(key) ?? emptyAgg()
    add(a, c)
    perSession.set(key, a)
    const m = perModel.get(c.model) ?? emptyAgg()
    add(m, c)
    perModel.set(c.model, m)
    add(grand, c)
    add(c.sidechain ? side : main, c)
  }

  // (2) context distribution
  const ctx = calls.map(c => ctxOf(c.usage)).sort((a, b) => a - b)
  const q = (p: number): number => ctx[Math.min(ctx.length - 1, Math.floor(ctx.length * p))] ?? 0
  const context = {
    n: ctx.length,
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    max: ctx[ctx.length - 1] ?? 0,
    over150k: ctx.filter(x => x > 150_000).length,
    over250k: ctx.filter(x => x > 250_000).length,
  }

  // (3) cache drops + flat stretches, (7) gaps — all per transcript
  const drops: { session: string; ts: number; prev: number; now: number; created: number }[] = []
  const flats: { session: string; calls: number; tailIn: number; nextRead: number; nextCreated: number; wiped: boolean }[] = []
  let gapsUnder5 = 0
  let gaps5to60 = 0
  let gapsOver60 = 0
  let premium1h = 0
  let rewrite5m = 0
  for (const [file, cs] of byFile) {
    const session = sessionOf(file) + (cs[0]?.sidechain ? '/sub' : '')
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]!
      const created = c.usage.cache_creation_input_tokens ?? 0
      const read = c.usage.cache_read_input_tokens ?? 0
      const price = priceFor(c.model)
      // 1h premium: what the same write would have cost at the 5m tier.
      premium1h += (split(c.usage).w1h / 1e6) * (price.write1h - price.write5m)
      if (i === 0) continue
      const prev = cs[i - 1]!
      const prevRead = prev.usage.cache_read_input_tokens ?? 0
      if (created > 8_000 && read < prevRead) {
        drops.push({ session, ts: c.ts, prev: prevRead, now: read, created })
      }
      const gapMin = (c.ts - prev.ts) / 60_000
      if (gapMin < 5) gapsUnder5++
      else {
        if (gapMin < 60) gaps5to60++
        else gapsOver60++
        // A 5m policy would have re-written the whole warm prefix here.
        rewrite5m +=
          ((prevRead + (prev.usage.cache_creation_input_tokens ?? 0)) / 1e6) * price.write5m
      }
    }
    let i = 0
    while (i < cs.length) {
      if ((cs[i]!.usage.cache_creation_input_tokens ?? 0) !== 0) {
        i++
        continue
      }
      let j = i
      while (j < cs.length && (cs[j]!.usage.cache_creation_input_tokens ?? 0) === 0) j++
      if (j - i >= 4 && j < cs.length) {
        const last = cs[j - 1]!
        const next = cs[j]!
        const nextRead = next.usage.cache_read_input_tokens ?? 0
        flats.push({
          session,
          calls: j - i,
          tailIn: last.usage.input_tokens,
          nextRead,
          nextCreated: next.usage.cache_creation_input_tokens ?? 0,
          wiped: nextRead < (last.usage.cache_read_input_tokens ?? 0),
        })
      }
      i = j
    }
  }

  // (4) tool census, (5) bash, (6) wait/poll, (8) narration
  const tools = new Map<string, { n: number; chars: number }>()
  const bash = new Map<string, { n: number; chars: number }>()
  const refusals = new Map<string, number>()
  let waitTurns = 0
  let waitCtx = 0
  let waitCost = 0
  const callById = new Map(calls.map(c => [c.id, c]))
  const waitSeen = new Set<string>()
  for (const use of uses.values()) {
    const text = results.get(use.id) ?? ''
    const t = tools.get(use.name) ?? { n: 0, chars: 0 }
    t.n++
    t.chars += text.length
    tools.set(use.name, t)
    const blocked = BLOCKED_RE.exec(text.slice(0, 400))
    if (blocked) {
      // Command heads only — the refusal quotes the command, and its
      // arguments (paths, patterns) must not reach the output.
      const kind = blocked[1]!
        .replace(QUOTED_COMMAND_RE, '`$1…`')
        .replace(ENV_ASSIGN_RE, '`$1=…')
        .replace(FOLLOWED_BY_RE, 'followed by: $1…')
        .replace(SENTENCE_TAIL_RE, '')
        .trim()
        .slice(0, 60)
      refusals.set(kind, (refusals.get(kind) ?? 0) + 1)
    }
    if (use.name !== 'Bash') continue
    const command = typeof use.input.command === 'string' ? use.input.command : ''
    const cat = bashCategory(command)
    const b = bash.get(cat) ?? { n: 0, chars: 0 }
    b.n++
    b.chars += text.length
    bash.set(cat, b)
    if (SLEEP_OR_CAPTURE_RE.test(command) && !waitSeen.has(use.callId)) {
      waitSeen.add(use.callId)
      const call = callById.get(use.callId)
      if (call) {
        waitTurns++
        waitCtx += ctxOf(call.usage)
        const p = costParts(call)
        waitCost += p.input + p.write + p.read + p.output
      }
    }
  }
  const narration = calls.filter(c => c.tools.length > 0 && c.text.trim().length > 0)

  return {
    range: { first: grand.first, last: grand.last },
    sessions: [...perSession.entries()]
      .map(([key, a]) => ({ key, ...a, models: [...a.models], total: total(a) }))
      .sort((x, y) => y.total - x.total),
    models: [...perModel.entries()].map(([model, a]) => ({ model, ...a, models: undefined, total: total(a) })),
    totals: { all: { ...grand, models: [...grand.models], total: total(grand) }, main: { calls: main.calls, total: total(main), read: main.cost.read }, side: { calls: side.calls, total: total(side), read: side.cost.read } },
    context,
    drops: drops.sort((a, b) => b.created - a.created),
    flats: flats.sort((a, b) => b.calls - a.calls),
    tools: [...tools.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.chars - a.chars),
    bash: [...bash.entries()].map(([cat, b]) => ({ cat, ...b })).sort((a, b) => b.n - a.n),
    refusals: [...refusals.entries()].sort((a, b) => b[1] - a[1]),
    wait: { turns: waitTurns, ctxTokens: waitCtx, cost: waitCost },
    gaps: { under5: gapsUnder5, from5to60: gaps5to60, over60: gapsOver60, premium1h, rewrite5m },
    narration: { messagesWithTools: calls.filter(c => c.tools.length > 0).length, withText: narration.length, chars: narration.reduce((s, c) => s + c.text.trim().length, 0) },
  }
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

function print(r: Report): void {
  const iso = (t: number): string => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) : '-')
  console.log(`=== SESSION CENSUS ${iso(r.range.first)} → ${iso(r.range.last)} ===`)
  console.log(`calls=${r.totals.all.calls} (main ${r.totals.main.calls}, sidechain ${r.totals.side.calls})  total=${usd(r.totals.all.total)}`)
  const t = r.totals.all
  console.log(`split: input ${usd(t.cost.input)} • cache write ${usd(t.cost.write)} (5m ${fmt(t.w5)} / 1h ${fmt(t.w1h)} tok) • cache read ${usd(t.cost.read)} • output ${usd(t.cost.output)} (thinking ${t.output > 0 ? Math.round((100 * t.thinking) / t.output) : 0}%)`)

  console.log('\n--- by model ---')
  for (const m of r.models) {
    console.log(`${pad(m.model, 20)} calls=${padLeft(String(m.calls), 5)} in=${padLeft(fmt(m.input), 10)} cW=${padLeft(fmt(m.w5 + m.w1h), 10)} cR=${padLeft(fmt(m.read), 12)} out=${padLeft(fmt(m.output), 9)} | ${usd(m.total)} = in ${usd(m.cost.input)} + w ${usd(m.cost.write)} + r ${usd(m.cost.read)} + out ${usd(m.cost.output)}`)
  }

  console.log('\n--- by session (main / sub) ---')
  for (const s of r.sessions) {
    const avgCtx = s.calls > 0 ? (s.input + s.w5 + s.w1h + s.read) / s.calls : 0
    const dur = Number.isFinite(s.first) ? Math.round((s.last - s.first) / 60_000) : 0
    console.log(`${pad(s.key.replace(SESSION_HEAD_RE, '$1'), 13)} ${pad(s.models.map(m => m.replace('claude-', '')).join(','), 12)} calls=${padLeft(String(s.calls), 4)} avgCtx=${padLeft(k(avgCtx), 5)} dur=${padLeft(String(dur), 4)}min ${padLeft(usd(s.total), 8)} (in ${usd(s.cost.input)} / w ${usd(s.cost.write)} / r ${usd(s.cost.read)} / out ${usd(s.cost.output)})`)
  }

  const c = r.context
  console.log(`\n--- context per call --- n=${c.n} p10=${fmt(c.p10)} p50=${fmt(c.p50)} p90=${fmt(c.p90)} max=${fmt(c.max)} | >150k: ${c.over150k}  >250k: ${c.over250k}`)
  console.log(`sidechain: ${r.totals.side.calls} calls, cache reads ${usd(r.totals.side.read)} of ${usd(r.totals.side.total)}`)

  console.log(`\n--- cache drops (cache_read fell, created > 8k) --- n=${r.drops.length} re-written=${fmt(r.drops.reduce((s, d) => s + d.created, 0))} tok`)
  for (const d of r.drops.slice(0, 15)) {
    console.log(`  ${pad(d.session.replace(SESSION_HEAD_RE, '$1'), 13)} ${iso(d.ts)} read ${fmt(d.prev)} → ${fmt(d.now)}  created=${fmt(d.created)}`)
  }
  const wiped = r.flats.filter(f => f.wiped)
  console.log(`--- flat no-write stretches (≥4 calls) --- n=${r.flats.length}, ${wiped.length} ended in a drop`)
  for (const f of r.flats.slice(0, 10)) {
    console.log(`  ${pad(f.session.replace(SESSION_HEAD_RE, '$1'), 13)} flat=${padLeft(String(f.calls), 2)} tailIn=${padLeft(fmt(f.tailIn), 6)} → next read=${fmt(f.nextRead)} created=${fmt(f.nextCreated)}${f.wiped ? '  <<< DROP' : ''}`)
  }

  console.log('\n--- tool census ---')
  for (const t of r.tools) {
    console.log(`${pad(t.name, 28)} n=${padLeft(String(t.n), 5)} resultChars=${padLeft(fmt(t.chars), 10)} avg=${padLeft(fmt(t.n ? t.chars / t.n : 0), 7)}`)
  }

  console.log('\n--- Bash by shape (heads only) ---')
  for (const b of r.bash) console.log(`${pad(b.cat, 12)} n=${padLeft(String(b.n), 4)} chars=${fmt(b.chars)}`)
  console.log(`--- refusals (Blocked:) --- n=${r.refusals.reduce((s, [, n]) => s + n, 0)}`)
  for (const [kind, n] of r.refusals.slice(0, 12)) console.log(`  ${padLeft(String(n), 3)}× ${kind}`)

  console.log(`\n--- wait/poll turns (sleep / tmux capture) --- turns=${r.wait.turns} ctxTokens=${fmt(r.wait.ctxTokens)} cost≈${usd(r.wait.cost)}`)

  const g = r.gaps
  console.log(`\n--- inter-call gaps --- <5min=${g.under5}  5-60min=${g.from5to60}  >60min=${g.over60}`)
  console.log(`1h TTL premium paid ${usd(g.premium1h)}; a 5m policy would have re-written ≈${usd(g.rewrite5m)} at the ≥5min gaps`)

  console.log(`\n--- narration (text beside a tool_use) --- ${r.narration.withText} of ${r.narration.messagesWithTools} messages, ${fmt(r.narration.chars)} chars`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  let dirs = projectDirs(args.project)
  if (!args.project) {
    const own = dirs.filter(d => basename(d) === cwdSlug())
    if (own.length > 0) dirs = own
  }
  const files = transcriptFiles(dirs)
    .filter(t => t.mtimeMs >= args.since)
    .map(t => t.path)
  if (files.length === 0) {
    console.error(`no transcripts modified since ${new Date(args.since).toISOString().slice(0, 10)} under ${dirs.join(', ')}`)
    process.exit(1)
  }
  const report = buildReport(walk(files))
  if (args.json) {
    console.log(JSON.stringify(report, (_k, v: unknown) => (v instanceof Set ? [...v] : v), 2))
    return
  }
  console.log(`transcripts=${files.length} projects=${dirs.map(d => basename(d)).join(',')}`)
  print(report)
  if (unpricedModels.size > 0) {
    console.log(`\n(unpriced models billed at the Opus 4.5 tier: ${[...unpricedModels].join(', ')})`)
  }
}

main()
