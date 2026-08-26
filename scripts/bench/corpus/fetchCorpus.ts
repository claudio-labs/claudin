#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// fetchCorpus — downloads, caches and buckets the pinned bench corpus
// ---------------------------------------------------------------------------
//
// One tarball per remote language (see manifest.ts), extracted once into
// ~/.cache/claudin-bench-corpus/<lang>-<repo>-<tag>/. A second run is a no-op:
// the cache is keyed by the pinned tag, so re-running costs a stat, not a
// download.
//
// `loadCorpus()` returns, per language, the sampled files grouped into four
// size buckets. Sampling is deterministic — sorted by relative path, then
// EVENLY SPACED across the bucket rather than "the first 40". Taking a prefix
// would sample one directory (everything under `a…`) instead of the language.
//
// Usage:
//   bun run scripts/bench/corpus/fetchCorpus.ts          # populate the cache
//   bun run scripts/bench/corpus/fetchCorpus.ts --list   # + per-cell counts
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

import type { OutlineLang } from '../../../src/tools/shared/codeOutline/scanSymbols.js'
import { REPO_ROOT } from '../../repoRoot'
import {
  GATE_LANGS,
  LOCAL_SOURCES,
  REMOTE_SOURCES,
  sourceDirName,
  tarballUrl,
  type RemoteSource,
} from './manifest'

export const CACHE_ROOT = join(homedir(), '.cache', 'claudin-bench-corpus')

/** Files above this are outliers (minified bundles, generated tables). */
const MAX_FILE_BYTES = 1024 * 1024
/** Per bucket, per language. Enough for a stable median without a slow run. */
const MAX_FILES_PER_BUCKET = 40

export const BUCKETS = ['<100', '100-500', '500-1500', '>1500'] as const
export type Bucket = (typeof BUCKETS)[number]

export function bucketOf(lines: number): Bucket {
  if (lines < 100) return '<100'
  if (lines < 500) return '100-500'
  if (lines < 1500) return '500-1500'
  return '>1500'
}

export type CorpusFile = {
  lang: OutlineLang
  /** Absolute path on disk. */
  path: string
  /** Stable display label — repo-relative, or `<source>/<path>` for remotes. */
  label: string
  lines: number
  bucket: Bucket
}

export type Corpus = {
  files: CorpusFile[]
  /** Languages whose remote source could not be fetched (non-gate only). */
  skipped: Array<{ lang: OutlineLang; reason: string }>
}

function log(message: string): void {
  // stderr, so `outline-symbols-ab.ts --json` keeps a clean stdout.
  process.stderr.write(message + '\n')
}

/**
 * Downloads and extracts one source unless its cache directory already exists.
 * Returns the directory, or null when the fetch failed (the caller decides
 * whether that is fatal).
 */
export async function ensureRemoteSource(
  src: RemoteSource,
): Promise<string | null> {
  const dest = join(CACHE_ROOT, sourceDirName(src))
  if (existsSync(dest)) {
    log(`  cached   ${sourceDirName(src)}`)
    return dest
  }

  const url = tarballUrl(src)
  const tmp = `${dest}.tar.gz`
  mkdirSync(CACHE_ROOT, { recursive: true })
  log(`  fetching ${sourceDirName(src)} … ${url}`)
  try {
    const res = await fetch(url)
    if (!res.ok) {
      log(`  FAILED   ${sourceDirName(src)} — HTTP ${res.status}`)
      return null
    }
    await Bun.write(tmp, res)
    mkdirSync(dest, { recursive: true })
    // --strip-components=1 drops the tarball's `<repo>-<tag>/` root, so the
    // manifest's subdirs are repo-relative and independent of the tag string.
    const proc = Bun.spawn(['tar', '-xzf', tmp, '--strip-components=1', '-C', dest], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      log(`  FAILED   ${sourceDirName(src)} — tar exited ${code}: ${err.trim()}`)
      rmSync(dest, { recursive: true, force: true })
      return null
    }
    return dest
  } catch (e) {
    log(`  FAILED   ${sourceDirName(src)} — ${String(e)}`)
    rmSync(dest, { recursive: true, force: true })
    return null
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Recursively lists files under `dir` whose extension is in `exts`. */
async function walk(
  dir: string,
  exts: ReadonlySet<string>,
  out: string[],
): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // A subdir named in the manifest that this tag does not carry. Reported by
    // the caller as an empty cell rather than crashing the run.
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await walk(full, exts, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!exts.has(extname(entry.name).slice(1).toLowerCase())) continue
    out.push(full)
  }
}

/** Evenly spaced sample of `cap` items — never a prefix. */
function sampleEvenly<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items
  const picked: T[] = []
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * (items.length - 1)) / (cap - 1))
    const item = items[idx]
    if (item !== undefined) picked.push(item)
  }
  return picked
}

async function measureFiles(
  lang: OutlineLang,
  paths: string[],
  labelFor: (path: string) => string,
): Promise<CorpusFile[]> {
  const out: CorpusFile[] = []
  for (const path of paths.sort()) {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES || size === 0) continue
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').length
    out.push({ lang, path, label: labelFor(path), lines, bucket: bucketOf(lines) })
  }
  return out
}

/**
 * Populates the cache and returns the sampled corpus.
 *
 * Throws when a GATE language ends up with no files — those five are what the
 * scanner change touches, and a gate that measures four of them while
 * reporting success is exactly the failure mode this bench exists to prevent.
 */
export async function loadCorpus(): Promise<Corpus> {
  const all: CorpusFile[] = []
  const skipped: Array<{ lang: OutlineLang; reason: string }> = []

  log('corpus: local sources')
  for (const src of LOCAL_SOURCES) {
    const exts = new Set(src.extensions)
    const paths: string[] = []
    for (const dir of src.dirs) {
      await walk(join(REPO_ROOT, dir), exts, paths)
    }
    const measured = await measureFiles(src.lang, paths, p =>
      p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p,
    )
    log(`  local    ${src.lang.padEnd(12)} ${measured.length} file(s)`)
    all.push(...measured)
  }

  log('corpus: remote sources')
  for (const src of REMOTE_SOURCES) {
    const dir = await ensureRemoteSource(src)
    if (dir === null) {
      skipped.push({ lang: src.lang, reason: `fetch failed: ${tarballUrl(src)}` })
      continue
    }
    const exts = new Set(src.extensions)
    const paths: string[] = []
    for (const sub of src.subdirs) {
      await walk(sub === '.' ? dir : join(dir, sub), exts, paths)
    }
    const name = sourceDirName(src)
    const measured = await measureFiles(src.lang, paths, p =>
      `${name}/${p.startsWith(dir) ? p.slice(dir.length + 1) : p}`,
    )
    if (measured.length === 0) {
      skipped.push({ lang: src.lang, reason: `no files under ${src.subdirs.join(', ')}` })
      continue
    }
    all.push(...measured)
  }

  // Sample per (lang, bucket), deterministically.
  const byCell = new Map<string, CorpusFile[]>()
  for (const f of all) {
    const key = `${f.lang}\u0000${f.bucket}`
    const list = byCell.get(key)
    if (list) list.push(f)
    else byCell.set(key, [f])
  }
  const files: CorpusFile[] = []
  for (const [, list] of [...byCell.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.label.localeCompare(b.label))
    files.push(...sampleEvenly(list, MAX_FILES_PER_BUCKET))
  }

  const present = new Set(files.map(f => f.lang))
  const missing = GATE_LANGS.filter(l => !present.has(l))
  if (missing.length > 0) {
    throw new Error(
      `corpus is missing gate language(s): ${missing.join(', ')}. ` +
        `The declaration-shape gate is switched on for these, so the A/B cannot ` +
        `certify the change without them. Skipped: ` +
        `${skipped.map(s => `${s.lang} (${s.reason})`).join('; ') || 'none'}`,
    )
  }
  return { files, skipped }
}

async function main(): Promise<void> {
  const corpus = await loadCorpus()
  log('')
  log(`corpus ready: ${corpus.files.length} sampled file(s) in ${CACHE_ROOT}`)
  if (corpus.skipped.length > 0) {
    for (const s of corpus.skipped) log(`  skipped ${s.lang}: ${s.reason}`)
  }
  if (process.argv.includes('--list')) {
    const counts = new Map<string, number>()
    for (const f of corpus.files) {
      const key = `${f.lang}\u0000${f.bucket}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    log('')
    for (const [key, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [lang, bucket] = key.split('\u0000')
      log(`  ${String(lang).padEnd(12)} ${String(bucket).padEnd(10)} ${n}`)
    }
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
