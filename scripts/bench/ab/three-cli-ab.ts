#!/usr/bin/env bun
/**
 * Three-CLI A/B — released `claudin` vs this checkout (`claudindev`) vs `claude`,
 * on one search → read → edit → build task in a throwaway 15-file project.
 *
 * Sibling of `cli-search-edit-ab.ts`, which pits two binaries against a 10-file
 * fixture. Two things are different here and both are the point:
 *  - THREE arms, so the released Claudin and the working tree are measured
 *    against each other as well as against Claude Code. A regression that only
 *    shows up between two Claudin builds is invisible to the two-arm bench.
 *  - the fixture is sized to the workload the comparison is about: 15 source
 *    files of which exactly TEN mention the target symbol and exactly FIVE must
 *    change. Search has something to discard, reading has a real cost, and the
 *    edit count is a number the grader can check rather than a hope.
 *
 * Protocol (inherited, and load-bearing):
 *  - A throwaway workspace under the OS temp dir, rebuilt byte-identically
 *    before every arm of every rep. Never this checkout: session state is keyed
 *    by project directory and would collide with the live session.
 *  - Sonnet 5 pinned on all three arms (`--model`). A run that reports another
 *    model is flagged, not reported — the cost column would compare price tiers.
 *  - Arm order ROTATES across reps (3-cycle). Whichever arm runs first pays the
 *    cold prompt cache; a fixed order bakes that straight into the delta, and
 *    cache read/write is the headline column here.
 *  - Every run is graded by `verify()` before its tokens are believed. A cheap
 *    arm that skipped a call site is not a win and the token table cannot tell.
 *
 * The build is the oracle: the four call sites reach the function through ESM
 * named imports, so a missed one fails `bun build` with "No matching export".
 * `--dry-run` proves that, and proves the decoys bite, before a token is spent.
 *
 * Usage:
 *   bun scripts/bench/ab/three-cli-ab.ts --dry-run        # validate the fixture
 *   bun scripts/bench/ab/three-cli-ab.ts --reps=3
 *   bun scripts/bench/ab/three-cli-ab.ts --only=claudindev --keep
 *   bun scripts/bench/ab/three-cli-ab.ts --reps=3 --json=/tmp/out.json
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { REPO_ROOT } from '../../repoRoot'
import {
  estimateCost,
  parseJsonl,
  scalarsFrom,
  sessionIdFrom,
  timelineFrom,
  toolCallsFrom,
  transcriptPath,
  type TimelineRow,
} from './cliUsage'

export const SENTINEL = 'BENCH_DONE'
const DEFAULT_MODEL = 'claude-sonnet-5'

type Label = 'claudin' | 'claudindev' | 'claude'
const ARMS: Label[] = ['claudin', 'claudindev', 'claude']

// ---------------------------------------------------------------------------
// The fixture: 15 plain-ESM .js files plus a package.json.
//
// Exactly TEN files carry the literal token `formatCurrency`, so one search
// returns ten hits and the model has to read them to tell the five real ones
// from the five that only look real:
//
//   REAL (must change)                    DECOY (must survive untouched)
//   core/format.js     the definition     core/strings.js   formatCurrencyLabel + comment
//   billing/checkout.js  concatenation    ui/label.js       imports the lookalike
//   billing/invoice.js   arrow body       analytics/track.js 'formatCurrency' event string
//   reports/summary.js   template literal reports/export.js  'formatCurrency' column key
//   ui/badge.js        ALIASED import     billing/refund.js  names it in a comment only
//
// badge.js is the one a grep for `formatCurrency(` misses: it imports
// `formatCurrency as money` and the call reads `money(...)`.
//
// The remaining five never mention it — core/actors.js, ui/table.js,
// analytics/funnel.js, lib/http.js and the index.js entry that keeps every
// module live for the bundler. They are there so "read everything" is a
// measurably worse strategy than searching first.
// ---------------------------------------------------------------------------

const F = (...lines: string[]) => lines.join('\n') + '\n'

const PKG = JSON.stringify(
  {
    name: 'ledger',
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

  // --- core -------------------------------------------------------------
  'src/core/format.js': F(
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

  'src/core/strings.js': F(
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

  'src/core/actors.js': F(
    "export const SYSTEM_ACTOR = 'system'",
    '',
    'export function actorName(actor) {',
    '  return actor && actor.name ? actor.name : SYSTEM_ACTOR',
    '}',
  ),

  // --- billing ----------------------------------------------------------
  'src/billing/checkout.js': F(
    "import { formatCurrency, parseAmount } from '../core/format.js'",
    '',
    'export function checkoutLine(item) {',
    '  const total = parseAmount(item.price) * item.qty',
    "  return item.name + ' - ' + formatCurrency(total)",
    '}',
  ),

  'src/billing/invoice.js': F(
    "import { formatCurrency } from '../core/format.js'",
    '',
    'export function renderInvoice(invoice) {',
    '  return invoice.lines',
    "    .map(line => line.sku + ' ' + formatCurrency(line.amount))",
    "    .join('\\n')",
    '}',
  ),

  'src/billing/refund.js': F(
    "import { parseAmount } from '../core/format.js'",
    '',
    '// Refund amounts stay raw here. The display layer calls formatCurrency()',
    '// on them further down, so do not format anything in this module.',
    'export function refundTotal(refund) {',
    '  return refund.lines.reduce((sum, line) => sum + parseAmount(line.amount), 0)',
    '}',
  ),

  // --- reports ----------------------------------------------------------
  'src/reports/summary.js': F(
    "import { formatCurrency, parseAmount } from '../core/format.js'",
    '',
    'export function cartSummary(items) {',
    '  const total = items.reduce((sum, item) => sum + parseAmount(item.price), 0)',
    '  return { count: items.length, total, label: `Total: ${formatCurrency(total)}` }',
    '}',
  ),

  'src/reports/export.js': F(
    "const COLUMNS = ['sku', 'qty', 'formatCurrency', 'total']",
    '',
    'export function exportRows(rows) {',
    "  return rows.map(row => COLUMNS.map(col => row[col] ?? '').join(','))",
    '}',
  ),

  // --- ui ---------------------------------------------------------------
  'src/ui/badge.js': F(
    "import { formatCurrency as money } from '../core/format.js'",
    '',
    'export function priceBadge(product) {',
    "  return { text: money(product.price), tone: product.price > 100 ? 'high' : 'low' }",
    '}',
  ),

  'src/ui/label.js': F(
    "import { formatCurrencyLabel, titleCase } from '../core/strings.js'",
    '',
    '// This module never formats amounts; formatCurrency in format.js does that.',
    'export function priceLabel(code, name) {',
    "  return titleCase(name) + ' (' + formatCurrencyLabel(code) + ')'",
    '}',
  ),

  'src/ui/table.js': F(
    "import { titleCase } from '../core/strings.js'",
    '',
    'export function renderTable(headers, rows) {',
    "  const head = headers.map(titleCase).join(' | ')",
    "  return [head, ...rows.map(row => row.join(' | '))].join('\\n')",
    '}',
  ),

  // --- analytics --------------------------------------------------------
  'src/analytics/track.js': F(
    "const EVENTS = ['formatCurrency', 'checkout', 'invoice', 'refund']",
    '',
    'export function track(event, payload) {',
    '  if (!EVENTS.includes(event)) return null',
    '  return { event, payload }',
    '}',
  ),

  'src/analytics/funnel.js': F(
    "import { track } from './track.js'",
    '',
    'export function funnelStep(name, payload) {',
    '  return track(name, { ...payload, step: name })',
    '}',
  ),

  // --- lib + entry ------------------------------------------------------
  'src/lib/http.js': F(
    'export function buildQuery(params) {',
    '  return Object.entries(params)',
    "    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))",
    "    .join('&')",
    '}',
  ),

  'src/index.js': F(
    "export { checkoutLine } from './billing/checkout.js'",
    "export { renderInvoice } from './billing/invoice.js'",
    "export { refundTotal } from './billing/refund.js'",
    "export { cartSummary } from './reports/summary.js'",
    "export { exportRows } from './reports/export.js'",
    "export { priceBadge } from './ui/badge.js'",
    "export { priceLabel } from './ui/label.js'",
    "export { renderTable } from './ui/table.js'",
    "export { track } from './analytics/track.js'",
    "export { funnelStep } from './analytics/funnel.js'",
    "export { buildQuery } from './lib/http.js'",
    "export { actorName } from './core/actors.js'",
    "export { parseAmount } from './core/format.js'",
    "export { titleCase } from './core/strings.js'",
  ),
}

const SOURCE_FILES = Object.keys(FIXTURE).filter(f => f.endsWith('.js'))

/** The four call sites, plus the definition, are the five files that change. */
const CALL_SITES = ['src/billing/checkout.js', 'src/billing/invoice.js', 'src/reports/summary.js', 'src/ui/badge.js']
const DEFINITION = 'src/core/format.js'
const MUST_EDIT = [DEFINITION, ...CALL_SITES]

/** Files a correct run leaves byte-identical. A global replace breaks four. */
const DECOYS = [
  'src/core/strings.js',
  'src/ui/label.js',
  'src/analytics/track.js',
  'src/reports/export.js',
  'src/billing/refund.js',
]

/** Files that never mention the target — reading them is pure over-fetch. */
const UNRELATED = ['src/core/actors.js', 'src/ui/table.js', 'src/analytics/funnel.js', 'src/lib/http.js', 'src/index.js']

/** The reference solution, used only by --dry-run to prove the grader. */
const SOLUTION: Record<string, string> = {
  'src/core/format.js': F(
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
  'src/billing/checkout.js': F(
    "import { formatMoney, parseAmount } from '../core/format.js'",
    '',
    'export function checkoutLine(item) {',
    '  const total = parseAmount(item.price) * item.qty',
    "  return item.name + ' - ' + formatMoney(total, 'USD')",
    '}',
  ),
  'src/billing/invoice.js': F(
    "import { formatMoney } from '../core/format.js'",
    '',
    'export function renderInvoice(invoice) {',
    '  return invoice.lines',
    "    .map(line => line.sku + ' ' + formatMoney(line.amount, 'USD'))",
    "    .join('\\n')",
    '}',
  ),
  'src/reports/summary.js': F(
    "import { formatMoney, parseAmount } from '../core/format.js'",
    '',
    'export function cartSummary(items) {',
    '  const total = items.reduce((sum, item) => sum + parseAmount(item.price), 0)',
    "  return { count: items.length, total, label: `Total: ${formatMoney(total, 'USD')}` }",
    '}',
  ),
  'src/ui/badge.js': F(
    "import { formatMoney as money } from '../core/format.js'",
    '',
    'export function priceBadge(product) {',
    "  return { text: money(product.price, 'USD'), tone: product.price > 100 ? 'high' : 'low' }",
    '}',
  ),
}

export function buildWorkspace(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'three-cli-ab-'))
  for (const [rel, body] of Object.entries({ ...FIXTURE, ...overrides })) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return root
}

// ---------------------------------------------------------------------------
// The task. Identical text for all three arms — it names no tool and no search
// strategy, because the strategy is what is being measured.
// ---------------------------------------------------------------------------

export function buildPrompt(): string {
  return [
    'This is a small JavaScript package: plain ESM .js, no TypeScript, 15 source files under src/.',
    '',
    'Task:',
    '1. Find every file in this project that mentions `formatCurrency`. There are ten of them.',
    '2. Read those ten files and work out which are real call sites of the function defined in',
    '   src/core/format.js, and which only resemble it.',
    '3. In src/core/format.js, rename the exported `formatCurrency` to `formatMoney` and give it',
    '   a second, required parameter `currency` (a code such as "USD") that selects the symbol,',
    '   instead of the hardcoded one it uses today.',
    '4. Update every real call site so that it calls `formatMoney` and passes the string \'USD\'',
    '   as the second argument. Exactly five files need to change, counting src/core/format.js.',
    '5. Do NOT leave a `formatCurrency` alias, wrapper or re-export behind: the old name must be',
    '   gone from the code.',
    '6. Do NOT rename anything that merely looks similar. Some identifiers and strings in this',
    '   project resemble the target and are unrelated to it.',
    '7. Build the project with `npm run build` and make sure the build succeeds.',
    '',
    'Work autonomously and do not ask questions.',
    `When the build is green and every call site is updated, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Grading. Run before any token number is believed.
// ---------------------------------------------------------------------------

export type Verdict = {
  buildOk: boolean
  buildErr: string
  sitesDone: number
  sitesMissed: string[]
  defOk: boolean
  defWhy: string
  aliasLeft: boolean
  decoysBroken: string[]
  filesChanged: string[]
  strayChanged: string[]
  ok: boolean
}

function readIf(root: string, rel: string): string {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function runBuild(root: string, timeoutMs = 120_000): { ok: boolean; err: string } {
  const res = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const err = out
    .split('\n')
    .filter(l => /error|Error|ERR!/.test(l))
    .slice(0, 3)
    .join(' | ')
  return { ok: res.status === 0, err: err.slice(0, 240) }
}

export function verify(root: string): Verdict {
  const build = runBuild(root)

  const sitesMissed: string[] = []
  for (const rel of CALL_SITES) {
    const body = readIf(root, rel)
    const converted = !/\bformatCurrency\b/.test(body) && /\bformatMoney\b/.test(body) && /['"]USD['"]/.test(body)
    if (!converted) sitesMissed.push(rel)
  }

  // The definition has to actually gain the parameter and USE it. A rename that
  // keeps the hardcoded symbol builds green and passes every call-site check.
  const def = readIf(root, DEFINITION)
  const hasTwoParams = /function\s+formatMoney\s*\(\s*[^),]+,\s*[^)]+\)/.test(def)
  const usesParam = /SYMBOLS\s*\[/.test(def)
  const defWhy = !/\bformatMoney\b/.test(def)
    ? 'formatMoney not defined'
    : !hasTwoParams
      ? 'still one parameter'
      : !usesParam
        ? 'symbol still hardcoded'
        : ''
  const defOk = defWhy === ''

  // An alias/re-export left behind keeps the build green while leaving the call
  // sites untouched — the one way past the bundler without doing the task.
  const aliasLeft = /\bformatCurrency\b/.test(def)

  const decoysBroken: string[] = []
  if (!/\bformatCurrencyLabel\b/.test(readIf(root, 'src/core/strings.js'))) decoysBroken.push('src/core/strings.js')
  if (!/\bformatCurrencyLabel\b/.test(readIf(root, 'src/ui/label.js'))) decoysBroken.push('src/ui/label.js')
  if (!/['"]formatCurrency['"]/.test(readIf(root, 'src/analytics/track.js'))) decoysBroken.push('src/analytics/track.js')
  if (!/['"]formatCurrency['"]/.test(readIf(root, 'src/reports/export.js'))) decoysBroken.push('src/reports/export.js')

  // Churn: which of the 15 differ from the fixture, and which of those should not.
  const filesChanged = SOURCE_FILES.filter(rel => readIf(root, rel) !== FIXTURE[rel])
  const strayChanged = filesChanged.filter(rel => !MUST_EDIT.includes(rel))

  return {
    buildOk: build.ok,
    buildErr: build.err,
    sitesDone: CALL_SITES.length - sitesMissed.length,
    sitesMissed,
    defOk,
    defWhy,
    aliasLeft,
    decoysBroken,
    filesChanged,
    strayChanged,
    ok: build.ok && sitesMissed.length === 0 && defOk && !aliasLeft && decoysBroken.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Tool accounting specific to this workload: the prompt asks for a search, ten
// reads, five edits and a build, so count each lane rather than only the total.
// `cliUsage.toolCallsFrom` drops the tool input, so the classification is local.
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'View'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'apply_patch', 'Patch', 'NotebookEdit', 'Update', 'Rename'])
const BUILD_RE = /\b(npm run build|bun build|yarn build|pnpm build|npm_run_build)\b/
const BASH_READ_RE = /\b(cat|head|tail|sed -n|less|more)\b/

type Lanes = { read: number; edit: number; build: number; bashRead: number; agent: number; filesRead: Set<string> }

function lanesFrom(events: Record<string, unknown>[]): Lanes {
  const lanes: Lanes = { read: 0, edit: 0, build: 0, bashRead: 0, agent: 0, filesRead: new Set() }
  const seen = new Set<string>()
  for (const v of events) {
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const id = typeof block.id === 'string' ? block.id : ''
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      const input = (block.input ?? {}) as Record<string, unknown>
      const command = typeof input.command === 'string' ? input.command : ''
      if (READ_TOOLS.has(block.name)) {
        lanes.read++
        const p = typeof input.file_path === 'string' ? input.file_path : ''
        if (p) lanes.filesRead.add(p.replace(/^.*?\/src\//, 'src/'))
      } else if (EDIT_TOOLS.has(block.name)) {
        lanes.edit++
      } else if (block.name === 'Agent' || block.name === 'Task') {
        lanes.agent++
      } else if (block.name === 'Bash' || block.name === 'Build') {
        if (BUILD_RE.test(command) || block.name === 'Build') lanes.build++
        else if (BASH_READ_RE.test(command)) lanes.bashRead++
      }
    }
  }
  return lanes
}

// ---------------------------------------------------------------------------
// Arms.
// ---------------------------------------------------------------------------

type ArmResult = {
  label: Label
  bin: string
  rep: number
  slot: number
  exitCode: number
  wallMs: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheReusePct: number
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
  readCalls: number
  editCalls: number
  buildCalls: number
  bashReadCalls: number
  agentCalls: number
  distinctFilesRead: number
  toolMix: Record<string, number>
  allResultChars: number
  searchResultChars: number
  verdict: Verdict
  workspace: string
  transcript: string | null
  stderr: string
}

function runArm(label: Label, bin: string, rep: number, slot: number, args: Args): ArmResult {
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
  const lanes = lanesFrom(allEvents)
  const toolMix: Record<string, number> = {}
  for (const c of calls) toolMix[c.name] = (toolMix[c.name] ?? 0) + 1

  // Grade BEFORE the workspace is discarded.
  const verdict = verify(cwd)
  const scalars = scalarsFrom(events)
  if (!args.keep) rmSync(cwd, { recursive: true, force: true })

  const cacheTotal = sums.cacheRead + sums.cacheCreation
  return {
    label,
    bin,
    rep,
    slot,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    cacheReusePct: cacheTotal > 0 ? (sums.cacheRead / cacheTotal) * 100 : 0,
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
    readCalls: lanes.read,
    editCalls: lanes.edit,
    buildCalls: lanes.build,
    bashReadCalls: lanes.bashRead,
    agentCalls: lanes.agent,
    distinctFilesRead: lanes.filesRead.size,
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
  only: Label | null
  reps: number
  timeoutMs: number
  keep: boolean
  json: string
  replay: string
  dryRun: boolean
  model: string
  modelClaudin: string
  modelClaude: string
  bins: Record<Label, string>
  timelineRows: number
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    only: null,
    reps: 1,
    timeoutMs: 1_200_000,
    keep: false,
    json: '',
    replay: '',
    dryRun: false,
    model: DEFAULT_MODEL,
    modelClaudin: '',
    modelClaude: '',
    bins: {
      claudin: 'claudin',
      claudindev: join(REPO_ROOT, 'bin', 'claudin'),
      claude: 'claude',
    },
    timelineRows: 40,
  }
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x === '--json') a.json = join(tmpdir(), 'three-cli-ab.json')
    else if (x.startsWith('--json=')) a.json = x.slice('--json='.length)
    else if (x.startsWith('--replay=')) a.replay = x.slice('--replay='.length)
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Label
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--model-claudin=')) a.modelClaudin = x.slice('--model-claudin='.length)
    else if (x.startsWith('--model-claude=')) a.modelClaude = x.slice('--model-claude='.length)
    else if (x.startsWith('--bin-claudin=')) a.bins.claudin = x.slice('--bin-claudin='.length)
    else if (x.startsWith('--bin-claudindev=')) a.bins.claudindev = x.slice('--bin-claudindev='.length)
    else if (x.startsWith('--bin-claude=')) a.bins.claude = x.slice('--bin-claude='.length)
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
  return arms.length ? median(arms.map(a => Number(a[key] ?? 0))) : 0
}

function printTimeline(arm: ArmResult, cap: number): void {
  console.log(`\n  ${arm.label} rep ${arm.rep} — per-turn context (in + cacheR + cacheW) and what each turn cost:`)
  console.log(
    `    ${'turn'.padStart(4)} ${'context'.padStart(9)} ${'in'.padStart(8)} ${'cacheR'.padStart(9)} ${'cacheW'.padStart(9)} ${'out'.padStart(7)}  reuse`,
  )
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
    `\n${arm.label} rep ${arm.rep} (slot ${arm.slot}): model=${arm.model ?? '?'} turns=${arm.numTurns ?? '?'} ` +
      `wall=${(arm.wallMs / 1000).toFixed(1)}s sentinel=${arm.sawSentinel ? 'Y' : 'N'}`,
  )
  console.log(
    `  task: ${v.ok ? 'PASS' : 'FAIL'} — build ${v.buildOk ? 'green' : `RED (${v.buildErr || 'no error line'})`}, ` +
      `sites ${v.sitesDone}/${CALL_SITES.length}` +
      (v.sitesMissed.length ? ` (missed: ${v.sitesMissed.join(', ')})` : '') +
      `, definition ${v.defOk ? 'ok' : `BAD (${v.defWhy})`}` +
      (v.aliasLeft ? ', ALIAS LEFT in format.js' : '') +
      (v.decoysBroken.length ? `, decoys BROKEN: ${v.decoysBroken.join(', ')}` : ''),
  )
  console.log(
    `  churn: ${v.filesChanged.length}/5 files changed` +
      (v.strayChanged.length ? ` — STRAY: ${v.strayChanged.join(', ')}` : ' (exactly the five that had to)'),
  )
  const mix = Object.entries(arm.toolMix)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(' ')
  console.log(
    `  lanes: ${arm.searchCalls} search, ${arm.readCalls} read (${arm.distinctFilesRead} distinct files` +
      `${arm.bashReadCalls ? `, +${arm.bashReadCalls} bash-read` : ''}), ${arm.editCalls} edit, ` +
      `${arm.buildCalls} build${arm.agentCalls ? `, ${arm.agentCalls} sub-agent` : ''}`,
  )
  console.log(`  tools: ${arm.toolCalls} calls — ${mix || 'none'}; payload ${fmt(arm.allResultChars)} chars, ${fmt(arm.searchResultChars)} from search`)
  console.log(
    `  usage: ${arm.timeline.length} assistant turns, source=` +
      `${arm.usageMergedFromTranscript ? 'stream+transcript (stream alone was short)' : 'stream (transcript agreed)'}`,
  )
  if (bad.length > 0) {
    console.log(`  !! NOT clean: ${bad.join(', ')}`)
    if (arm.stderr)
      console.log(
        arm.stderr
          .split('\n')
          .slice(0, 12)
          .map(l => `     | ${l}`)
          .join('\n'),
      )
  }
}

/**
 * Prove the fixture and the grader before spending model tokens.
 *
 * Seven gates, each of which has to behave differently from the others or the
 * bench is measuring nothing:
 *   1 the fixture has the shape the prompt claims (15 files, 10 mentions, 5 edits)
 *   2 pristine BUILDS      — the task starts from a green tree
 *   3 pristine FAILS grade — the task is not already done
 *   4 solution builds + passes, and touches exactly five files
 *   5 one missed call site FAILS THE BUILD  ← the bundler is a real oracle
 *   6 a rename that keeps the hardcoded symbol is caught by the definition check
 *   7 a blind global replace passes the build but FAILS on the decoys
 */
function dryRun(args: Args): void {
  let bad = 0
  const line = (ok: boolean, label: string, detail: string) => {
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(38)} ${detail}`)
  }

  const mentions = SOURCE_FILES.filter(rel => /formatCurrency/.test(FIXTURE[rel]!))
  line(
    SOURCE_FILES.length === 15 && mentions.length === 10 && MUST_EDIT.length === 5,
    'fixture shape matches the prompt',
    `${SOURCE_FILES.length} files, ${mentions.length} mention the symbol, ${MUST_EDIT.length} must change, ${UNRELATED.length} unrelated`,
  )

  const pristine = buildWorkspace()
  const pb = runBuild(pristine)
  line(pb.ok, 'pristine builds', pb.ok ? 'exit 0' : `RED: ${pb.err}`)
  const pv = verify(pristine)
  line(!pv.ok, 'pristine fails the grade', `sites ${pv.sitesDone}/${CALL_SITES.length}, alias ${pv.aliasLeft ? 'present' : 'gone'}`)
  if (!args.keep) rmSync(pristine, { recursive: true, force: true })

  const solved = buildWorkspace(SOLUTION)
  const sv = verify(solved)
  line(
    sv.ok && sv.filesChanged.length === 5 && sv.strayChanged.length === 0,
    'reference solution passes',
    `build ${sv.buildOk ? 'green' : `RED: ${sv.buildErr}`}, sites ${sv.sitesDone}/${CALL_SITES.length}, changed ${sv.filesChanged.length}`,
  )
  if (!args.keep) rmSync(solved, { recursive: true, force: true })

  // The aliased call site (badge.js) left behind: its import still asks for a
  // name the module no longer exports.
  const partialOverrides = { ...SOLUTION }
  delete partialOverrides['src/ui/badge.js']
  const partial = buildWorkspace(partialOverrides)
  const qb = runBuild(partial)
  line(!qb.ok, 'one missed site fails the build', qb.ok ? 'BUILD WAS GREEN — the oracle is broken' : `RED: ${qb.err}`)
  if (!args.keep) rmSync(partial, { recursive: true, force: true })

  // A rename with the parameter added but never read: green build, every call
  // site updated, and the function still ignores the currency it was handed.
  const lazy = { ...SOLUTION }
  lazy['src/core/format.js'] = SOLUTION['src/core/format.js']!.replace('SYMBOLS[currency]', 'SYMBOLS.USD')
  const lazyRoot = buildWorkspace(lazy)
  const lv = verify(lazyRoot)
  line(lv.buildOk && !lv.ok && !lv.defOk, 'unused-parameter rename is caught', `build ${lv.buildOk ? 'green' : 'RED'}, definition: ${lv.defWhy || 'ACCEPTED — the check is blind'}`)
  if (!args.keep) rmSync(lazyRoot, { recursive: true, force: true })

  // A blind `s/formatCurrency/formatMoney/g` over every file: consistent, so
  // the bundler is happy, but it renames the lookalike and the event strings.
  const sedded: Record<string, string> = {}
  for (const rel of SOURCE_FILES) sedded[rel] = FIXTURE[rel]!.replace(/formatCurrency/g, 'formatMoney')
  const blind = buildWorkspace(sedded)
  const bv = verify(blind)
  line(
    bv.buildOk && !bv.ok && bv.decoysBroken.length > 0,
    'blind global replace is caught',
    `build ${bv.buildOk ? 'green' : 'RED'}, decoys broken: ${bv.decoysBroken.length || 'NONE — decoys are decorative'}`,
  )
  if (!args.keep) rmSync(blind, { recursive: true, force: true })

  console.log(bad === 0 ? '\nfixture and grader are sound' : `\n!! ${bad} gate(s) failed — do not run the bench`)
  if (bad > 0) process.exit(1)
}

function report(runs: ArmResult[], args: Args): void {
  const by: Record<Label, ArmResult[]> = {
    claudin: runs.filter(r => r.label === 'claudin'),
    claudindev: runs.filter(r => r.label === 'claudindev'),
    claude: runs.filter(r => r.label === 'claude'),
  }
  const present = ARMS.filter(l => by[l].length > 0)
  if (present.length < 2) return

  const W = 13
  console.log(`\n${'='.repeat(30 + W * present.length + 22)}`)
  console.log(`median over ${args.reps} rep(s)${' '.repeat(6)}${present.map(l => l.padStart(W)).join('')}${'Δ dev/rel'.padStart(11)}${'Δ dev/claude'.padStart(14)}`)
  console.log('-'.repeat(30 + W * present.length + 22))

  const cmp = (label: string, key: keyof ArmResult, f: (n: number) => string = fmt) => {
    const vals = present.map(l => pick(by[l], key))
    const dev = pick(by.claudindev, key)
    const rel = pick(by.claudin, key)
    const cla = pick(by.claude, key)
    const dRel = by.claudin.length && by.claudindev.length ? delta(rel, dev) : '—'
    const dCla = by.claude.length && by.claudindev.length ? delta(cla, dev) : '—'
    console.log(`  ${label.padEnd(28)}${vals.map(v => f(v).padStart(W)).join('')}${dRel.padStart(11)}${dCla.padStart(14)}`)
  }

  console.log('  — cache —')
  cmp('cache_creation (write)', 'cacheCreation')
  cmp('cache_read', 'cacheRead')
  cmp('cache reuse %', 'cacheReusePct', n => `${n.toFixed(1)}%`)
  console.log('  — context —')
  cmp('first-turn context', 'firstContext')
  cmp('peak context', 'peakContext')
  cmp('end context', 'endContext')
  console.log('  — tokens —')
  cmp('input (uncached)', 'input')
  cmp('output', 'output')
  console.log('  — work —')
  cmp('turns', 'numTurns', n => String(Math.round(n)))
  cmp('tool calls', 'toolCalls', n => String(Math.round(n)))
  cmp('  search', 'searchCalls', n => String(Math.round(n)))
  cmp('  read', 'readCalls', n => String(Math.round(n)))
  cmp('  distinct files read', 'distinctFilesRead', n => String(Math.round(n)))
  cmp('  edit', 'editCalls', n => String(Math.round(n)))
  cmp('  build', 'buildCalls', n => String(Math.round(n)))
  cmp('tool payload chars', 'allResultChars')
  console.log('  — cost —')
  cmp('cost usd (CLI)', 'costUsd', n => n.toFixed(4))
  cmp('cost usd (list est)', 'estCostUsd', n => n.toFixed(4))
  cmp('wall seconds', 'wallMs', n => (n / 1000).toFixed(1))

  const pass = (rs: ArmResult[]) => `${rs.filter(r => r.verdict.ok).length}/${rs.length}`
  console.log(`\n  ${'task passed'.padEnd(28)}${present.map(l => pass(by[l]).padStart(W)).join('')}`)
  console.log(`  ↑ a token delta between arms that did NOT both pass compares different amounts of work.`)

  if (args.reps < 3) {
    console.log(`  ↑ ${args.reps} rep(s): directional only. Re-run with --reps=3 and compare RANGES, not medians.`)
    return
  }
  const range = (rs: ArmResult[], key: keyof ArmResult) => {
    const xs = rs.map(r => Number(r[key] ?? 0))
    return [Math.min(...xs), Math.max(...xs)] as const
  }
  // Ranges, and separation reported PAIRWISE. A single "some overlap" verdict
  // over three arms is unreadable here: two of them are the same product one
  // commit apart, so they overlap on nearly everything and would mask a real
  // separation against the third.
  console.log('')
  for (const key of ['costUsd', 'cacheRead', 'cacheCreation', 'peakContext', 'toolCalls'] as const) {
    const f = key === 'costUsd' ? (n: number) => `$${n.toFixed(4)}` : fmt
    const parts = present.map(l => {
      const [lo, hi] = range(by[l], key)
      return `${l} ${f(lo)}–${f(hi)}`
    })
    console.log(`  ${key}`)
    console.log(`    ${parts.join('   ')}`)
    const verdicts: string[] = []
    present.forEach((a, i) => {
      for (const b of present.slice(i + 1)) {
        const [aLo, aHi] = range(by[a], key)
        const [bLo, bHi] = range(by[b], key)
        verdicts.push(`${a}/${b} ${aLo <= bHi && bLo <= aHi ? 'overlap' : 'SEPARATED'}`)
      }
    })
    console.log(`    ${verdicts.join('   ')}`)
  }
  console.log(`  ↑ only a SEPARATED pair supports a claim at this rep count.`)
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
  // Re-render the tables from a previous run's --json. No model tokens: this is
  // how a reporting change is checked without paying for the bench again.
  if (args.replay) {
    const runs = JSON.parse(readFileSync(args.replay, 'utf8')) as ArmResult[]
    for (const arm of runs) printArm(arm)
    report(runs, { ...args, reps: Math.max(...runs.map(r => r.rep)) })
    return
  }

  const wanted = args.only ? [args.only] : ARMS
  for (const label of wanted) {
    const bin = args.bins[label]
    if (label === 'claudindev' && !existsSync(resolve(REPO_ROOT, 'dist/cli.mjs'))) {
      console.error('dist/cli.mjs missing — run `bun run build` first.')
      process.exit(1)
    }
    if (!Bun.which(bin) && !existsSync(bin)) {
      console.error(`${label}: ${bin} not found — pass --bin-${label}=… or --only=…`)
      process.exit(1)
    }
  }

  console.log(
    `\nthree-cli-ab — ${wanted.join(' vs ')}, same search→read→edit→build task` +
      `\n  model: ${args.model}   reps: ${args.reps}   workspace: fresh ${join(tmpdir(), 'three-cli-ab-*')}` +
      `\n  task:  15 .js files, 10 mention formatCurrency, 5 must change, build must go green`,
  )
  for (const label of wanted) console.log(`  ${label.padEnd(11)} ${args.bins[label]}`)

  const runs: ArmResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    // Rotate the 3-cycle so each arm pays the cold prompt cache in turn.
    const shift = (rep - 1) % ARMS.length
    const order = [...ARMS.slice(shift), ...ARMS.slice(0, shift)]
    let slot = 0
    for (const label of order) {
      if (args.only && args.only !== label) continue
      slot++
      const bin = args.bins[label]
      console.log(`\nrunning ${label} (${bin}) rep ${rep}/${args.reps}, slot ${slot}/${order.length} …`)
      const arm = runArm(label, bin, rep, slot, args)
      runs.push(arm)
      printArm(arm)
      printTimeline(arm, args.timelineRows)
    }
  }

  report(runs, args)

  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true })
    writeFileSync(args.json, JSON.stringify(runs, null, 2))
    console.log(`\njson → ${args.json}`)
  }
  console.log()
}

// Imported for its fixture by narration-updates-ab.ts; only run as a script.
if (import.meta.main) main()
