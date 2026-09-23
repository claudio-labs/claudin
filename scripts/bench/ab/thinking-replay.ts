#!/usr/bin/env bun
/**
 * Transplant replays: which part of a request makes the model think more.
 *
 * Takes the request with the most thinking from a session-cache-ab run
 * recorded through the proxy (`--proxy`, ideally `--proxy-display=summarized`
 * so the replays come back with summaries too), rebuilds it with one part
 * swapped or removed, and sends each version N times at the same decision
 * point — same history, same tools, same model and effort. Only the system
 * prompt and the first message's reminders are touched: swapping `tools` would
 * leave the history's tool calls pointing at tools that do not exist.
 *
 *   claudin body: control · cc-system (Claude Code's system prompt) ·
 *                 no-contract (without # Delivering work and # Corrections) ·
 *                 no-memory (without # Memory and # Scratchpad Directory) ·
 *                 no-reminders (without the skills, agent-type and git reminders) ·
 *                 cc-harness (Claude Code's # Harness in place of claudin's) ·
 *                 no-guidance (without # Session-specific guidance and # Context management)
 *   claude body:  control · claudin-system (claudin's system prompt)
 *
 * Credentials: each CLI makes one short call through the proxy (`-p` in an
 * empty directory); the proxy keeps that call's headers in memory and replays
 * the bodies with them (wire-proxy.ts `replay`). Nothing with a token is
 * written.
 *
 * Usage:
 *   bun scripts/bench/ab/thinking-replay.ts --run=<run dir> [--reps=8] [--concurrency=4] [--only=control,cc-system] [--tag=<name>] [--dry-run]
 *
 * `--dry-run` builds and writes every variant body and prints what changed,
 * with no API call. `--tag` writes to `<run dir>/replay-<tag>/` so a second
 * batch on the same run keeps the first one's results.
 *
 * Read the table's range verdict as the floor: a single request's thinking
 * varies ~2x between identical replays, so the report also prints an exact
 * permutation p-value on the mean against the control.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { REPO_ROOT } from '../../repoRoot'
import { proxyEnv, readProxyRecords, startWireProxy, type ProxyRecord, type WireProxy } from './wire-proxy'

type Json = Record<string, unknown>
type Side = 'claudin' | 'claude'
type Variant = { side: Side; name: string; build(base: Json, other: Json): Json }

const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/
const BINS: Record<Side, string> = { claudin: join(REPO_ROOT, 'bin', 'claudin'), claude: 'claude' }
const ARM_OF: Record<Side, string> = { claudin: 'claudindev', claude: 'claude' }
const CWD_RE = /Primary working directory: (\S+)/

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const blocksOf = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : [])
const textOf = (b: Json): string => (typeof b.text === 'string' ? b.text : '')

function parseArgs(argv: string[]) {
  const a = { run: '', reps: 8, concurrency: 4, only: null as string[] | null, dryRun: false, tag: '' }
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--run') a.run = v
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--concurrency') a.concurrency = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--dry-run') a.dryRun = true
    else if (k === '--tag') a.tag = v
    else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  if (!a.run) {
    console.error('usage: bun scripts/bench/ab/thinking-replay.ts --run=<run dir> [--reps=8] [--concurrency=4] [--only=a,b]')
    process.exit(2)
  }
  return a
}

// ---------------------------------------------------------------------------
// The request to replay: the main-thread request whose response thought most
// ---------------------------------------------------------------------------

type Pick = { label: string; record: ProxyRecord; body: Json }

function readBody(proxyDir: string, label: string, reqFile: string): Json {
  return JSON.parse(gunzipSync(readFileSync(join(proxyDir, label, reqFile))).toString('utf8')) as Json
}

function heaviest(proxyDir: string, arm: string): Pick {
  let best: Pick | null = null
  for (let rep = 1; rep <= 20; rep++) {
    for (const phase of [1, 2]) {
      const label = `${arm}-r${rep}.p${phase}`
      for (const record of readProxyRecords(proxyDir, label)) {
        if (!record.reqFile || record.status >= 400 || !record.response) continue
        if ((record.response.thinkingTokens ?? 0) <= (best?.record.response?.thinkingTokens ?? -1)) continue
        const body = readBody(proxyDir, label, record.reqFile)
        if (!Array.isArray(body.tools) || body.tools.length === 0) continue
        best = { label, record, body }
      }
    }
  }
  if (!best) throw new Error(`no recorded main-thread request for ${arm} under ${proxyDir}`)
  return best
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** The workspace path: claudin states it in the system prompt, Claude Code in a role:"system" message. */
function cwdOf(body: Json): string | null {
  const messageBlocks = (Array.isArray(body.messages) ? body.messages : []).flatMap(m =>
    isRecord(m) ? (Array.isArray(m.content) ? blocksOf(m.content) : [{ text: m.content }]) : [],
  )
  for (const b of [...blocksOf(body.system), ...messageBlocks]) {
    const m = CWD_RE.exec(textOf(b))
    if (m) return m[1]!
  }
  return null
}

/** The `# <title>` section of a system prompt, up to the next top-level heading. */
function sectionOf(body: Json, title: string): string | null {
  for (const b of blocksOf(body.system)) {
    const part = textOf(b)
      .split(/\n(?=# )/)
      .find(p => p.replace(/^\n*/, '').startsWith(`# ${title}\n`))
    if (part) return part.trim()
  }
  return null
}

/**
 * The other CLI's system blocks, with its workspace path swapped for this
 * body's. Claude Code keeps the working directory out of its system prompt (a
 * role:"system" message carries it), so a claudin body receiving that prompt
 * keeps its own `# Environment` section rather than losing where it is.
 */
function transplantSystem(base: Json, other: Json): Json {
  const from = cwdOf(other)
  const to = cwdOf(base)
  const system: Json[] = blocksOf(other.system).map(b => {
    const text = textOf(b)
    return from && to && text ? { ...b, text: text.split(from).join(to) } : b
  })
  const baseEnv = sectionOf(base, 'Environment')
  if (baseEnv && CWD_RE.test(baseEnv) && !system.some(b => CWD_RE.test(textOf(b)))) system.push({ type: 'text', text: baseEnv })
  return { ...base, system }
}

/** Drops the `# <title>` sections (up to the next top-level heading) from every system block. */
function withoutSections(base: Json, titles: string[]): Json {
  const system = blocksOf(base.system).map(b => {
    const text = textOf(b)
    if (!text) return b
    const parts = text.split(/\n(?=# )/)
    const kept = parts.filter(p => !titles.some(t => p.replace(/^\n*/, '').startsWith(`# ${t}\n`)))
    return kept.length === parts.length ? b : { ...b, text: kept.join('\n') }
  })
  return { ...base, system }
}

const REMINDER_MARKERS = [
  'The following skills are available for use with the Skill tool',
  'Available agent types for the Agent tool',
  '# Committing changes with git',
]

function withoutReminders(base: Json): Json {
  const messages = Array.isArray(base.messages) ? [...base.messages] : []
  const first = messages[0]
  if (!isRecord(first) || !Array.isArray(first.content)) return base
  const content = first.content.filter(c => !(isRecord(c) && REMINDER_MARKERS.some(m => textOf(c).includes(m))))
  messages[0] = { ...first, content }
  return { ...base, messages }
}

/** This body's `# <title>` section replaced by the other body's section of the same name. */
function withSectionFrom(base: Json, other: Json, title: string): Json {
  const replacement = sectionOf(other, title)
  if (!replacement) return base
  const system = blocksOf(base.system).map(b => {
    const text = textOf(b)
    if (!text) return b
    const parts = text.split(/\n(?=# )/)
    const i = parts.findIndex(p => p.replace(/^\n*/, '').startsWith(`# ${title}\n`))
    if (i < 0) return b
    parts[i] = `${replacement}\n`
    return { ...b, text: parts.join('\n') }
  })
  return { ...base, system }
}

const VARIANTS: Variant[] = [
  { side: 'claudin', name: 'control', build: b => b },
  { side: 'claudin', name: 'cc-system', build: transplantSystem },
  { side: 'claudin', name: 'no-contract', build: b => withoutSections(b, ['Delivering work', 'Corrections']) },
  { side: 'claudin', name: 'no-memory', build: b => withoutSections(b, ['Memory', 'Scratchpad Directory']) },
  { side: 'claudin', name: 'no-reminders', build: withoutReminders },
  { side: 'claudin', name: 'cc-harness', build: (b, o) => withSectionFrom(b, o, 'Harness') },
  { side: 'claudin', name: 'no-guidance', build: b => withoutSections(b, ['Session-specific guidance', 'Context management']) },
  { side: 'claude', name: 'control', build: b => b },
  { side: 'claude', name: 'claudin-system', build: transplantSystem },
]

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function cliEnv(url: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!HOST_ENV_RE.test(k)) env[k] = v
  return { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDIN_DISABLE_BACKGROUND_TASKS: '1', DISABLE_AUTOUPDATER: '1', ...proxyEnv(url) }
}

/** One short `-p` call per CLI through the proxy, so it holds that CLI's headers. */
function warmUp(proxy: WireProxy, side: Side, model: string, effort: string): Promise<void> {
  const label = `warm-${side}`
  const cwd = mkdtempSync(join(tmpdir(), `thinking-replay-${side}-`))
  const args = ['-p', 'Reply with the single word ok.', '--model', model, '--effort', effort, '--max-turns', '1', '--output-format', 'json', '--no-session-persistence']
  return new Promise((resolve, reject) => {
    const child = spawn(BINS[side], args, { cwd, env: cliEnv(proxy.url(label)), stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', code => {
      if (proxy.hasHeaders(label)) resolve()
      else reject(new Error(`${side} warm-up (exit ${code}) sent no /v1/messages request: ${err.slice(0, 300)}`))
    })
  })
}

type Sample = { variant: string; side: Side; rep: number; thinking: number; output: number; blocks: string[]; summary: string; cacheRead: number; cacheWrite: number }

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!)
    }),
  )
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)

/**
 * Two-sided permutation p-value on the difference of means, over 20k seeded
 * shuffles: how often a random split of the pooled samples is at least as far
 * apart as the real one.
 */
function permutationP(a: number[], b: number[]): number {
  const pooled = [...a, ...b]
  const observed = Math.abs(mean(a) - mean(b))
  let seed = 0x9e3779b9
  const rand = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  const rounds = 20_000
  let hits = 0
  for (let r = 0; r < rounds; r++) {
    for (let i = pooled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[pooled[i], pooled[j]] = [pooled[j]!, pooled[i]!]
    }
    if (Math.abs(mean(pooled.slice(0, a.length)) - mean(pooled.slice(a.length))) >= observed - 1e-9) hits++
  }
  return (hits + 1) / (rounds + 1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const proxyDir = join(args.run, 'proxy')
  const picks: Record<Side, Pick> = { claudin: heaviest(proxyDir, ARM_OF.claudin), claude: heaviest(proxyDir, ARM_OF.claude) }
  const outDir = join(args.run, args.tag ? `replay-${args.tag}` : 'replay')
  mkdirSync(outDir, { recursive: true })
  const variants = VARIANTS.filter(v => !args.only || args.only.includes(v.name))

  if (args.dryRun) {
    const size = (b: Json) => ({
      system: blocksOf(b.system).reduce((a, s) => a + textOf(s).length, 0),
      first: blocksOf(isRecord((b.messages as unknown[])?.[0]) ? ((b.messages as Json[])[0]!.content as unknown) : []).reduce((a, s) => a + textOf(s).length, 0),
      cwd: cwdOf(b),
    })
    for (const v of variants) {
      const base = picks[v.side].body
      const built = v.build(base, picks[v.side === 'claudin' ? 'claude' : 'claudin'].body)
      writeFileSync(join(outDir, `${v.side}-${v.name}.body.json`), JSON.stringify(built, null, 1))
      const [b, a] = [size(base), size(built)]
      const headings = blocksOf(built.system).flatMap(s => [...textOf(s).matchAll(/^# (.+)$/gm)].map(m => m[1]))
      console.log(`${v.side}/${v.name}: system ${b.system} → ${a.system} chars, messages[0] ${b.first} → ${a.first}, cwd ${a.cwd}; headings: ${headings.join(' | ')}`)
    }
    return
  }

  const proxy = await startWireProxy(join(outDir, 'proxy'))

  for (const side of ['claudin', 'claude'] as const) {
    const p = picks[side]
    console.log(`${side}: replaying ${p.label} #${p.record.n} (${p.record.response?.thinkingTokens} thinking tokens in the session)`)
    const body = p.body
    const effort = isRecord(body.output_config) ? String(body.output_config.effort ?? 'high') : 'high'
    if (variants.some(v => v.side === side)) await warmUp(proxy, side, String(body.model), effort)
  }

  const samples: Sample[] = []
  for (const v of variants) {
    const base = picks[v.side].body
    const other = picks[v.side === 'claudin' ? 'claude' : 'claudin'].body
    const body = v.build(base, other)
    writeFileSync(join(outDir, `${v.side}-${v.name}.body.json`), JSON.stringify(body, null, 1))
    const send = async (rep: number) => {
      const { record, thinkingText } = await proxy.replay(`warm-${v.side}`, `${v.side}-${v.name}`, body)
      const usage = record.response?.usage ?? {}
      samples.push({
        variant: v.name,
        side: v.side,
        rep,
        thinking: record.response?.thinkingTokens ?? 0,
        output: num(usage.output_tokens),
        blocks: record.response?.blocks ?? [],
        summary: thinkingText.trim(),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
      })
      console.log(`  ${v.side}/${v.name} #${rep}: thinking ${record.response?.thinkingTokens} out ${num(usage.output_tokens)} (cache r ${num(usage.cache_read_input_tokens)} w ${num(usage.cache_creation_input_tokens)})`)
    }
    // The first send writes this prefix to the cache; the rest read it.
    await send(1)
    await pool(Array.from({ length: args.reps - 1 }, (_, i) => i + 2), args.concurrency, send)
  }
  await proxy.close()

  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ picks: Object.fromEntries(Object.entries(picks).map(([k, p]) => [k, { label: p.label, n: p.record.n, thinking: p.record.response?.thinkingTokens }])), samples }, null, 1))

  const lines = [`# thinking-replay — ${args.run}`, '']
  for (const side of ['claudin', 'claude'] as const) {
    const p = picks[side]
    lines.push(`## ${side} body: ${p.label} #${p.record.n} (${p.record.response?.thinkingTokens} thinking tokens in the session)`, '')
    lines.push(
      '| variant | n | thinking median [min–max] | mean | output median | vs control (median, range) | permutation p (mean) |',
      '|---|---|---|---|---|---|---|',
    )
    const control = samples.filter(s => s.side === side && s.variant === 'control').map(s => s.thinking)
    for (const v of variants.filter(x => x.side === side)) {
      const t = samples.filter(s => s.side === side && s.variant === v.name)
      const th = t.map(s => s.thinking)
      if (!th.length) continue
      const vsControl = v.name !== 'control' && control.length > 0
      const verdict = vsControl
        ? `${(((median(th) - median(control)) / Math.max(1, median(control))) * 100).toFixed(0)}% ${Math.max(...th) < Math.min(...control) || Math.min(...th) > Math.max(...control) ? 'SEPARATED' : '(overlap)'}`
        : ''
      const p = vsControl ? permutationP(control, th).toFixed(3) : ''
      lines.push(
        `| ${v.name} | ${t.length} | ${median(th)} [${Math.min(...th)}–${Math.max(...th)}] | ${Math.round(mean(th))} | ${median(t.map(s => s.output))} | ${verdict} | ${p} |`,
      )
    }
    lines.push('')
    for (const v of variants.filter(x => x.side === side)) {
      const t = samples.filter(s => s.side === side && s.variant === v.name).sort((a, b) => a.thinking - b.thinking)
      const mid = t[Math.floor(t.length / 2)]
      if (!mid) continue
      lines.push(`### ${side} / ${v.name} — median sample (${mid.thinking} tokens → ${mid.blocks.join(', ')})`, '')
      lines.push(mid.summary ? mid.summary.split('\n').map(l => `> ${l}`).join('\n') : '> (no summary text)', '')
    }
  }
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'))
  console.log(`\nreport → ${join(outDir, 'report.md')}`)
}

await main()
