#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// code-outline-ab — A/B validation gate for the summarizer's code-outline
// strategy (ROADMAP side-bet). Distinct from code-outline-bench.ts, which
// measures the FileReadTool AUTO_OUTLINE flow.
//
// Three conditions per fixture, all via the synchronous estimator (no API /
// config / analytics — fully reproducible in CI):
//
//   Raw  full tool-result text (no summarizer)
//   H    head40/tail60 — today's blind Bash strategy (status quo)
//   O    code-outline — the new strategy (real detectCodeLang + scanSymbols +
//        renderOutlineBody pulled from src/, only the trivial head/tail is
//        replicated locally)
//
// Reports, on a corpus of real repo source files (> the 8KB summarize bar):
//   1. Raw → O   headline token savings of the feature
//   2. H   → O   marginal delta vs the status quo (may be modest — the win is
//                correctness, see (3))
//   3. symbol coverage — fraction of the file's symbols still visible to the
//        model: O = the symbol rows actually present in the (token-capped)
//        outline body, H = only those inside head40/tail60
//
// And on a negative corpus (prose / diff / log / grep / JSON): asserts O is
// INVISIBLE — detectCodeLang returns null, so O falls through to exactly H.
//
// Pass criteria (the guarantee):
//   - code corpus: O tokens < Raw tokens, and O coverage ≥ H coverage
//   - negative corpus: every fixture detects as null (O == H byte-for-byte)
//
// Usage:
//   bun run scripts/profile/code-outline-ab.ts
//   bun run scripts/profile/code-outline-ab.ts > scripts/profile/code-outline-ab-results.txt
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { Glob } from 'bun'

import {
  detectCodeLang,
  stripLineNumberPrefix,
} from '../../src/utils/detectCodeLang.js'
import { scanSymbols } from '../../src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutlineBody } from '../../src/tools/shared/codeOutline/renderOutline.js'

const REPO_ROOT = new URL('../../', import.meta.url).pathname

// Mirrors toolResultSummarizer.ts: BASH_SUMMARIZE_THRESHOLD, BASH_HEAD/TAIL,
// CODE_OUTLINE_MIN_SYMBOLS, CODE_MIN_SAVINGS. Kept in sync by the unit tests
// that exercise the real strategy; this bench only quantifies magnitude.
const SUMMARIZE_THRESHOLD = 8_000
const BASH_HEAD = 40
const BASH_TAIL = 60
const MIN_SYMBOLS = 3
const MIN_SAVINGS = 0.15
const BYTES_PER_TOKEN = 4

const tokensOf = (text: string): number => Math.round(text.length / BYTES_PER_TOKEN)

function headTail(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= BASH_HEAD + BASH_TAIL) return text
  const omitted = lines.length - BASH_HEAD - BASH_TAIL
  return [
    ...lines.slice(0, BASH_HEAD),
    `<omitted lines="${omitted}"/>`,
    ...lines.slice(-BASH_TAIL),
  ].join('\n')
}

type OutlineResult = {
  body: string
  symbolCount: number
  lines: number
  coverage: number
} | null

// Replicates summarizeCodeOutline's decision over real detection/outline code.
function tryOutline(text: string): OutlineResult {
  const lines = text.split('\n')
  const stripped = stripLineNumberPrefix(lines).join('\n')
  const lang = detectCodeLang(stripped)
  if (lang === null) return null
  const entries = scanSymbols(stripped, lang)
  if (entries.length < MIN_SYMBOLS) return null
  const body = renderOutlineBody(entries)
  if (body.length > text.length * (1 - MIN_SAVINGS)) return null
  // Measured (not assumed) coverage: count the `<start>-<end> …` symbol rows
  // actually present in the rendered body. renderOutlineBody truncates at
  // OUTLINE_MAX_TOKENS, so a pathological file can carry < 100% of its symbols —
  // the A/B gate must compare a real number, not a hardcoded 1.
  const shown = body.split('\n').filter(l => /^\s*\d+-\d+\s/.test(l)).length
  return {
    body,
    symbolCount: entries.length,
    lines: lines.length,
    coverage: entries.length > 0 ? shown / entries.length : 1,
  }
}

// Fraction of symbols visible under head40/tail60 (the H coverage).
function headTailCoverage(text: string): number {
  const lines = text.split('\n')
  const stripped = stripLineNumberPrefix(lines).join('\n')
  const lang = detectCodeLang(stripped)
  if (lang === null) return 1
  const entries = scanSymbols(stripped, lang)
  if (entries.length === 0) return 1
  const total = lines.length
  const visible = entries.filter(
    e => e.startLine <= BASH_HEAD || e.startLine > total - BASH_TAIL,
  ).length
  return visible / entries.length
}

type CodeRow = {
  file: string
  raw: number
  h: number
  o: number
  oCov: number
  hCov: number
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w)
}

async function main(): Promise<void> {
  // --- Code corpus: real repo source files above the summarize bar ---
  const glob = new Glob('src/**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,cs}')
  const codeRows: CodeRow[] = []
  for await (const rel of glob.scan(REPO_ROOT)) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue
    let source: string
    try {
      source = readFileSync(REPO_ROOT + rel, 'utf8')
    } catch {
      continue
    }
    if (source.length < SUMMARIZE_THRESHOLD) continue
    const outline = tryOutline(source)
    if (!outline) continue // detection/savings miss — not a code-outline case
    const h = headTail(source)
    codeRows.push({
      file: rel,
      raw: tokensOf(source),
      h: tokensOf(h),
      o: tokensOf(outline.body),
      oCov: outline.coverage, // measured: rows present in the (capped) outline
      hCov: headTailCoverage(source),
    })
  }
  codeRows.sort((a, b) => b.raw - a.raw)

  // --- Negative corpus: must detect as null (O invisible → O == H) ---
  const negatives: Array<{ name: string; text: string }> = [
    {
      name: 'prose',
      text: 'This is an ordinary paragraph of English prose. '.repeat(400),
    },
    {
      name: 'unified-diff',
      text:
        `diff --git a/x.ts b/x.ts\nindex 1aa..2bb 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n` +
        Array.from({ length: 400 }, (_, i) => ` export function keep${i}() {}`).join('\n'),
    },
    {
      name: 'log',
      text: Array.from(
        { length: 400 },
        (_, i) => `2026-01-01 12:00:${String(i % 60).padStart(2, '0')} INFO handled ok`,
      ).join('\n'),
    },
    {
      name: 'grep-path:line:',
      text: Array.from(
        { length: 400 },
        (_, i) => `src/a${i}.ts:${i}:export const A${i} = 1`,
      ).join('\n'),
    },
    {
      name: 'json-array',
      text: JSON.stringify(
        Array.from({ length: 400 }, (_, i) => ({ id: i, name: `n${i}`, ok: true })),
      ),
    },
  ]

  // --- Report ---
  const out: string[] = []
  out.push('')
  out.push('code-outline A/B — summarizer strategy (estimator-based, reproducible)')
  out.push(`code corpus: ${codeRows.length} repo file(s) > ${SUMMARIZE_THRESHOLD}B that detect as code`)
  out.push('')
  out.push(
    `${'file'.padEnd(50)}${pad('raw', 8)}${pad('H', 8)}${pad('O', 8)}` +
      `${pad('O cov', 8)}${pad('H cov', 8)}`,
  )
  out.push('-'.repeat(90))
  const TOP_N = 25
  let tRaw = 0
  let tH = 0
  let tO = 0
  let sumOCov = 0
  let sumHCov = 0
  codeRows.forEach((r, idx) => {
    if (idx < TOP_N) {
      const name = r.file.length > 49 ? '…' + r.file.slice(-48) : r.file
      out.push(
        `${name.padEnd(50)}${pad(r.raw, 8)}${pad(r.h, 8)}${pad(r.o, 8)}` +
          `${pad((r.oCov * 100).toFixed(0) + '%', 8)}${pad((r.hCov * 100).toFixed(0) + '%', 8)}`,
      )
    }
    tRaw += r.raw
    tH += r.h
    tO += r.o
    sumOCov += r.oCov
    sumHCov += r.hCov
  })
  if (codeRows.length > TOP_N) {
    out.push(`… (+${codeRows.length - TOP_N} more files, all included in TOTAL)`)
  }
  out.push('-'.repeat(90))
  const n = codeRows.length || 1
  const avgOCov = sumOCov / n
  const avgHCov = sumHCov / n
  out.push(`${'TOTAL'.padEnd(50)}${pad(tRaw, 8)}${pad(tH, 8)}${pad(tO, 8)}`)
  out.push('')
  const rawToO = tRaw > 0 ? (1 - tO / tRaw) * 100 : 0
  const hToO = tH > 0 ? (1 - tO / tH) * 100 : 0
  out.push(`Raw → O : ${tRaw} → ${tO} tokens  (${rawToO.toFixed(1)}% saved)`)
  out.push(`H   → O : ${tH} → ${tO} tokens  (${hToO.toFixed(1)}% marginal vs status-quo head/tail)`)
  out.push(`coverage: O avg ${(avgOCov * 100).toFixed(0)}%  vs  H avg ${(avgHCov * 100).toFixed(0)}% of symbols visible`)
  out.push('')

  out.push('negative corpus (must detect null → O identical to H):')
  let negPass = true
  for (const neg of negatives) {
    const stripped = stripLineNumberPrefix(neg.text.split('\n')).join('\n')
    const lang = detectCodeLang(stripped)
    const ok = lang === null
    if (!ok) negPass = false
    out.push(`  ${ok ? 'PASS' : 'FAIL'}  ${neg.name.padEnd(20)} detected=${lang ?? 'null'}`)
  }
  out.push('')

  const codePass = codeRows.length > 0 && tO < tRaw && avgOCov >= avgHCov
  const pass = codePass && negPass
  out.push(`GATE: code(savings & coverage)=${codePass ? 'PASS' : 'FAIL'}  negatives=${negPass ? 'PASS' : 'FAIL'}  → ${pass ? 'PASS' : 'FAIL'}`)
  out.push('')

  process.stdout.write(out.join('\n'))
  if (!pass) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
