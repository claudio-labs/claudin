/**
 * Census of every `tengu*` occurrence in the tree, bucketed by the ROLE the
 * occurrence plays. Written for the dead-code cleanup, kept afterwards as the
 * regression check that the vocabulary does not creep back in.
 *
 * The whole point is that `tengu_` is not one thing. It plays five different
 * roles and only some of them are dead:
 *
 *   event        1st argument of logEvent/logEventAsync. The destination is an
 *                empty function (scripts/build/no-telemetry-plugin.ts stubs
 *                src/platform/analytics/index), so these are pure dead weight.
 *                `scripts/build/build.ts` blanks them in the bundle for exactly
 *                that reason.
 *   gate         argument of one of the GATE_FNS below — getFeatureValue,
 *                checkStatsigFeatureGate, checkGate, getDynamicConfig and
 *                friends.
 *                This is the key a user writes in ~/.claudin/feature-flags.json,
 *                so blanking one would silently change which default a gate
 *                resolves to. LIVE — but see docs/tech/tengu-census/gate-audit.md:
 *                a key being live is not the same as the branch it opens
 *                working in this fork.
 *   indirect     a tengu_ name reached some other way — assigned to a const, put
 *                in an array, used as an object key, written into a regex. The
 *                build's rewrite deliberately leaves these alone because it
 *                cannot tell an event constant from a gate constant. They need
 *                human eyes.
 *   doc          inside a comment, or in a .md file. Documentation, not code.
 *   unclassified the scanner could not place the occurrence at all. Must stay at
 *                ZERO — a non-zero count means this script has a blind spot, not
 *                that the tree has an exotic usage.
 *
 * Usage:
 *   bun run scripts/verify/tengu-census.ts            # report
 *   bun run scripts/verify/tengu-census.ts --json     # machine-readable
 *   bun run scripts/verify/tengu-census.ts --gates    # just the gate work list
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../repoRoot'

export type Bucket = 'event' | 'gate' | 'indirect' | 'doc' | 'unclassified'

/** Where the occurrence physically sits. Sub-divides the `indirect` bucket. */
export type OccurrenceRegion = 'code' | 'comment' | 'string' | 'regex' | 'markdown'

export type Occurrence = {
  bucket: Bucket
  region: OccurrenceRegion
  /**
   * True for a test file or a `__fixtures__` asset. Such an occurrence is real
   * (it is counted) but it is not a call site anyone ships, so it stays out of
   * the gate work list — otherwise a test's own `tengu_gate_one` fixture shows
   * up as a key to audit.
   */
  fixture: boolean
  /** Repo-relative path. */
  file: string
  line: number
  /** The matched token, e.g. `tengu_passport_quail`. */
  token: string
  /** Trimmed source line, for the report. */
  text: string
}

const SCAN_ROOTS = ['src', 'scripts', 'docs', '.claudin/rules'] as const
const SCAN_FILES = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md'] as const
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__snapshots__'])
const SCAN_EXTS = /\.(ts|tsx|js|mjs|cjs|json|md|txt)$/

const TOKEN_RE = /tengu[A-Za-z0-9_]*/g

// Same shape the build uses (scripts/build/build.ts), so the two agree on what
// an event name is. Backticks are in the quote class because a few call sites
// use a template literal with no interpolation; \2 pins the closing quote to
// the opening one so a mixed pair never matches.
const EVENT_RE = /\blogEvent(?:Async)?\(\s*(['"`])tengu[A-Za-z0-9_]*\1/g

const GATE_FNS = [
  'getFeatureValue_CACHED_MAY_BE_STALE',
  'getFeatureValue_CACHED_WITH_REFRESH',
  'getFeatureValue_DEPRECATED',
  'checkStatsigFeatureGate_CACHED_MAY_BE_STALE',
  'checkGate_CACHED_OR_BLOCKING',
  'checkSecurityRestrictionGate',
  'getDynamicConfig_CACHED_MAY_BE_STALE',
  'getDynamicConfig_BLOCKS_ON_INIT',
  'hasGrowthBookEnvOverride',
] as const

/**
 * An optional generic type argument between the gate function's name and its
 * paren — `getFeatureValue_CACHED_MAY_BE_STALE<Partial<Config> | null>(…)`.
 *
 * Leaving this out is not a miss in the TOTAL: the key still lands in the
 * `indirect` bucket as a bare string literal. It is a miss in the BUCKET, which
 * is worse, because `--gates` is the work list for the gate audit and those
 * keys never appeared on it. One nested level is enough for every call in this
 * tree; anything deeper stays `indirect` and shows up for review.
 */
const GENERIC_ARG = '(?:\\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>)?'

const GATE_RE = new RegExp(
  `\\b(?:${GATE_FNS.join('|')})${GENERIC_ARG}\\(\\s*(['"\`])tengu[A-Za-z0-9_]*\\1`,
  'g',
)

export const REGION_CODE = 0
export const REGION_COMMENT = 1
export const REGION_STRING = 2
export const REGION_REGEX = 3

// What may precede a `/` that opens a regex literal. Anything else means
// division. Standard heuristic — a full parse is not worth it here, and the
// only cost of a miss is one occurrence landing in `unclassified`, which the
// report shouts about rather than hiding.
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%',
  '<', '>', '~', '^', '\n',
])

function opensRegex(source: string, slashAt: number): boolean {
  for (let j = slashAt - 1; j >= 0; j--) {
    const c = source[j]!
    if (c === ' ' || c === '\t' || c === '\r') continue
    if (REGEX_PRECEDERS.has(c)) return true
    // `return /re/`, `typeof /re/` and friends.
    return /[A-Za-z]/.test(c) && /\b(return|typeof|case|in|of|do|else|yield|await)$/.test(source.slice(Math.max(0, j - 7), j + 1))
  }
  return true
}

/**
 * Classify every character of a source file as code / comment / string / regex.
 *
 * A regex cannot answer "is this occurrence inside a comment?" without this,
 * and the answer decides two of the five buckets. Markdown has no code/comment
 * distinction, so it is reported as one comment region by the caller.
 */
export function scanRegions(source: string): Uint8Array {
  const out = new Uint8Array(source.length)

  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = REGION_COMMENT
      continue
    }
    if (c === '/' && next === '*') {
      out[i++] = REGION_COMMENT
      out[i++] = REGION_COMMENT
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out[i++] = REGION_COMMENT
      }
      if (i < source.length) {
        out[i++] = REGION_COMMENT
        out[i++] = REGION_COMMENT
      }
      continue
    }
    if (c === '/' && opensRegex(source, i)) {
      out[i++] = REGION_REGEX
      let inClass = false
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          out[i++] = REGION_REGEX
          if (i < source.length) out[i++] = REGION_REGEX
          continue
        }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        const done = source[i] === '/' && !inClass
        out[i++] = REGION_REGEX
        if (done) break
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out[i++] = REGION_STRING
      while (i < source.length) {
        if (source[i] === '\\') {
          out[i++] = REGION_STRING
          if (i < source.length) out[i++] = REGION_STRING
          continue
        }
        const done = source[i] === quote
        // An unterminated quote (an apostrophe in prose) must not swallow the
        // rest of the file: a single/double quote never spans a newline.
        const bail = source[i] === '\n' && quote !== '`'
        out[i++] = REGION_STRING
        if (done || bail) break
      }
      continue
    }

    out[i++] = REGION_CODE
  }
  return out
}

function collectFiles(): string[] {
  const out: string[] = []

  function walk(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(join(dir, ent.name))
      } else if (SCAN_EXTS.test(ent.name)) {
        out.push(join(dir, ent.name))
      }
    }
  }

  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root))
  for (const file of SCAN_FILES) {
    const full = join(REPO_ROOT, file)
    try {
      if (statSync(full).isFile()) out.push(full)
    } catch {
      // Optional file, absent in a partial checkout.
    }
  }
  return out.sort()
}

/** Byte offset → 1-indexed line number, via a prefix scan done once per file. */
function lineIndex(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Offsets consumed by a regex, as a sorted list of [start, end) ranges. */
function matchRanges(source: string, re: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
    if (m[0].length === 0) re.lastIndex++
  }
  return ranges
}

function inRanges(ranges: Array<[number, number]>, offset: number): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true
    if (start > offset) return false
  }
  return false
}

export function censusFile(path: string, source: string): Occurrence[] {
  const file = relative(REPO_ROOT, path)
  const isMarkdown = /\.(md|txt)$/.test(path)
  const isData = /\.json$/.test(path)
  const fixture = /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes('__fixtures__')
  const starts = lineIndex(source)
  const regions = isMarkdown ? null : scanRegions(source)
  const eventRanges = matchRanges(source, EVENT_RE)
  const gateRanges = matchRanges(source, GATE_RE)
  const lines = source.split('\n')

  const out: Occurrence[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(source)) !== null) {
    const offset = m.index
    const line = lineAt(starts, offset)
    const base = {
      fixture,
      file,
      line,
      token: m[0],
      text: (lines[line - 1] ?? '').trim().slice(0, 200),
    }

    let region: OccurrenceRegion
    if (isMarkdown) region = 'markdown'
    else if (isData) region = 'string'
    else {
      switch (regions?.[offset]) {
        case REGION_COMMENT: region = 'comment'; break
        case REGION_STRING: region = 'string'; break
        case REGION_REGEX: region = 'regex'; break
        case REGION_CODE: region = 'code'; break
        default: region = 'code'
      }
    }

    let bucket: Bucket
    if (region === 'markdown' || region === 'comment') {
      bucket = 'doc'
    } else if (inRanges(eventRanges, offset)) {
      bucket = 'event'
    } else if (inRanges(gateRanges, offset)) {
      bucket = 'gate'
    } else if (region === 'string' || region === 'regex' || region === 'code') {
      // A bare literal, a regex pattern, an object key, a value in a .json
      // fixture: reached some way the two call-shape regexes cannot see.
      bucket = 'indirect'
    } else {
      bucket = 'unclassified'
    }
    out.push({ bucket, region, ...base })
  }
  return out
}

export function runCensus(): Occurrence[] {
  const out: Occurrence[] = []
  for (const path of collectFiles()) {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!source.includes('tengu')) continue
    out.push(...censusFile(path, source))
  }
  return out
}

function report(occurrences: Occurrence[], mode: 'full' | 'gates'): void {
  const byBucket = new Map<Bucket, Occurrence[]>()
  for (const occ of occurrences) {
    const list = byBucket.get(occ.bucket) ?? []
    list.push(occ)
    byBucket.set(occ.bucket, list)
  }

  const gates = (byBucket.get('gate') ?? []).filter(o => !o.fixture)
  const gateKeys = new Map<string, Occurrence[]>()
  for (const occ of gates) {
    const list = gateKeys.get(occ.token) ?? []
    list.push(occ)
    gateKeys.set(occ.token, list)
  }

  if (mode === 'gates') {
    console.log(`${gateKeys.size} distinct gate keys across ${gates.length} sites\n`)
    for (const key of [...gateKeys.keys()].sort()) {
      const sites = gateKeys.get(key)!
      console.log(`${key}  (${sites.length})`)
      for (const site of sites) console.log(`    ${site.file}:${site.line}`)
    }
    return
  }

  const order: Bucket[] = ['event', 'gate', 'indirect', 'doc', 'unclassified']
  const files = new Set(occurrences.map(o => o.file))
  console.log(`tengu census — ${occurrences.length} occurrences across ${files.size} files\n`)
  for (const bucket of order) {
    const list = byBucket.get(bucket) ?? []
    const n = new Set(list.map(o => o.file)).size
    console.log(`  ${bucket.padEnd(13)} ${String(list.length).padStart(5)}  (${n} files)`)
  }
  console.log('')
  console.log(`  distinct gate keys: ${gateKeys.size} (test fixtures excluded)`)

  const unclassified = byBucket.get('unclassified') ?? []
  if (unclassified.length > 0) {
    console.log('\n  UNCLASSIFIED — the scanner has a blind spot, fix it:')
    for (const occ of unclassified.slice(0, 40)) {
      console.log(`    ${occ.file}:${occ.line}  ${occ.text}`)
    }
  }

  const indirect = byBucket.get('indirect') ?? []
  if (indirect.length > 0) {
    console.log('\n  INDIRECT — a tengu_ name the call-shape regexes cannot see:')
    const byRegion = new Map<OccurrenceRegion, Occurrence[]>()
    for (const occ of indirect) {
      const list = byRegion.get(occ.region) ?? []
      list.push(occ)
      byRegion.set(occ.region, list)
    }
    for (const [region, list] of [...byRegion].sort()) {
      const files = new Set(list.map(o => o.file))
      console.log(`    ${region}: ${list.length} in ${files.size} files`)
      for (const file of [...files].sort()) {
        const n = list.filter(o => o.file === file).length
        console.log(`        ${file} (${n})`)
      }
    }
  }
}

if (import.meta.main) {
  const occurrences = runCensus()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(occurrences, null, 2))
  } else {
    report(occurrences, process.argv.includes('--gates') ? 'gates' : 'full')
  }
}
