// Characterization of what every `tengu_*` gate key RESOLVES TO in a stock
// install, for the dead-code cleanup.
//
// Two things make this necessary and neither is obvious:
//
//   1. `src/platform/analytics/growthbook.ts` — 986 lines of GrowthBook client —
//      never runs. `scripts/build/no-telemetry-plugin.ts` replaces the whole
//      module with a ~200-line stub whose resolution order is
//      `~/.claudin/feature-flags.json` > `_openBuildDefaults` > the call site's
//      `defaultValue`. The cleanup collapses the dead client into a real module
//      with the stub's semantics, and this table is the proof that the collapse
//      changed nothing: every surviving key must resolve to the same value
//      before and after, with no expectation edited by hand.
//
//   2. A key's `defaultValue` is written at the CALL SITE, not centrally, and
//      several keys are read at more than one site with different defaults
//      (upstream lets the server unify them; here there is no server, so the
//      sites genuinely disagree). A table keyed only by name would hide that.
//
// The default expressions are read as source text and only evaluated when they
// are literals. A key whose default is a computed expression is recorded with
// its source instead of a resolved value — honest about what was not measured,
// rather than silently resolving it to undefined.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

const GATE_FNS = [
  'getFeatureValue_CACHED_MAY_BE_STALE',
  'getFeatureValue_CACHED_WITH_REFRESH',
  'getFeatureValue_DEPRECATED',
  'checkStatsigFeatureGate_CACHED_MAY_BE_STALE',
  'checkGate_CACHED_OR_BLOCKING',
  'getDynamicConfig_CACHED_MAY_BE_STALE',
  'getDynamicConfig_BLOCKS_ON_INIT',
] as const

const CALL_RE = new RegExp(`\\b(${GATE_FNS.join('|')})\\(\\s*(['"\`])(tengu[A-Za-z0-9_]*)\\2`, 'g')

type GateSite = {
  key: string
  fn: string
  /** Source text of the second argument, or `''` for a single-argument gate. */
  defaultSource: string
  file: string
}

/**
 * Source text of the call's SECOND argument — the `defaultValue` — found by
 * balancing brackets from the key's closing quote and splitting at the first
 * comma that sits at depth zero.
 *
 * A regex cannot do this. Several defaults are object or call expressions with
 * commas and parens of their own (`{ enable_startup_dialog: false }`,
 * `ALL_MODEL_CONFIGS.opus46.firstParty`), and taking everything up to the next
 * comma would truncate them into something that parses as a different literal.
 */
function readDefaultArg(source: string, afterKey: number): string {
  let depth = 1
  let i = afterKey
  // Skip to just past the comma that ends the key argument.
  for (; i < source.length; i++) {
    const c = source[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return '' // single-argument gate
    } else if (c === ',' && depth === 1) {
      i++
      break
    }
  }

  const start = i
  for (; i < source.length; i++) {
    const c = source[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) break
    } else if (c === ',' && depth === 1) break
  }
  // Collapse the whitespace of a multi-line default so the table stays
  // readable, and drop a trailing comma from a call written with one.
  return source.slice(start, i).replace(/\s+/g, ' ').replace(/,$/, '').trim()
}

function scanGateSites(): GateSite[] {
  const out: GateSite[] = []

  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === '__fixtures__' || ent.name === '__snapshots__') continue
        walk(join(dir, ent.name))
        continue
      }
      if (!/\.tsx?$/.test(ent.name) || /\.test\.tsx?$/.test(ent.name)) continue
      const full = join(dir, ent.name)
      const source = readFileSync(full, 'utf8')
      if (!source.includes('tengu')) continue

      CALL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CALL_RE.exec(source)) !== null) {
        out.push({
          key: m[3]!,
          fn: m[1]!,
          defaultSource: readDefaultArg(source, m.index + m[0].length),
          file: relative(REPO_ROOT, full),
        })
      }
    }
  }

  walk(join(REPO_ROOT, 'src'))
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file))
}

/** Parse a default that is a plain literal. Anything else is left unmeasured. */
function literalDefault(source: string): { value: unknown } | null {
  const t = source.trim()
  if (t === '') return { value: undefined }
  if (t === 'true') return { value: true }
  if (t === 'false') return { value: false }
  if (t === 'null') return { value: null }
  if (t === 'undefined') return { value: undefined }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t) }
  if (/^'[^']*'$/.test(t) || /^"[^"]*"$/.test(t)) return { value: t.slice(1, -1) }
  if (t === '{}') return { value: {} }
  if (t === '[]') return { value: [] }
  return null
}

// ── The stub under test, extracted the same way the sibling suite does ──────

const pluginSource = readFileSync(join(REPO_ROOT, 'scripts/build/no-telemetry-plugin.ts'), 'utf-8')
const stubMatch = pluginSource.match(/'src\/platform\/analytics\/growthbook': `([\s\S]*?)`/)
if (!stubMatch) throw new Error('Could not extract growthbook stub from no-telemetry-plugin.ts')

const testDir = join(tmpdir(), `flag-resolution-test-${process.pid}`)
const stubFile = join(testDir, 'growthbook-stub.mjs')
const flagsFile = join(testDir, 'test-flags.json')
mkdirSync(testDir, { recursive: true })
writeFileSync(stubFile, stubMatch[1]!)
process.env.CLAUDE_FEATURE_FLAGS_FILE = flagsFile
const stub = await import(stubFile)

type Resolution = {
  fn: string
  defaults: string[]
  sites: number
  /** What a stock install gets, or a note naming why it was not measured. */
  stockValue: unknown
}

function resolveTable(): Record<string, Resolution> {
  const byKey = new Map<string, GateSite[]>()
  for (const site of scanGateSites()) {
    const list = byKey.get(site.key) ?? []
    list.push(site)
    byKey.set(site.key, list)
  }

  const out: Record<string, Resolution> = {}
  for (const key of [...byKey.keys()].sort()) {
    const sites = byKey.get(key)!
    const defaults = [...new Set(sites.map(s => s.defaultSource))].sort()
    const first = literalDefault(sites[0]!.defaultSource)

    stub.resetGrowthBook()
    const stockValue =
      first === null
        ? `<unmeasured: default is an expression — ${sites[0]!.defaultSource.slice(0, 60)}>`
        : sites[0]!.fn.startsWith('checkGate') || sites[0]!.fn.startsWith('checkStatsig')
          ? stub.checkStatsigFeatureGate_CACHED_MAY_BE_STALE(key)
          : stub.getFeatureValue_CACHED_MAY_BE_STALE(key, first.value)

    out[key] = {
      fn: [...new Set(sites.map(s => s.fn))].sort().join(' | '),
      defaults,
      sites: sites.length,
      stockValue,
    }
  }
  return out
}

describe('tengu gate keys — resolution in a stock install', () => {
  beforeEach(() => {
    stub.resetGrowthBook()
    try {
      unlinkSync(flagsFile)
    } catch {
      /* may not exist */
    }
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env.CLAUDE_FEATURE_FLAGS_FILE
  })

  test('the scan found the gate sites', () => {
    // A regex that matches nothing snapshots an empty object and guards
    // nothing — which is the whole failure mode this cleanup must not have.
    const sites = scanGateSites()
    expect(sites.length).toBeGreaterThan(100)
    expect(new Set(sites.map(s => s.key)).size).toBeGreaterThan(80)
  })

  test('the per-key resolution table matches the snapshot', () => {
    expect(resolveTable()).toMatchSnapshot()
  })

  test('the five open-build overrides beat their call-site defaults', () => {
    // The control for the method: these are the keys the fork deliberately
    // flips in `_openBuildDefaults`, so a table that reported the call-site
    // default for them would prove the resolution path was not exercised.
    const table = resolveTable()
    expect(table['tengu_passport_quail']?.stockValue).toBe(true)
    expect(table['tengu_coral_fern']?.stockValue).toBe(true)
    expect(table['tengu_bramble_lintel']?.stockValue).toBe(15)
    expect(table['tengu_glacier_2xr']?.stockValue).toBe(true)
  })

  test('a user flags file overrides everything in the table', () => {
    writeFileSync(flagsFile, JSON.stringify({ tengu_passport_quail: false }))
    stub.resetGrowthBook()
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', true)).toBe(false)
  })
})
