#!/usr/bin/env bun
// Skills + plugins memory bench.
//
// Skills, plugins, agents, and commands are all loaded as markdown files
// (frontmatter + body) at startup or lazily, and retained for the process
// lifetime. We don't have a hard cap on how many can be installed — a user
// with a heavy plugin marketplace setup could pull in hundreds. This bench
// measures the per-skill memory footprint after parse + retention.
//
// Two modes:
//   default   → uses the real loadSkillsFromSkillsDir path (with mock.module
//               for heavy upstream deps) against a synthetic fixture
//               directory of N skills.
//   raw       → just parses frontmatter + reads markdown content into a
//               plain array, isolating the parse/retain cost from the
//               real loader's overhead (dedup, file identity, walk).
//
// Usage:
//   bun --expose-gc run scripts/profile/skills-plugin-bench.ts
//   bun --expose-gc run scripts/profile/skills-plugin-bench.ts --skills=500 --body-kb=8 --mode=raw

import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

type Mode = 'default' | 'raw' | 'both'

type Args = {
  skills: number
  bodyKb: number
  mode: Mode
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    skills: 200,
    bodyKb: 4,
    mode: 'both',
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--skills=')) args.skills = Number(a.slice(9)) || args.skills
    else if (a.startsWith('--body-kb=')) args.bodyKb = Number(a.slice(10)) || args.bodyKb
    else if (a.startsWith('--mode=')) args.mode = a.slice(7) as Mode
  }
  return args
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type Snap = { heap: number; rss: number; ext: number }

function snap(): Snap {
  const m = process.memoryUsage()
  return { heap: m.heapUsed, rss: m.rss, ext: m.external }
}

function diff(a: Snap, b: Snap): { heap: number; rss: number; ext: number } {
  return { heap: b.heap - a.heap, rss: b.rss - a.rss, ext: b.ext - a.ext }
}

// Build N skill fixture files. Each is a SKILL.md inside its own dir.
function makeFixture(root: string, n: number, bodyKb: number): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const bodyBase = 'A'.repeat(bodyKb * 1024 - 80)
  for (let i = 0; i < n; i++) {
    const skillDir = join(root, `skill-${i}`)
    mkdirSync(skillDir)
    const content = `---
name: skill-${i}
description: Synthetic skill ${i} for memory benchmarking.
allowed-tools:
  - Read
  - Bash
---

# Skill ${i}

${bodyBase}
${i}-body-marker
`
    writeFileSync(join(skillDir, 'SKILL.md'), content)
  }
}

// ---- Mode: raw (parse + retain) ----
async function runRaw(skills: number, bodyKb: number) {
  const root = join(tmpdir(), `claudio-skills-bench-raw-${process.pid}`)
  makeFixture(root, skills, bodyKb)

  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const before = snap()
  const t0 = performance.now()

  // Reproduce the minimum loader path: read + naive frontmatter split.
  const { readFileSync, readdirSync } = await import('node:fs')
  const retained: Array<{ name: string; meta: Record<string, string>; body: string }> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'SKILL.md')
    const raw = readFileSync(path, 'utf8')
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!m) continue
    const meta: Record<string, string> = {}
    for (const line of m[1]!.split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    retained.push({ name: entry.name, meta, body: m[2]! })
  }

  const wallMs = performance.now() - t0
  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const after = snap()
  const d = diff(before, after)

  rmSync(root, { recursive: true, force: true })

  return { wallMs, retained: retained.length, before, after, delta: d }
}

// ---- Mode: default (real loader) ----
async function runReal(skills: number, bodyKb: number) {
  // Mock heavy deps so we don't pull analytics/growthbook/etc.
  const { mock } = await import('bun:test')
  mock.module('../../src/services/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: () => false,
    getFeatureValue_CACHED_WITH_REFRESH: () => false,
    getFeatureValue_DEPRECATED: async () => false,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
    checkGate_CACHED_OR_BLOCKING: async () => false,
    checkSecurityRestrictionGate: async () => false,
    hasGrowthBookEnvOverride: () => false,
    getApiBaseUrlHost: () => undefined,
    onGrowthBookRefresh: () => () => {},
    refreshGrowthBookAfterAuthChange: () => {},
    resetGrowthBook: () => {},
    refreshGrowthBookFeatures: async () => {},
    setupPeriodicGrowthBookRefresh: () => {},
    stopPeriodicGrowthBookRefresh: () => {},
    getDynamicConfig_BLOCKS_ON_INIT: async () => ({}),
    getDynamicConfig_CACHED_MAY_BE_STALE: () => ({}),
    initializeGrowthBook: async () => null,
    getAllGrowthBookFeatures: () => ({}),
  }))
  mock.module('../../src/services/analytics/index.js', () => ({
    logEvent: () => {},
    logEventAsync: async () => {},
    attachAnalyticsSink: () => {},
    stripProtoFields: <V,>(v: V) => v,
    _resetForTesting: () => {},
  }))

  const root = join(tmpdir(), `claudio-skills-bench-real-${process.pid}`)
  makeFixture(root, skills, bodyKb)

  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const before = snap()
  const t0 = performance.now()

  // Use the real frontmatterParser (same one loadSkillsFromSkillsDir uses).
  const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.js')
  const { readFileSync, readdirSync } = await import('node:fs')
  // biome-ignore lint/suspicious/noExplicitAny: dynamic shape
  const retained: any[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'SKILL.md')
    const raw = readFileSync(path, 'utf8')
    const parsed = parseFrontmatter(raw)
    retained.push({
      name: entry.name,
      data: parsed.frontmatter,
      content: parsed.content,
      filePath: path,
    })
  }

  const wallMs = performance.now() - t0
  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const after = snap()
  const d = diff(before, after)

  rmSync(root, { recursive: true, force: true })

  return { wallMs, retained: retained.length, before, after, delta: d }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: bun --expose-gc run scripts/profile/skills-plugin-bench.ts [options]

Options:
  --skills=N      number of synthetic skills to load (default 200)
  --body-kb=N     size of each SKILL.md body in KB (default 4)
  --mode=raw|default|both    parse strategy (default: both)
  --json          emit JSON
  --help          this message
`)
    return
  }

  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  console.log(`Skills/plugin load bench`)
  console.log(`  ${args.skills} skills × ${args.bodyKb} KB body each (~${fmtBytes(args.skills * args.bodyKb * 1024)} on disk)`)
  console.log('')

  const results: Record<string, Awaited<ReturnType<typeof runRaw>>> = {}

  if (args.mode === 'raw' || args.mode === 'both') {
    results.raw = await runRaw(args.skills, args.bodyKb)
  }
  if (args.mode === 'default' || args.mode === 'both') {
    results.real = await runReal(args.skills, args.bodyKb)
  }

  if (args.json) {
    console.log(JSON.stringify({ args, results }, null, 2))
    return
  }

  console.log('mode    skills    wall      heap Δ      RSS Δ       ext Δ      per-skill heap')
  for (const [name, r] of Object.entries(results)) {
    const perSkill = r.delta.heap / Math.max(1, r.retained)
    console.log(
      `${name.padEnd(7)} ${String(r.retained).padStart(5)}  ${`${r.wallMs.toFixed(1)}ms`.padStart(8)}  ${fmtBytes(r.delta.heap).padStart(9)}  ${fmtBytes(r.delta.rss).padStart(9)}  ${fmtBytes(r.delta.ext).padStart(9)}  ${fmtBytes(perSkill).padStart(11)}`,
    )
  }

  console.log('')
  if (results.real && results.raw) {
    const wallOverhead = results.real.wallMs - results.raw.wallMs
    const rssOverhead = results.real.delta.rss - results.raw.delta.rss
    console.log(`parseFrontmatter (YAML) vs raw split:`)
    console.log(`  wall: +${wallOverhead.toFixed(1)}ms (${((wallOverhead / results.raw.wallMs) * 100).toFixed(0)}% slower)`)
    console.log(`  RSS:  ${rssOverhead >= 0 ? '+' : ''}${fmtBytes(rssOverhead)}`)
    console.log('')
    console.log(`Note: heap delta is volatile (GC noise dominates at this scale).`)
    console.log(`RSS delta is the more reliable signal for retained cost.`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
