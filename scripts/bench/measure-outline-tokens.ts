#!/usr/bin/env bun
/**
 * Micro-bench: measures real token cost of FileReadTool view='outline' across
 * representative source files. Output feeds the description claim in
 * src/tools/FileReadTool/prompt.ts:37.
 *
 * Usage: bun run scripts/bench/measure-outline-tokens.ts
 *
 * Uses the same renderOutline + scanSymbols path the tool itself takes, so the
 * numbers are exact (no API round trip needed). Token estimation = chars / 4
 * (matches renderOutline's internal heuristic).
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  detectOutlineLang,
  scanSymbols,
} from '../../src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutline } from '../../src/tools/shared/codeOutline/renderOutline.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

// Representative files spanning size + density. All TS (codebase is TS-only).
const FILES = [
  'src/utils/fileRead.ts', // ~102 LoC, tiny
  'src/tools/GrepTool/GrepTool.ts', // ~700 LoC, medium
  'src/tools/FileReadTool/FileReadTool.ts', // ~1300 LoC, large
  'src/utils/config.ts', // ~2059 LoC, very large
  'src/cli/print/runHeadless.ts', // ~4094 LoC, huge
  'src/utils/auth.ts', // ~2019 LoC, large dense
  'src/tools/BashTool/bashSecurity.ts', // ~2592 LoC, large dense
]

function tokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface Row {
  file: string
  loc: number
  bytes: number
  symbols: number
  outlineChars: number
  outlineTokens: number
}

const rows: Row[] = []

for (const rel of FILES) {
  const abs = resolve(REPO_ROOT, rel)
  const src = readFileSync(abs, 'utf8')
  const ext = rel.split('.').pop() ?? ''
  const lang = detectOutlineLang(ext)
  if (!lang) {
    console.error(`skip ${rel}: lang not supported`)
    continue
  }
  const symbols = scanSymbols(src, lang)
  if (symbols.length === 0) {
    console.error(`skip ${rel}: zero symbols scanned`)
    continue
  }
  const loc = src.split('\n').length
  const outline = renderOutline(symbols, rel, loc, { overCap: false })
  rows.push({
    file: rel,
    loc,
    bytes: statSync(abs).size,
    symbols: symbols.length,
    outlineChars: outline.length,
    outlineTokens: tokens(outline),
  })
}

rows.sort((a, b) => a.loc - b.loc)

console.log('')
console.log('| File | LoC | Bytes | Symbols | Outline chars | Outline tokens |')
console.log('|---|---:|---:|---:|---:|---:|')
for (const r of rows) {
  console.log(
    `| ${r.file} | ${r.loc} | ${r.bytes} | ${r.symbols} | ${r.outlineChars} | ${r.outlineTokens} |`,
  )
}

const toks = rows.map((r) => r.outlineTokens).sort((a, b) => a - b)
const sum = toks.reduce((a, b) => a + b, 0)
const median = toks[Math.floor(toks.length / 2)]
const mean = Math.round(sum / toks.length)
const min = toks[0]
const max = toks[toks.length - 1]

console.log('')
console.log(`min: ${min}`)
console.log(`median: ${median}`)
console.log(`mean: ${mean}`)
console.log(`max: ${max}`)
console.log(`n: ${toks.length}`)
