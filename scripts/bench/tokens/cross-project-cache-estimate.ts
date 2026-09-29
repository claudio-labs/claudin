#!/usr/bin/env bun
/**
 * Cross-project cache estimate: what moving the environment block out of the
 * system prompt would save on the main thread (team memory
 * `claude-code-2.1.284-wire-diff`, item 2).
 *
 *   bun scripts/bench/tokens/cross-project-cache-estimate.ts --since=YYYY-MM-DD
 *       [--static-prefix=14000] [--projects=<slug>]
 *
 * Today the system prompt carries the working directory, so two sessions share
 * its cached prefix only when they run in the same directory. Claude Code keeps
 * the system prompt static and sends the environment as a later message; then
 * every session on the same model reads the tools and the system prompt that
 * any other session wrote within the TTL. That is the whole saving, so this
 * counts the requests where it would have applied:
 *
 *   a cold start — a session's first request, or its first after an hour's
 *   gap (the main thread's 1h TTL) — that wrote cache instead of reading the
 *   static prefix, while a session in ANOTHER directory on the same model had
 *   made a request within the previous hour.
 *
 * Each such start saves min(written, static prefix) tokens at the difference
 * between a 1h write (x2) and a read (x0.1). The spend it is compared against
 * is every main-thread request in the window at list-price ratios (uncached
 * input x1, read x0.1, 1h write x2, 5m write x1.25, output x5). The static
 * prefix defaults to the tools plus system prompt a first request read on
 * 2026-09-29 (14,389 tokens) less its ~300-token environment block.
 *
 * Main-thread transcripts only, the bench's `-tmp-*` projects skipped.
 * Transcripts are DATA: only aggregates are printed.
 */
import { readFileSync } from 'fs'
import { basename } from 'path'
import { pct, projectDirs, transcriptFiles, type Block } from './transcriptCorpus.js'

const USAGE = 'usage: bun scripts/bench/tokens/cross-project-cache-estimate.ts --since=YYYY-MM-DD [--static-prefix=N] [--projects=<slug>]'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BENCH_PROJECT_RE = /^-tmp-/
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_STATIC_PREFIX = 14_000
const PRICE = { input: 1, read: 0.1, write1h: 2, write5m: 1.25, output: 5 }

type Request = { at: number; cwd: string; model: string; input: number; read: number; write1h: number; write5m: number; output: number }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function costOf(r: Request): number {
  return r.input * PRICE.input + r.read * PRICE.read + r.write1h * PRICE.write1h + r.write5m * PRICE.write5m + r.output * PRICE.output
}

/** One request per assistant message id, usage at its largest across the message's entries. */
export function parseRequests(raw: string): Request[] {
  const byId = new Map<string, Request>()
  for (const line of raw.split('\n')) {
    if (!line) continue
    let r: Block
    try {
      r = JSON.parse(line) as Block
    } catch {
      continue
    }
    if (r.type !== 'assistant' || r.isSidechain === true) continue
    const m = r.message as Block | undefined
    if (!m || typeof m.id !== 'string' || typeof m.model !== 'string' || m.model === '<synthetic>') continue
    const at = Date.parse(String(r.timestamp ?? ''))
    if (Number.isNaN(at)) continue
    const u = (m.usage ?? {}) as Block
    const split = (u.cache_creation ?? {}) as Block
    const w1h = num(split.ephemeral_1h_input_tokens)
    const w5m = num(split.ephemeral_5m_input_tokens)
    const prev = byId.get(m.id)
    const next: Request = {
      at: prev?.at ?? at,
      cwd: String(r.cwd ?? ''),
      model: m.model,
      input: Math.max(prev?.input ?? 0, num(u.input_tokens)),
      read: Math.max(prev?.read ?? 0, num(u.cache_read_input_tokens)),
      // Without the split, a write is priced as 1h: the main thread's TTL.
      write1h: Math.max(prev?.write1h ?? 0, w1h + w5m > 0 ? w1h : num(u.cache_creation_input_tokens)),
      write5m: Math.max(prev?.write5m ?? 0, w5m),
      output: Math.max(prev?.output ?? 0, num(u.output_tokens)),
    }
    byId.set(m.id, next)
  }
  return [...byId.values()].sort((a, b) => a.at - b.at)
}

type Estimate = { starts: number; coldStarts: number; savedStarts: number; savedUnits: number; spendUnits: number }

export function estimate(sessions: readonly Request[][], staticPrefix: number): Estimate {
  const all = sessions.flat().sort((a, b) => a.at - b.at)
  const out: Estimate = { starts: 0, coldStarts: 0, savedStarts: 0, savedUnits: 0, spendUnits: 0 }
  for (const r of all) out.spendUnits += costOf(r)
  for (const reqs of sessions) {
    reqs.forEach((r, i) => {
      if (i > 0 && r.at - reqs[i - 1].at < HOUR_MS) return
      out.starts++
      // It read the static prefix already (a same-directory session wrote it).
      if (r.read >= staticPrefix) return
      out.coldStarts++
      const other = all.some(o => o.model === r.model && o.cwd !== r.cwd && o.at < r.at && r.at - o.at < HOUR_MS)
      if (!other) return
      const written = r.write1h + r.write5m
      if (written <= 0) return
      out.savedStarts++
      out.savedUnits += Math.min(written, staticPrefix) * (PRICE.write1h - PRICE.read)
    })
  }
  return out
}

function main(): void {
  const argv = process.argv.slice(2)
  const get = (k: string): string | null => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
  const since = get('since') ?? ''
  if (!DATE_RE.test(since) || argv.some(a => !['--since=', '--static-prefix=', '--projects='].some(p => a.startsWith(p)))) {
    console.error(USAGE)
    process.exit(2)
  }
  const staticPrefix = Number(get('static-prefix') ?? DEFAULT_STATIC_PREFIX)
  const sinceMs = Date.parse(`${since}T00:00:00`)
  const dirs = projectDirs(get('projects')).filter(d => !BENCH_PROJECT_RE.test(basename(d)))
  const sessions: Request[][] = []
  for (const f of transcriptFiles(dirs).filter(t => !t.isSubagent && t.mtimeMs >= sinceMs)) {
    let raw: string
    try {
      raw = readFileSync(f.path, 'utf8')
    } catch {
      continue
    }
    const reqs = parseRequests(raw).filter(r => r.at >= sinceMs)
    if (reqs.length > 0) sessions.push(reqs)
  }
  const e = estimate(sessions, staticPrefix)
  console.log(`Cross-project cache estimate since ${since}: ${sessions.length} main-thread sessions, static prefix ${staticPrefix.toLocaleString('en-US')} tokens`)
  console.log(`  starts (first request or after a 1h gap): ${e.starts}`)
  console.log(`  cold starts (read less than the static prefix): ${e.coldStarts}`)
  console.log(`  of those, another directory on the same model was active within 1h: ${e.savedStarts}`)
  console.log(`  saving: ${Math.round(e.savedUnits).toLocaleString('en-US')} units of ${Math.round(e.spendUnits).toLocaleString('en-US')} spent = ${pct(e.savedUnits, e.spendUnits)}`)
}

if (import.meta.main) main()
