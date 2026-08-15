#!/usr/bin/env bun
/**
 * CLI A/B — claudindev vs claude on the same search → edit → build task.
 *
 * The workload is the everyday shape of agent work, not a micro-benchmark:
 * find every call site of one function across a 10-file JavaScript project,
 * change all of them, and get the build green. It exercises each CLI's OWN
 * search stack (Grep/Glob vs Bash greps vs sub-agents) — so, unlike the
 * single-binary A/Bs in this directory (`build-tool-ab.ts`, `git-tool-ab.ts`),
 * both arms are different BINARIES and the tool list is deliberately NOT
 * restricted. Restricting it would answer by fiat the question under test.
 *
 * Protocol:
 *  - A throwaway workspace under the OS temp dir (/tmp), rebuilt
 *    byte-identically before every arm of every rep. Never this checkout —
 *    session state is keyed by project directory and would collide with the
 *    live session.
 *  - Sonnet 5 pinned on BOTH sides (`--model`). A run reporting another model
 *    is flagged, not reported: without a pin each CLI follows its own default
 *    (claudin the active /provider profile, claude its own setting) and the
 *    cost column would compare two price tiers.
 *  - Arm order ALTERNATES across reps. Whichever arm runs first pays the cold
 *    prompt cache; a fixed order bakes that into the delta.
 *  - Every run is graded by `verify()` before its tokens are believed. A cheap
 *    arm that skipped a call site is not a win, and the token table alone
 *    cannot tell the two apart.
 *
 * The build is the oracle, not decoration: the 5 call sites reach the function
 * through ESM named imports, so a missed site fails `bun build` with
 * "No matching export". `--dry-run` proves that (and proves the decoys bite)
 * before a single model token is spent.
 *
 * Usage:
 *   bun scripts/profile/cli-search-edit-ab.ts --dry-run          # validate the fixture
 *   bun scripts/profile/cli-search-edit-ab.ts --reps=3
 *   bun scripts/profile/cli-search-edit-ab.ts --only=claudin --keep
 *   bun scripts/profile/cli-search-edit-ab.ts --reps=3 --json
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SENTINEL = 'BENCH_DONE'
const DEFAULT_MODEL = 'claude-sonnet-5'

// ---------------------------------------------------------------------------
// The fixture: 10 plain-ESM .js files plus a package.json.
//
// 5 of them call `formatCurrency`, one per file, each reached through a NAMED
// import so the bundler fails loudly when a site is missed:
//   checkout.js  plain import, call in a concatenation
//   summary.js   shared import line, call inside a template literal
//   invoice.js   call inside an arrow body
//   receipt.js   multi-line import block
//   badge.js     ALIASED import (`formatCurrency as money`) — the call reads
//                `money(...)`, so grepping for `formatCurrency(` misses it
//
// The other 5 are decoys that punish a blind global replace:
//   strings.js   exports the lookalike `formatCurrencyLabel`, names the real
//                function in a comment
//   label.js     imports the lookalike, names the real one in a comment
//   track.js     carries 'formatCurrency' as a STRING event name
//   format.js    the definition itself
//   index.js     the entry that keeps every module live for the bundler
// ---------------------------------------------------------------------------

const F = (...lines: string[]) => lines.join('\n') + '\n'

const PKG = JSON.stringify(
  {
    name: 'storefront',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { build: 'bun build src/index.js --outdir=dist --target=node' },
  },
  null,
  2,
)

const FIXTURE: Record<string, string> = {
  'package.json': PKG + '\n',

  'src/lib/format.js': F(
    "const SYMBOLS = { USD: '$', EUR: 'EUR ', BRL: 'R$' }",
    '',
    'export function formatCurrency(amount) {',
    '  const cents = Math.round(Number(amount) * 100)',
    '  return SYMBOLS.USD + (cents / 100).toFixed(2)',
    '}',
    '',
    'export function parseAmount(text) {',
    "  return Number(String(text).replace(/[^0-9.-]/g, ''))",
    '}',
  ),

  'src/lib/strings.js': F(
    '// Presentation helpers only. The money formatting itself lives in',
    '// format.js (formatCurrency) -- never duplicate it here.',
    '',
    'export function formatCurrencyLabel(code) {',
    "  return code.toUpperCase() + ' amount'",
    '}',
    '',
    'export function titleCase(text) {',
    '  return text.replace(/\\b\\w/g, c => c.toUpperCase())',
    '}',
  ),

  'src/cart/checkout.js': F(
    "import { formatCurrency, parseAmount } from '../lib/format.js'",
    '',
    'export function checkoutLine(item) {',
    '  const total = parseAmount(item.price) * item.qty',
    "  return item.name + ' - ' + formatCurrency(total)",
    '}',
  ),

  'src/cart/summary.js': F(
    "import { formatCurrency, parseAmount } from '../lib/format.js'",
    '',
    'export function cartSummary(items) {',
    '  const total = items.reduce((sum, item) => sum + parseAmount(item.price), 0)',
    '  return { count: items.length, total, label: `Total: ${formatCurrency(total)}` }',
    '}',
  ),

  'src/report/invoice.js': F(
    "import { formatCurrency } from '../lib/format.js'",
    '',
    'export function renderInvoice(invoice) {',
    '  return invoice.lines',
    "    .map(line => line.sku + ' ' + formatCurrency(line.amount))",
    "    .join('\\n')",
    '}',
  ),

  'src/report/receipt.js': F(
    'import {',
    '  formatCurrency,',
    '  parseAmount,',
    "} from '../lib/format.js'",
    '',
    'export function renderReceipt(receipt) {',
    '  const paid = parseAmount(receipt.paid)',
    "  return 'PAID ' + formatCurrency(paid)",
    '}',
  ),

  'src/ui/badge.js': F(
    "import { formatCurrency as money } from '../lib/format.js'",
    '',
    'export function priceBadge(product) {',
    "  return { text: money(product.price), tone: product.price > 100 ? 'high' : 'low' }",
    '}',
  ),

  'src/ui/label.js': F(
    "import { formatCurrencyLabel, titleCase } from '../lib/strings.js'",
    '',
    '// This module never formats amounts; formatCurrency in format.js does that.',
    'export function priceLabel(code, name) {',
    "  return titleCase(name) + ' (' + formatCurrencyLabel(code) + ')'",
    '}',
  ),

  'src/analytics/track.js': F(
    "const EVENTS = ['formatCurrency', 'checkout', 'invoice', 'receipt']",
    '',
    'export function track(event, payload) {',
    '  if (!EVENTS.includes(event)) return null',
    '  return { event, payload }',
    '}',
  ),

  'src/index.js': F(
    "export { checkoutLine } from './cart/checkout.js'",
    "export { cartSummary } from './cart/summary.js'",
    "export { renderInvoice } from './report/invoice.js'",
    "export { renderReceipt } from './report/receipt.js'",
    "export { priceBadge } from './ui/badge.js'",
    "export { priceLabel } from './ui/label.js'",
    "export { track } from './analytics/track.js'",
  ),
}

/** The five files the model must change. One call site each. */
const CALL_SITES = [
  'src/cart/checkout.js',
  'src/cart/summary.js',
  'src/report/invoice.js',
  'src/report/receipt.js',
  'src/ui/badge.js',
]

/** Files a correct run leaves alone. A global replace breaks all three. */
const DECOYS = ['src/lib/strings.js', 'src/ui/label.js', 'src/analytics/track.js']

/** The reference solution, used only by --dry-run to prove the grader. */
const SOLUTION: Record<string, string> = {
  'src/lib/format.js': F(
    "const SYMBOLS = { USD: '$', EUR: 'EUR ', BRL: 'R$' }",
    '',
    'export function formatMoney(amount, currency) {',
    '  const cents = Math.round(Number(amount) * 100)',
    '  return SYMBOLS[currency] + (cents / 100).toFixed(2)',
    '}',
    '',
    'export function parseAmount(text) {',
    "  return Number(String(text).replace(/[^0-9.-]/g, ''))",
    '}',
  ),
  'src/cart/checkout.js': F(
    "import { formatMoney, parseAmount } from '../lib/format.js'",
    '',
    'export function checkoutLine(item) {',
    '  const total = parseAmount(item.price) * item.qty',
    "  return item.name + ' - ' + formatMoney(total, 'USD')",
    '}',
  ),
  'src/cart/summary.js': F(
    "import { formatMoney, parseAmount } from '../lib/format.js'",
    '',
    'export function cartSummary(items) {',
    '  const total = items.reduce((sum, item) => sum + parseAmount(item.price), 0)',
    "  return { count: items.length, total, label: `Total: ${formatMoney(total, 'USD')}` }",
    '}',
  ),
  'src/report/invoice.js': F(
    "import { formatMoney } from '../lib/format.js'",
    '',
    'export function renderInvoice(invoice) {',
    '  return invoice.lines',
    "    .map(line => line.sku + ' ' + formatMoney(line.amount, 'USD'))",
    "    .join('\\n')",
    '}',
  ),
  'src/report/receipt.js': F(
    'import {',
    '  formatMoney,',
    '  parseAmount,',
    "} from '../lib/format.js'",
    '',
    'export function renderReceipt(receipt) {',
    '  const paid = parseAmount(receipt.paid)',
    "  return 'PAID ' + formatMoney(paid, 'USD')",
    '}',
  ),
  'src/ui/badge.js': F(
    "import { formatMoney as money } from '../lib/format.js'",
    '',
    'export function priceBadge(product) {',
    "  return { text: money(product.price, 'USD'), tone: product.price > 100 ? 'high' : 'low' }",
    '}',
  ),
}

function buildWorkspace(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-search-edit-ab-'))
  for (const [rel, body] of Object.entries({ ...FIXTURE, ...overrides })) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
  }
  return root
}

// ---------------------------------------------------------------------------
// The task. Identical text for both arms — it names no tool and no search
// strategy, because the strategy is what is being measured.
// ---------------------------------------------------------------------------

function buildPrompt(): string {
  return [
    'This is a small JavaScript package (plain ESM .js, no TypeScript).',
    '',
    'Task:',
    '1. In src/lib/format.js, rename the exported function `formatCurrency` to `formatMoney`',
    '   and give it a second, required parameter `currency` (a code such as "USD") that',
    '   selects the symbol, instead of the hardcoded one it uses today.',
    '2. Update EVERY place in this project that calls it, so that it calls `formatMoney`',
    "   and passes the string 'USD' as the second argument.",
    '3. Do NOT leave a `formatCurrency` alias, wrapper or re-export behind: the old name',
    '   must be gone from the code.',
    '4. Do NOT rename anything that merely looks similar. Some identifiers and strings in',
    '   this project resemble the target and are unrelated to it.',
    '5. Build the project with `npm run build` and make sure the build succeeds.',
    '',
    'Work autonomously and do not ask questions.',
    `When the build is green and every call site is updated, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Grading. Run before any token number is believed.
// ---------------------------------------------------------------------------

type Verdict = {
  buildOk: boolean
  buildErr: string
  sitesDone: number
  sitesMissed: string[]
  aliasLeft: boolean
  decoysBroken: string[]
  decoysEdited: string[]
  ok: boolean
}

function readIf(root: string, rel: string): string {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function runBuild(root: string, timeoutMs = 120_000): { ok: boolean; err: string } {
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env },
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const err = out
    .split('\n')
    .filter(l => /error|Error|ERR!/.test(l))
    .slice(0, 3)
    .join(' | ')
  return { ok: res.status === 0, err: err.slice(0, 240) }
}

function verify(root: string): Verdict {
  const build = runBuild(root)

  const sitesMissed: string[] = []
  for (const rel of CALL_SITES) {
    const body = readIf(root, rel)
    const converted = !/\bformatCurrency\b/.test(body) && /\bformatMoney\b/.test(body) && /['"]USD['"]/.test(body)
    if (!converted) sitesMissed.push(rel)
  }

  // An alias/re-export left in format.js keeps the build green while leaving
  // the call sites untouched — the one way to pass the bundler without doing
  // the task, so it is graded separately.
  const aliasLeft = /\bformatCurrency\b/.test(readIf(root, 'src/lib/format.js'))

  const decoysBroken: string[] = []
  if (!/\bformatCurrencyLabel\b/.test(readIf(root, 'src/lib/strings.js'))) decoysBroken.push('src/lib/strings.js')
  if (!/\bformatCurrencyLabel\b/.test(readIf(root, 'src/ui/label.js'))) decoysBroken.push('src/ui/label.js')
  if (!/['"]formatCurrency['"]/.test(readIf(root, 'src/analytics/track.js'))) decoysBroken.push('src/analytics/track.js')

  // Softer signal: a decoy that changed at all (a rewritten comment, say) is
  // over-reach worth seeing, but it is not a failure on its own.
  const decoysEdited = DECOYS.filter(rel => readIf(root, rel) !== FIXTURE[rel])

  return {
    buildOk: build.ok,
    buildErr: build.err,
    sitesDone: CALL_SITES.length - sitesMissed.length,
    sitesMissed,
    aliasLeft,
    decoysBroken,
    decoysEdited,
    ok: build.ok && sitesMissed.length === 0 && !aliasLeft && decoysBroken.length === 0,
  }
}

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

type TimelineRow = { in: number; out: number; cR: number; cW: number }

function parseJsonl(text: string): Record<string, unknown>[] {
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

function timelineFrom(sources: Record<string, unknown>[][]): TimelineRow[] {
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

function sessionIdFrom(events: Record<string, unknown>[]): string | null {
  for (const v of events) {
    if (v.type === 'system' && v.subtype === 'init' && typeof v.session_id === 'string') return v.session_id
  }
  return null
}

function transcriptPath(sessionId: string): string | null {
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

function scalarsFrom(events: Record<string, unknown>[]): {
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

type ToolCall = { name: string; id: string; search: boolean; resultChars: number }

function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
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

// ---------------------------------------------------------------------------
// Arms.
// ---------------------------------------------------------------------------

type ArmResult = {
  label: string
  bin: string
  rep: number
  exitCode: number
  wallMs: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  firstContext: number
  peakContext: number
  endContext: number
  costUsd: number | null
  estCostUsd: number
  numTurns: number | null
  model: string | null
  sawSentinel: boolean
  timeline: TimelineRow[]
  usageMergedFromTranscript: boolean
  toolCalls: number
  searchCalls: number
  toolMix: Record<string, number>
  allResultChars: number
  searchResultChars: number
  verdict: Verdict
  workspace: string
  transcript: string | null
  stderr: string
}

/** Public list price, USD per 1M: [input, output, base-input, cache-read]. */
const PRICES: Array<[string, [number, number, number, number]]> = [
  ['haiku', [1, 5, 1, 0.1]],
  ['sonnet', [3, 15, 3, 0.3]],
  ['opus', [15, 75, 15, 1.5]],
]

/**
 * List-price estimate, a CROSS-CHECK only: the cache-write term is priced at
 * the 5m rate (1.25x base). Claudin can write 1h (2x), so this understates it.
 * `cost usd (CLI)` is authoritative — it knows the real TTL per request.
 */
function estimateCost(model: string, u: { input: number; output: number; cacheRead: number; cacheCreation: number }): number {
  const m = (model || 'sonnet').toLowerCase()
  const [, rate] = PRICES.find(([k]) => m.includes(k)) ?? PRICES[1]!
  const [pIn, pOut, pBase, pRead] = rate
  return (
    (u.input / 1e6) * pIn + (u.output / 1e6) * pOut + (u.cacheCreation / 1e6) * (pBase * 1.25) + (u.cacheRead / 1e6) * pRead
  )
}

function runArm(label: string, bin: string, rep: number, args: Args): ArmResult {
  const cwd = buildWorkspace()
  const prompt = buildPrompt()
  const model = label === 'claude' ? args.modelClaude || args.model : args.modelClaudin || args.model

  const t0 = performance.now()
  const res = spawnSync(bin, ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose'], {
    cwd,
    encoding: 'utf8',
    timeout: args.timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      // Headless `-p` drains auto-backgrounded sub-agents non-deterministically;
      // an orphaned one hides its tokens from the parent's usage.
      CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const events = parseJsonl(stdout)

  const streamTimeline = timelineFrom([events])
  let timeline = streamTimeline
  let allEvents = events
  const sid = sessionIdFrom(events)
  const tPath = sid ? transcriptPath(sid) : null
  if (tPath) {
    const tEvents = parseJsonl(readFileSync(tPath, 'utf8'))
    timeline = timelineFrom([events, tEvents])
    if (toolCallsFrom(tEvents).length >= toolCallsFrom(events).length) allEvents = tEvents
  }
  const grandTotal = (rows: TimelineRow[]) => rows.reduce((a, r) => a + r.in + r.out + r.cR + r.cW, 0)
  const usageMergedFromTranscript = grandTotal(timeline) > grandTotal(streamTimeline)

  const sums = timeline.reduce(
    (acc, r) => ({
      input: acc.input + r.in,
      output: acc.output + r.out,
      cacheRead: acc.cacheRead + r.cR,
      cacheCreation: acc.cacheCreation + r.cW,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )
  const ctx = timeline.map(r => r.in + r.cR + r.cW)
  const calls = toolCallsFrom(allEvents)
  const toolMix: Record<string, number> = {}
  for (const c of calls) toolMix[c.name] = (toolMix[c.name] ?? 0) + 1

  // Grade BEFORE the workspace is discarded.
  const verdict = verify(cwd)
  const scalars = scalarsFrom(events)
  if (!args.keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label,
    bin,
    rep,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    firstContext: ctx[0] ?? 0,
    peakContext: ctx.length ? Math.max(...ctx) : 0,
    endContext: ctx[ctx.length - 1] ?? 0,
    ...scalars,
    estCostUsd: estimateCost(scalars.model ?? model, sums),
    sawSentinel: stdout.includes(SENTINEL),
    timeline,
    usageMergedFromTranscript,
    toolCalls: calls.length,
    searchCalls: calls.filter(c => c.search).length,
    toolMix,
    allResultChars: calls.reduce((a, c) => a + c.resultChars, 0),
    searchResultChars: calls.filter(c => c.search).reduce((a, c) => a + c.resultChars, 0),
    verdict,
    workspace: args.keep ? cwd : '(removed)',
    transcript: tPath,
    stderr: res.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// CLI plumbing + reporting.
// ---------------------------------------------------------------------------

type Args = {
  only: 'claudin' | 'claude' | null
  reps: number
  timeoutMs: number
  keep: boolean
  json: boolean
  dryRun: boolean
  model: string
  modelClaudin: string
  modelClaude: string
  binClaudin: string
  binClaude: string
  timelineRows: number
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    only: null,
    reps: 1,
    timeoutMs: 1_200_000,
    keep: false,
    json: false,
    dryRun: false,
    model: DEFAULT_MODEL,
    modelClaudin: '',
    modelClaude: '',
    binClaudin: join(REPO_ROOT, 'bin', 'claudin'),
    binClaude: 'claude',
    timelineRows: 40,
  }
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--json') a.json = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--model-claudin=')) a.modelClaudin = x.slice('--model-claudin='.length)
    else if (x.startsWith('--model-claude=')) a.modelClaude = x.slice('--model-claude='.length)
    else if (x.startsWith('--bin-claudin=')) a.binClaudin = x.slice('--bin-claudin='.length)
    else if (x.startsWith('--bin-claude=')) a.binClaude = x.slice('--bin-claude='.length)
    else if (x.startsWith('--timeline-rows=')) a.timelineRows = Number(x.slice('--timeline-rows='.length))
  }
  return a
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function delta(a: number, b: number): string {
  if (a === 0) return b === 0 ? '0%' : 'n/a'
  const pct = ((b - a) / a) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function pick(arms: ArmResult[], key: keyof ArmResult): number {
  return median(arms.map(a => Number(a[key] ?? 0)))
}

function printTimeline(arm: ArmResult, cap: number): void {
  console.log(`\n  ${arm.label} rep ${arm.rep} — per-turn context (in + cacheR + cacheW) and what each turn cost:`)
  console.log(`    ${'turn'.padStart(4)} ${'context'.padStart(9)} ${'in'.padStart(8)} ${'cacheR'.padStart(9)} ${'cacheW'.padStart(9)} ${'out'.padStart(7)}  reuse`)
  arm.timeline.slice(0, cap).forEach((r, i) => {
    const reuse = r.cR + r.cW > 0 ? `${((r.cR / (r.cR + r.cW)) * 100).toFixed(0)}%` : '--'
    console.log(
      `    ${String(i + 1).padStart(4)} ${fmt(r.in + r.cR + r.cW).padStart(9)} ${fmt(r.in).padStart(8)} ` +
        `${fmt(r.cR).padStart(9)} ${fmt(r.cW).padStart(9)} ${fmt(r.out).padStart(7)}  ${reuse.padStart(5)}`,
    )
  })
  if (arm.timeline.length > cap) console.log(`    … ${arm.timeline.length - cap} more turns (--timeline-rows=N)`)
}

function printArm(arm: ArmResult): void {
  const v = arm.verdict
  const bad: string[] = []
  if (arm.exitCode !== 0) bad.push(`exit=${arm.exitCode}`)
  if (!arm.sawSentinel) bad.push('sentinel missing')
  if (arm.model && !/sonnet-5/.test(arm.model)) bad.push(`WRONG MODEL: ${arm.model}`)
  if (arm.timeline.length === 0) bad.push('no usage rows captured')
  // Without the transcript the stream is the only source, and at least one CLI
  // is known to under-report output there — the totals cannot be trusted.
  if (!arm.transcript) bad.push('no transcript found (usage may be partial)')

  console.log(
    `\n${arm.label} rep ${arm.rep}: model=${arm.model ?? '?'} turns=${arm.numTurns ?? '?'} ` +
      `wall=${(arm.wallMs / 1000).toFixed(1)}s sentinel=${arm.sawSentinel ? 'Y' : 'N'}`,
  )
  console.log(
    `  task: ${v.ok ? 'PASS' : 'FAIL'} — build ${v.buildOk ? 'green' : `RED (${v.buildErr || 'no error line'})`}, ` +
      `sites ${v.sitesDone}/${CALL_SITES.length}` +
      (v.sitesMissed.length ? ` (missed: ${v.sitesMissed.join(', ')})` : '') +
      (v.aliasLeft ? ', ALIAS LEFT in format.js' : '') +
      (v.decoysBroken.length ? `, decoys BROKEN: ${v.decoysBroken.join(', ')}` : '') +
      (v.decoysEdited.length ? `, decoys edited: ${v.decoysEdited.length}` : ''),
  )
  const mix = Object.entries(arm.toolMix)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(' ')
  console.log(
    `  tools: ${arm.toolCalls} calls (${arm.searchCalls} search) — ${mix || 'none'}; ` +
      `payload ${fmt(arm.allResultChars)} chars, ${fmt(arm.searchResultChars)} from search`,
  )
  console.log(
    `  usage: ${arm.timeline.length} assistant turns, source=` +
      `${arm.usageMergedFromTranscript ? 'stream+transcript (stream alone was short)' : 'stream (transcript agreed)'}`,
  )
  if (bad.length > 0) {
    console.log(`  !! NOT clean: ${bad.join(', ')}`)
    if (arm.stderr) console.log(arm.stderr.split('\n').slice(0, 12).map(l => `     | ${l}`).join('\n'))
  }
}

/**
 * Prove the fixture and the grader before spending model tokens.
 *
 * Five gates, each of which has to behave differently from the others or the
 * bench is measuring nothing:
 *   1 pristine BUILDS      — the task starts from a green tree
 *   2 pristine FAILS grade — the task is not already done
 *   3 solution builds+passes
 *   4 one missed call site FAILS THE BUILD  ← the bundler is a real oracle
 *   5 blind global replace passes the build but FAILS on the decoys
 */
function dryRun(args: Args): void {
  let bad = 0
  const line = (ok: boolean, label: string, detail: string) => {
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(34)} ${detail}`)
  }

  const pristine = buildWorkspace()
  const pb = runBuild(pristine)
  line(pb.ok, 'pristine builds', pb.ok ? 'exit 0' : `RED: ${pb.err}`)
  const pv = verify(pristine)
  line(!pv.ok, 'pristine fails the grade', `sites ${pv.sitesDone}/${CALL_SITES.length}, alias ${pv.aliasLeft ? 'present' : 'gone'}`)
  if (!args.keep) rmSync(pristine, { recursive: true, force: true })

  const solved = buildWorkspace(SOLUTION)
  const sv = verify(solved)
  line(sv.ok, 'reference solution passes', `build ${sv.buildOk ? 'green' : `RED: ${sv.buildErr}`}, sites ${sv.sitesDone}/${CALL_SITES.length}`)
  if (!args.keep) rmSync(solved, { recursive: true, force: true })

  // The aliased call site (badge.js) left behind: its import still asks for a
  // name the module no longer exports.
  const partialOverrides = { ...SOLUTION }
  delete partialOverrides['src/ui/badge.js']
  const partial = buildWorkspace(partialOverrides)
  const qb = runBuild(partial)
  line(!qb.ok, 'one missed site fails the build', qb.ok ? 'BUILD WAS GREEN — the oracle is broken' : `RED: ${qb.err}`)
  if (!args.keep) rmSync(partial, { recursive: true, force: true })

  // A blind `s/formatCurrency/formatMoney/g` over every file: consistent, so
  // the bundler is happy, but it renames the lookalike and the event string.
  const sedded: Record<string, string> = {}
  for (const [rel, body] of Object.entries(FIXTURE)) {
    if (!rel.endsWith('.js')) continue
    sedded[rel] = body.replace(/formatCurrency/g, 'formatMoney')
  }
  const blind = buildWorkspace(sedded)
  const bv = verify(blind)
  line(
    bv.buildOk && !bv.ok && bv.decoysBroken.length > 0,
    'blind global replace is caught',
    `build ${bv.buildOk ? 'green' : 'RED'}, decoys broken: ${bv.decoysBroken.length || 'NONE — decoys are decorative'}`,
  )
  if (!args.keep) rmSync(blind, { recursive: true, force: true })

  console.log(bad === 0 ? '\nfixture and grader are sound' : `\n!! ${bad} gate(s) failed — do not run the bench`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (!Bun.which('bun')) {
    console.error('bun is required: the fixture builds with `bun build`.')
    process.exit(1)
  }
  if (args.dryRun) {
    dryRun(args)
    return
  }
  if (!existsSync(resolve(REPO_ROOT, 'dist/cli.mjs'))) {
    console.error('dist/cli.mjs missing — run `bun run build` first.')
    process.exit(1)
  }
  if (args.only !== 'claudin' && !Bun.which(args.binClaude)) {
    console.error(`${args.binClaude} not found on PATH — pass --bin-claude=… or --only=claudin.`)
    process.exit(1)
  }

  console.log(
    `\ncli-search-edit-ab — claudindev vs claude, same search→edit→build task` +
      `\n  model: ${args.model}   reps: ${args.reps}   workspace: fresh ${join(tmpdir(), 'cli-search-edit-ab-*')}` +
      `\n  task:  find 5 call sites of formatCurrency across 10 .js files, rewrite them, get the build green`,
  )

  const runs: ArmResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    // Alternate which arm pays the cold prompt cache.
    const order: Array<'claudin' | 'claude'> = rep % 2 === 1 ? ['claudin', 'claude'] : ['claude', 'claudin']
    for (const label of order) {
      if (args.only && args.only !== label) continue
      const bin = label === 'claudin' ? args.binClaudin : args.binClaude
      console.log(`\nrunning ${label} (${bin}) rep ${rep}/${args.reps} …`)
      const arm = runArm(label, bin, rep, args)
      runs.push(arm)
      printArm(arm)
      printTimeline(arm, args.timelineRows)
    }
  }

  const claudin = runs.filter(r => r.label === 'claudin')
  const claude = runs.filter(r => r.label === 'claude')

  if (claudin.length > 0 && claude.length > 0) {
    console.log(`\n${' '.repeat(28)}${'claudin'.padStart(12)}${'claude'.padStart(13)}${'delta'.padStart(10)}`)
    const cmp = (label: string, key: keyof ArmResult, f: (n: number) => string = fmt) => {
      const a = pick(claudin, key)
      const b = pick(claude, key)
      console.log(`  ${label.padEnd(26)} ${f(a).padStart(12)} ${f(b).padStart(12)} ${delta(a, b).padStart(9)}`)
    }
    cmp('input', 'input')
    cmp('output', 'output')
    cmp('cache_creation (write)', 'cacheCreation')
    cmp('cache_read', 'cacheRead')
    cmp('first-turn context', 'firstContext')
    cmp('peak context', 'peakContext')
    cmp('end context', 'endContext')
    cmp('turns', 'numTurns', String)
    cmp('tool calls', 'toolCalls', String)
    cmp('search calls', 'searchCalls', String)
    cmp('tool payload chars', 'allResultChars')
    cmp('cost usd (CLI)', 'costUsd', n => n.toFixed(4))
    cmp('cost usd (list est)', 'estCostUsd', n => n.toFixed(4))
    cmp('wall seconds', 'wallMs', n => (n / 1000).toFixed(1))

    const pass = (rs: ArmResult[]) => `${rs.filter(r => r.verdict.ok).length}/${rs.length}`
    console.log(`\n  task passed:               ${pass(claudin).padStart(12)} ${pass(claude).padStart(12)}`)
    console.log(`  ↑ a token delta between arms that did NOT both pass compares different amounts of work.`)

    if (args.reps < 3) {
      console.log(`  ↑ ${args.reps} rep(s): treat as directional. Re-run with --reps=3 and compare RANGES, not medians.`)
    } else {
      const range = (rs: ArmResult[], key: keyof ArmResult) => {
        const xs = rs.map(r => Number(r[key] ?? 0))
        return [Math.min(...xs), Math.max(...xs)] as const
      }
      const [aLo, aHi] = range(claudin, 'costUsd')
      const [bLo, bHi] = range(claude, 'costUsd')
      const overlap = aLo <= bHi && bLo <= aHi
      console.log(
        `  cost range:                claudin $${aLo.toFixed(4)}–$${aHi.toFixed(4)}  claude $${bLo.toFixed(4)}–$${bHi.toFixed(4)}` +
          `  → ${overlap ? 'OVERLAP: no cost claim' : 'separated'}`,
      )
    }
  }

  if (args.json) {
    const out = join(REPO_ROOT, 'scripts', 'profile', 'cli-search-edit-ab.json')
    writeFileSync(out, JSON.stringify(runs, null, 2))
    console.log(`\njson → ${out}`)
  }
  console.log()
}

main()
