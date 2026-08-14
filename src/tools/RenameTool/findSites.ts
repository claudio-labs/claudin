// Site discovery for the Rename tool: finds every textual occurrence of an
// identifier that is real code, without pulling a single file into the model's
// context.
//
// Three passes, cheapest first:
//   1. ripgrep narrows the repo to the files that contain the word at all.
//   2. per file, the language's string/comment mask (offset-preserving) drops
//      occurrences that live inside a literal or a comment.
//   3. scanSymbols annotates each survivor with its enclosing symbol, off the
//      SAME table Read's outline/unfold views use — so a site's line range in
//      the preview is the one `Read(symbol=…)` will show.
//
// Free of any `ink`/UI import so it stays unit-testable under `bun test`.

import { createHash } from 'crypto'
import { statSync } from 'fs'
import { relative } from 'path'

import { getCwd } from 'src/utils/cwd.js'
import { AbortError, isENOENT } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { ripGrep } from 'src/utils/ripgrep.js'
import {
  detectOutlineLangFromPath,
  enclosingSymbol,
  maskSourceForLang,
  type OutlineLang,
  SCAN_MAX_BYTES,
  scanSymbols,
  type SymbolEntry,
} from 'src/tools/shared/codeOutline/scanSymbols.js'
import { readFileForStaging } from 'src/tools/shared/stagedWrite/stagedWrite.js'

/** Directories whose contents are never source under review. */
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.hg', '.svn']

/**
 * Hard caps. A rename wider than this is a request to narrow the scope, not a
 * batch to half-apply — both limits abort the call rather than truncate
 * silently.
 */
export const MAX_FILES = 300
export const MAX_SITES = 1000

/**
 * Discovery memo. An apply runs discovery twice — once to resolve the write
 * permission over the file set, once in the call that follows — and a preview
 * first makes it three. Each pass reads, masks and scans every candidate file,
 * so the repeat is the whole cost of a rename.
 *
 * The entry is only reused when the tree has demonstrably not moved: same
 * candidate list from ripgrep, same mtime and size on every file. Anything
 * else falls back to a full discovery, which is what keeps the permission
 * drift check honest — it needs to see a file that started matching in between.
 */
const discoveryMemo = new Map<
  string,
  { stamps: Map<string, string>; result: FindSitesResult; at: number }
>()
const MEMO_TTL_MS = 60_000

/** A valid identifier for v1: no regex, no whitespace, no path separators. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `scope` accepts several globs separated by whitespace or commas. */
const SCOPE_SEPARATOR_RE = /[\s,]+/

/**
 * Stamp for a candidate that vanished between ripgrep and the stat. Never
 * equal to a real `mtimeMs:size`, so the memo cannot match a tree in this
 * state — and unlike a random sentinel, two calls seeing the same missing
 * file still agree, which keeps the memo usable afterwards.
 */
const GONE_STAMP = 'gone'

const BASE_IDENT_CHARS = /[A-Za-z0-9_]/

export type RenameSite = {
  /** Stable within one discovery pass only — see `sitesToken`. */
  id: string
  absPath: string
  relPath: string
  /** 1-indexed. */
  line: number
  /** Offset into the LF-normalized file content. */
  offset: number
  /** The whole source line, trimmed, for the preview. */
  lineText: string
  /** Enclosing function/class, or null when the language has no scanner. */
  symbol: SymbolEntry | null
  /** True when no string/comment mask exists for this file's language. */
  unparsed: boolean
}

export type FindSitesResult = {
  sites: RenameSite[]
  /** Absolute paths with at least one site, sorted. */
  files: string[]
  /** Occurrences dropped because they sit in a string or a comment. */
  skippedMasked: number
  /** Files ripgrep matched that could not be read. */
  unreadable: string[]
  /**
   * Fingerprint of this exact site list. `exclude` is only meaningful against
   * the pass that produced it, so the tool refuses a mismatched pair.
   */
  sitesToken: string
}

export function isValidIdentifier(symbol: string): boolean {
  return IDENTIFIER_RE.test(symbol)
}

/**
 * Characters that continue an identifier in `lang`. `$` is an identifier
 * character in most C-like languages (`$sym` is its own name, so renaming
 * `sym` must not touch it), but a *sigil* in PHP, shell and PowerShell, where
 * `$sym` is exactly a reference to `sym` and must be renamed.
 */
function isIdentChar(ch: string | undefined, lang: OutlineLang | null): boolean {
  if (ch === undefined) return false
  if (BASE_IDENT_CHARS.test(ch)) return true
  if (ch === '$') {
    return lang !== 'php' && lang !== 'bash' && lang !== 'powershell'
  }
  if (ch === '-') return lang === 'css'
  return false
}

/**
 * Every offset in `source` where `symbol` appears as a standalone identifier,
 * split into real-code hits and hits the mask says are string/comment text.
 */
export function scanFileForSites(
  source: string,
  symbol: string,
  lang: OutlineLang | null,
): { offsets: number[]; maskedOut: number; hadMask: boolean } {
  const offsets: number[] = []
  let maskedOut = 0
  if (!source) return { offsets, maskedOut, hadMask: false }

  // `stringInterpolations` is what keeps `${cfg(x)}` and f"{cfg(x)}" rename
  // sites: the outline's default mask treats the whole literal as string text,
  // which would skip the call and leave a half-renamed file behind.
  const masked =
    lang && source.length <= SCAN_MAX_BYTES
      ? maskSourceForLang(source, lang, { stringInterpolations: true })
      : null

  let from = 0
  // Word boundaries are read off the MASKED copy: an interpolation sigil is
  // punctuation there (blanked), so `"$cfg"` in Kotlin reads as a reference,
  // while `val $cfg` in code — where the mask changes nothing — still reads as
  // one longer name. `isIdentChar` owns the language rule for code positions;
  // the mask owns the string ones.
  const boundarySource = masked ?? source
  for (;;) {
    const at = source.indexOf(symbol, from)
    if (at < 0) break
    from = at + symbol.length
    if (isIdentChar(boundarySource[at - 1], lang)) continue
    if (isIdentChar(boundarySource[at + symbol.length], lang)) continue
    // The mask blanks string/comment spans in place, so a differing byte at
    // the same offset means this occurrence is not code.
    if (masked && masked[at] !== source[at]) {
      maskedOut++
      continue
    }
    offsets.push(at)
  }
  return { offsets, maskedOut, hadMask: masked !== null }
}

/**
 * Offsets where each line starts, so locating N sites in a file is N binary
 * searches instead of N scans from the top.
 */
function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** Line number (1-indexed) and the trimmed source line holding `offset`. */
function locate(
  source: string,
  starts: number[],
  offset: number,
): { line: number; lineText: string } {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  const start = starts[lo]!
  const end = lo + 1 < starts.length ? starts[lo + 1]! - 1 : source.length
  return { line: lo + 1, lineText: source.slice(start, end).trim() }
}

function siteId(index: number, total: number): string {
  const width = Math.max(2, String(total).length)
  return `s${String(index + 1).padStart(width, '0')}`
}

function computeToken(sites: RenameSite[]): string {
  const h = createHash('sha256')
  for (const s of sites) {
    h.update(`${s.relPath}\u0000${s.line}\u0000${s.offset}\u0000`)
  }
  return h.digest('hex').slice(0, 12)
}

async function candidateFiles(
  symbol: string,
  scope: string | undefined,
  cwd: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const args = ['--hidden', '-l', '-w', '-F']
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push('--glob', `!${dir}`)
  }
  if (scope) {
    for (const pattern of scope.split(SCOPE_SEPARATOR_RE).filter(Boolean)) {
      args.push('--glob', pattern)
    }
  }
  args.push('--', symbol)
  const out = await ripGrep(args, cwd, abortSignal)
  return out.filter(Boolean).sort()
}

/** `mtimeMs:size` per candidate — cheap enough to take on every call. */
function stampFiles(paths: string[]): Map<string, string> {
  const stamps = new Map<string, string>()
  for (const path of paths) {
    try {
      const stat = statSync(path)
      stamps.set(path, `${stat.mtimeMs}:${stat.size}`)
    } catch (e) {
      // Vanished between ripgrep and here. Expected under concurrent edits;
      // anything else is worth a log line.
      if (!isENOENT(e)) logError(e)
      stamps.set(path, GONE_STAMP)
    }
  }
  return stamps
}

function sameStamps(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [path, stamp] of a) {
    if (b.get(path) !== stamp) return false
  }
  return true
}

/**
 * Discovers every rename site for `symbol`. Reads candidate files from disk —
 * their content never reaches the model, only the one-line summaries built
 * from it.
 */
export async function findSites(params: {
  symbol: string
  scope?: string
  /** Search root; defaults to the session's working directory. */
  cwd?: string
  abortSignal: AbortSignal
}): Promise<FindSitesResult> {
  const { symbol, scope, abortSignal } = params
  const cwd = params.cwd ?? getCwd()

  const files = await candidateFiles(symbol, scope, cwd, abortSignal)
  if (files.length > MAX_FILES) {
    throw new Error(
      `Rename: "${symbol}" appears in ${files.length} files, over the ${MAX_FILES}-file limit. Narrow it with \`scope\`.`,
    )
  }

  const memoKey = [cwd, symbol, scope ?? ''].join('\u0000')
  const stamps = stampFiles(files)
  const now = Date.now()
  const cached = discoveryMemo.get(memoKey)
  if (cached && now - cached.at <= MEMO_TTL_MS && sameStamps(cached.stamps, stamps)) {
    return cached.result
  }

  const sites: RenameSite[] = []
  const touched: string[] = []
  const unreadable: string[] = []
  let skippedMasked = 0

  for (const absPath of files) {
    // Throw rather than break: a truncated site list is indistinguishable
    // from a complete one downstream, and `runRename` would apply it as if
    // the whole tree had been scanned.
    if (abortSignal.aborted) throw new AbortError()
    let source: string
    try {
      const read = readFileForStaging(absPath)
      if (!read.fileExists) {
        unreadable.push(relative(cwd, absPath))
        continue
      }
      source = read.content
    } catch (e) {
      logError(e)
      unreadable.push(relative(cwd, absPath))
      continue
    }

    const lang = detectOutlineLangFromPath(absPath)
    const { offsets, maskedOut, hadMask } = scanFileForSites(source, symbol, lang)
    skippedMasked += maskedOut
    if (offsets.length === 0) continue

    const entries =
      lang && source.length <= SCAN_MAX_BYTES ? scanSymbols(source, lang) : []
    const relPath = relative(cwd, absPath) || absPath
    touched.push(absPath)

    const starts = lineStarts(source)
    for (const offset of offsets) {
      const { line, lineText } = locate(source, starts, offset)
      sites.push({
        id: '',
        absPath,
        relPath,
        line,
        offset,
        lineText,
        symbol: enclosingSymbol(entries, line),
        unparsed: !hadMask,
      })
    }
  }

  if (sites.length > MAX_SITES) {
    throw new Error(
      `Rename: "${symbol}" has ${sites.length} sites, over the ${MAX_SITES}-site limit. Narrow it with \`scope\`.`,
    )
  }

  // ripgrep already sorted the files; within a file the scan is left-to-right,
  // so ids are assigned in a deterministic path-then-position order.
  sites.forEach((site, i) => {
    site.id = siteId(i, sites.length)
  })

  const result: FindSitesResult = {
    sites,
    files: touched,
    skippedMasked,
    unreadable,
    sitesToken: computeToken(sites),
  }

  for (const [key, entry] of discoveryMemo) {
    if (now - entry.at > MEMO_TTL_MS) discoveryMemo.delete(key)
  }
  discoveryMemo.set(memoKey, { stamps, result, at: now })
  return result
}
