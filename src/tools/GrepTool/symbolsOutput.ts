import { readFile, stat } from 'fs/promises'

import { logError } from '../../utils/log.js'
import { toRelativePath } from '../../utils/path.js'
import { createTextDecoder, encodingOverride } from '../../utils/textEncoding.js'
import {
  detectOutlineLangFromPath,
  enclosingSymbol,
  SCAN_MAX_BYTES,
  scanSymbols,
  type SymbolEntry,
} from '../shared/codeOutline/scanSymbols.js'
import { RG_LINE_RE } from './relativize.js'

// Cap on files scanned in 'symbols' mode — scanning is per-file work and a
// broad pattern can match thousands of files; this bounds the cost.
const SYMBOLS_MAX_FILES = 50

export type SymbolsResult = {
  content: string
  numFiles: number
  numMatches: number
  filenames: string[]
}

/**
 * Maps ripgrep content lines (`abs:line:text`) to the enclosing symbol in
 * each file. Files in an unsupported language, or where the scan fails, fall
 * back to a bare relative-path listing. Fail-open throughout.
 *
 * Lives outside GrepTool.ts so the replay bench can build a map without
 * importing the tool — GrepTool ↔ GlobTool/UI is a module cycle, and pulling
 * the tool in from a script hits it before the tool is initialised.
 *
 * `encoding` is the same label the search ran under. Without it a match found
 * in a Shift-JIS or UTF-16 file maps to no symbol at all: the scan would read
 * the bytes as UTF-8, get mojibake, and report "(matched outside any symbol)"
 * for a file that is full of them.
 */
export async function buildSymbolsOutput(
  rgLines: string[],
  encoding?: string,
): Promise<SymbolsResult> {
  // Group matched line numbers by absolute file path.
  const byFile = new Map<string, Set<number>>()
  for (const raw of rgLines) {
    const m = RG_LINE_RE.exec(raw)
    if (!m) continue
    const file = m[1]
    const lineNo = parseInt(m[2], 10)
    let set = byFile.get(file)
    if (!set) {
      set = new Set()
      byFile.set(file, set)
    }
    set.add(lineNo)
  }

  const files = [...byFile.keys()].sort().slice(0, SYMBOLS_MAX_FILES)
  const blocks: string[] = []
  let numMatches = 0
  const filenames: string[] = []
  // Built once rather than per file, and before the loop so an unusable label
  // fails the call instead of silently degrading all 50 files to "could not
  // scan". The search itself already rejected unknown labels, so reaching this
  // with a bad one means the two label spaces disagreed.
  const decodeAs = encodingOverride(encoding)
  const decoder = decodeAs ? createTextDecoder(decodeAs) : null

  for (const absPath of files) {
    const rel = toRelativePath(absPath)
    filenames.push(rel)
    const lineNos = [...byFile.get(absPath)!].sort((a, b) => a - b)
    const lang = detectOutlineLangFromPath(absPath)

    if (!lang) {
      blocks.push(`${rel}\n  (matched, language not supported for symbols)`)
      continue
    }

    let entries: SymbolEntry[]
    try {
      // Same cap as the Read auto-pivot scan — an unbounded read of a matched
      // multi-hundred-MB dump.sql/dataset.xml would spike memory before the
      // scan even starts.
      const { size } = await stat(absPath)
      if (size > SCAN_MAX_BYTES) {
        blocks.push(`${rel}\n  (matched, file too large to scan)`)
        continue
      }
      const source = decoder
        ? decoder.decode(await readFile(absPath))
        : await readFile(absPath, 'utf8')
      entries = scanSymbols(source, lang)
    } catch (e) {
      logError(e)
      blocks.push(`${rel}\n  (matched, could not scan)`)
      continue
    }

    const seen = new Set<string>()
    const lines: string[] = []
    for (const lineNo of lineNos) {
      const sym = enclosingSymbol(entries, lineNo)
      if (!sym) continue
      const key = `${sym.startLine}-${sym.endLine}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`  ${key}  ${sym.signature}`)
      numMatches++
    }
    blocks.push(
      lines.length > 0
        ? `${rel}\n${lines.join('\n')}`
        : `${rel}\n  (matched outside any symbol)`,
    )
  }

  return {
    content: blocks.join('\n\n'),
    numFiles: files.length,
    numMatches,
    filenames,
  }
}
