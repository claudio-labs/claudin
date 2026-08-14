// ---------------------------------------------------------------------------
// scanSymbols — dependency-free structural symbol scanner
// ---------------------------------------------------------------------------
//
// Produces a flat, ordered table of the top-level symbols in a source file
// (plus class and object-literal members) without an AST. It powers the
// Smart Code Navigation
// "outline" and "unfold" views: outline renders every signature, unfold
// slices one symbol's body — both off the SAME table, so their boundaries
// always agree.
//
// Three strategies, selected per language:
//   C-like:   brace-depth counting on a string/comment-masked copy. Each
//             language is a CLikeSpec (mask + detect + filter rules), so
//             adding one never touches another's path. TS/JS/Go keep their
//             original behavior bit-for-bit (legacy raw-line detection);
//             Java/Kotlin/C#/Rust detect on the masked line. C# `namespace`
//             and Rust `mod` are depth-transparent: members inside them
//             still gate as top-level.
//   Python:   indentation tracking on a masked copy.
//   Markdown: ATX headings with fenced-code-block tracking.
//
// Fail-open: any internal error, an unbalanced source, or zero symbols all
// yield []. Callers treat [] as "degrade to a normal Read".
//
// This file is the barrel — it holds the three dispatchers and the public
// surface. The ~20 call sites across the codebase keep importing from here;
// new code should prefer importing directly from the relevant submodule.
//
// Splitting layout:
//   types.ts          — SymbolKind, OutlineLang, SymbolEntry
//   detectLang.ts     — EXT_TO_LANG, detectOutlineLang(FromPath), SCAN_MAX_BYTES
//   internal.ts       — logScanError, trimSignature, capSignature,
//                       leadingIndent, nearestEnclosing, BlockFrame
//                       (package-internal, deliberately NOT re-exported here)
//   mask/core.ts      — the interpolation table, the literal walker, maskCLike
//   mask/languages.ts — maskPython/Rust/Php/Bash/Elixir/PowerShell
//   clike/types.ts    — CLikeDetection, CLikeSpec, Candidate
//   clike/detectors.ts— declaration regexes + the 11 detectX functions
//   clike/specs.ts    — TS_SPEC + the CLIKE_SPECS table
//   clike/scan.ts     — scanCLike, resolveCLikeBounds, findDocLineCLike
//   langs/*.ts        — one module per scanner that is not C-like; webMarkup
//                       groups css/html/xml and config groups yaml/toml/
//                       properties+env/dockerfile/makefile
//   renderOutline.ts  — the outline renderer (unchanged by the split)
// ---------------------------------------------------------------------------

import { logScanError } from 'src/tools/shared/codeOutline/internal.js'
import { INTERPOLATION } from 'src/tools/shared/codeOutline/mask/core.js'
import {
  maskElixir,
  maskPowerShell,
  maskPython,
} from 'src/tools/shared/codeOutline/mask/languages.js'
import { CLIKE_SPECS } from 'src/tools/shared/codeOutline/clike/specs.js'
import { scanCLike } from 'src/tools/shared/codeOutline/clike/scan.js'
import { scanPython } from 'src/tools/shared/codeOutline/langs/python.js'
import { scanMarkdown } from 'src/tools/shared/codeOutline/langs/markdown.js'
import { maskRuby, scanRuby } from 'src/tools/shared/codeOutline/langs/ruby.js'
import { maskLua, scanLua } from 'src/tools/shared/codeOutline/langs/lua.js'
import { maskSql, scanSql } from 'src/tools/shared/codeOutline/langs/sql.js'
import {
  maskCss,
  maskHtml,
  maskXml,
  scanCss,
  scanHtml,
  scanXml,
} from 'src/tools/shared/codeOutline/langs/webMarkup.js'
import {
  scanConfig,
  scanDockerfile,
  scanMakefile,
  scanToml,
  scanYaml,
} from 'src/tools/shared/codeOutline/langs/config.js'
import type {
  SymbolEntry,
  OutlineLang,
} from 'src/tools/shared/codeOutline/types.js'

export {
  detectOutlineLang,
  detectOutlineLangFromPath,
  SCAN_MAX_BYTES,
} from 'src/tools/shared/codeOutline/detectLang.js'
export type {
  OutlineLang,
  SymbolEntry,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

/** Scans a source file and returns its ordered symbol table. */
export function scanSymbols(source: string, lang: OutlineLang): SymbolEntry[] {
  try {
    if (!source) return []
    if (lang === 'python') return scanPython(source)
    if (lang === 'markdown') return scanMarkdown(source)
    if (lang === 'ruby') return scanRuby(source)
    if (lang === 'lua') return scanLua(source)
    if (lang === 'sql') return scanSql(source)
    if (lang === 'css') return scanCss(source)
    if (lang === 'html') return scanHtml(source)
    if (lang === 'yaml') return scanYaml(source)
    if (lang === 'xml') return scanXml(source)
    if (lang === 'properties' || lang === 'env') return scanConfig(source)
    if (lang === 'toml') return scanToml(source)
    if (lang === 'dockerfile') return scanDockerfile(source)
    if (lang === 'makefile') return scanMakefile(source)
    // Mask-only languages: string/comment analysis without a symbol scanner.
    // Rename sites stay exact; they just carry no enclosing symbol.
    if (lang === 'elixir' || lang === 'powershell') return []
    return scanCLike(source, CLIKE_SPECS[lang])
  } catch (e) {
    logScanError(e)
    return []
  }
}

/**
 * The deepest symbol whose [startLine,endLine] range contains `line`, or null
 * when the line sits between top-level symbols.
 */
export function enclosingSymbol(
  entries: SymbolEntry[],
  line: number,
): SymbolEntry | null {
  let best: SymbolEntry | null = null
  for (const e of entries) {
    if (line < e.startLine || line > e.endLine) continue
    if (best === null || e.depth > best.depth) best = e
  }
  return best
}

/**
 * The string/comment mask a scanner would use for `lang`, or null when that
 * language has no mask.
 *
 * Every mask blanks masked spans in place (`blank()` writes `' '` and preserves
 * `\n`), so the result is the SAME length as `source` and every offset lines up
 * byte for byte. That makes `masked[k] !== source[k]` an exact test for "offset
 * k sits inside a string or comment" — the cheap substitute for a parser when
 * deciding whether a textual match is real code.
 *
 * Returns null (never a best-effort mask) for languages whose scanner does no
 * masking — markdown, yaml, toml, properties/env, dockerfile, makefile — so
 * callers can tell "analyzed, not masked here" from "not analyzed at all".
 */
export function maskSourceForLang(
  source: string,
  lang: OutlineLang,
  opts?: {
    /**
     * Keep interpolated expressions as code instead of string text — `${…}`,
     * `#{…}`, `\(…)`, `"$name"`, an f-string field. See the `Interpolation`
     * type for why this is opt-in and which languages carry a spec.
     */
    stringInterpolations?: boolean
  },
): string | null {
  try {
    if (!source) return source
    const interp = opts?.stringInterpolations ? INTERPOLATION[lang] : null
    if (lang === 'python') return maskPython(source, interp)
    if (lang === 'ruby') return maskRuby(source, interp)
    if (lang === 'elixir') return maskElixir(source, interp)
    if (lang === 'powershell') return maskPowerShell(source, interp)
    if (lang === 'lua') return maskLua(source)
    if (lang === 'sql') return maskSql(source)
    if (lang === 'css') return maskCss(source)
    if (lang === 'html') return maskHtml(source)
    if (lang === 'xml') return maskXml(source)
    if (
      lang === 'markdown' ||
      lang === 'yaml' ||
      lang === 'toml' ||
      lang === 'properties' ||
      lang === 'env' ||
      lang === 'dockerfile' ||
      lang === 'makefile'
    ) {
      return null
    }
    return CLIKE_SPECS[lang].mask(source, interp)
  } catch (e) {
    logScanError(e)
    return null
  }
}

