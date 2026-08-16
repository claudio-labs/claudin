#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// code-outline-bench — token cost of Smart Code Navigation on large files
// ---------------------------------------------------------------------------
//
// For every source file in src/ that would exceed the Read token cap, compares
// three costs, all via the synchronous estimator (no API round-trip, fully
// reproducible in CI):
//
//   full      tokens of the whole file (what an uncapped Read would cost)
//   outline   tokens of renderOutline(scanSymbols(...))
//   unfold    tokens of the median-sized symbol's body (proxy for
//             "expand one function" — median, not max, so a single giant
//             component doesn't skew the picture)
//   typical   outline + unfold — the real "one function of a big file" flow
//
// Usage:
//   bun run scripts/bench/perf/code-outline-bench.ts
//   bun run scripts/bench/perf/code-outline-bench.ts --json
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { Glob } from 'bun'

import { renderOutline } from '../../../src/tools/shared/codeOutline/renderOutline.js'
import {
  detectOutlineLang,
  scanSymbols,
  type SymbolEntry,
} from '../../../src/tools/shared/codeOutline/scanSymbols.js'

const REPO_ROOT = new URL('../../', import.meta.url).pathname
// The Read token cap (DEFAULT_MAX_OUTPUT_TOKENS in FileReadTool/limits.ts).
const READ_TOKEN_CAP = 25_000
// Always include this anchor file even if discovery order changes.
const ANCHOR = 'src/providers/shims/openaiShim.ts'

const jsonMode = process.argv.includes('--json')

// Coarse token estimate — same heuristic the rest of the codebase uses for
// file-type-aware sizing (4 bytes/token, 2 for dense JSON). Inlined so the
// bench stays free of the provider/tokenizer dependency chain.
function tokensOf(text: string, ext: string): number {
  const e = ext.replace(/^\./, '').toLowerCase()
  const bytesPerToken = e === 'json' || e === 'jsonl' || e === 'jsonc' ? 2 : 4
  return Math.round(text.length / bytesPerToken)
}

// The median-span symbol — a representative "one function" the model would
// unfold. Median (not max) keeps a single giant component from skewing it.
function medianSymbol(entries: SymbolEntry[]): SymbolEntry | null {
  if (entries.length === 0) return null
  const bySpan = [...entries].sort(
    (a, b) => a.endLine - a.startLine - (b.endLine - b.startLine),
  )
  return bySpan[Math.floor(bySpan.length / 2)]!
}

type Row = {
  file: string
  lines: number
  full: number
  outline: number
  unfold: number
  typical: number
  outlinePct: number
  typicalPct: number
}

function measure(relPath: string): Row | null {
  const ext = extname(relPath)
  const lang = detectOutlineLang(ext)
  if (!lang) return null

  let source: string
  try {
    source = readFileSync(REPO_ROOT + relPath, 'utf8')
  } catch {
    return null
  }

  const full = tokensOf(source, ext)
  const entries = scanSymbols(source, lang)
  if (entries.length === 0) return null

  const lines = source.split('\n')
  const outlineText = renderOutline(entries, relPath, lines.length, {
    reason: 'overcap',
  })
  const outline = tokensOf(outlineText, 'txt')

  const pick = medianSymbol(entries)
  const unfoldText = pick
    ? lines.slice(pick.startLine - 1, pick.endLine).join('\n')
    : ''
  const unfold = tokensOf(unfoldText, ext)

  const typical = outline + unfold
  return {
    file: relPath,
    lines: lines.length,
    full,
    outline,
    unfold,
    typical,
    outlinePct: full > 0 ? (outline / full) * 100 : 0,
    typicalPct: full > 0 ? (typical / full) * 100 : 0,
  }
}

async function main(): Promise<void> {
  const glob = new Glob('src/**/*.{ts,tsx,js,jsx,py,go}')
  const seen = new Set<string>()
  const candidates: string[] = []
  for await (const rel of glob.scan(REPO_ROOT)) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
    seen.add(rel)
    candidates.push(rel)
  }
  if (!seen.has(ANCHOR)) candidates.unshift(ANCHOR)

  const rows: Row[] = []
  for (const rel of candidates) {
    const row = measure(rel)
    // Only files that actually exceed the cap are interesting.
    if (row && (row.full > READ_TOKEN_CAP || rel === ANCHOR)) {
      rows.push(row)
    }
  }
  rows.sort((a, b) => b.full - a.full)

  if (jsonMode) {
    const totals = rows.reduce(
      (acc, r) => ({
        full: acc.full + r.full,
        outline: acc.outline + r.outline,
        typical: acc.typical + r.typical,
      }),
      { full: 0, outline: 0, typical: 0 },
    )
    process.stdout.write(
      JSON.stringify({ rows, totals, fileCount: rows.length }, null, 2) + '\n',
    )
    return
  }

  if (rows.length === 0) {
    process.stdout.write('No over-cap source files found.\n')
    return
  }

  const pad = (s: string | number, w: number) => String(s).padStart(w)
  process.stdout.write(
    `\nSmart Code Navigation — token cost on ${rows.length} over-cap file(s)\n` +
      `(estimator-based; Read token cap = ${READ_TOKEN_CAP})\n\n`,
  )
  process.stdout.write(
    `${'file'.padEnd(52)}${pad('lines', 7)}${pad('full', 9)}` +
      `${pad('outline', 9)}${pad('typical', 9)}${pad('typ%', 7)}\n`,
  )
  process.stdout.write('-'.repeat(93) + '\n')

  let tFull = 0
  let tOutline = 0
  let tTypical = 0
  for (const r of rows) {
    const name = r.file.length > 51 ? '…' + r.file.slice(-50) : r.file
    process.stdout.write(
      `${name.padEnd(52)}${pad(r.lines, 7)}${pad(r.full, 9)}` +
        `${pad(r.outline, 9)}${pad(r.typical, 9)}` +
        `${pad(r.typicalPct.toFixed(1), 7)}\n`,
    )
    tFull += r.full
    tOutline += r.outline
    tTypical += r.typical
  }
  process.stdout.write('-'.repeat(93) + '\n')
  process.stdout.write(
    `${'TOTAL'.padEnd(52)}${pad('', 7)}${pad(tFull, 9)}` +
      `${pad(tOutline, 9)}${pad(tTypical, 9)}` +
      `${pad(((tTypical / tFull) * 100).toFixed(1), 7)}\n\n`,
  )
  const saved = tFull - tTypical
  process.stdout.write(
    `Typical "one function of a big file" flow: ` +
      `${tTypical} vs ${tFull} tokens — ` +
      `${saved} saved (${((saved / tFull) * 100).toFixed(1)}%).\n\n`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
