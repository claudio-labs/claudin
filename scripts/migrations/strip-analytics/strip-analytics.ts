/**
 * Codemod: delete every analytics call site.
 *
 * All four sinks are inert in the shipped binary, and each for a different
 * reason — which is why this is a removal and not a behaviour change:
 *
 *   logEvent / logEventAsync   `scripts/build/no-telemetry-plugin.ts` replaces
 *                              `src/platform/analytics/index` with a stub whose
 *                              bodies are empty.
 *   logEventTo1P               same, for `analytics/firstPartyEventLogger`.
 *   logOTelEvent               not stubbed, but it returns early unless
 *                              `getEventLogger()` is set, and the only two
 *                              `setEventLogger` calls live in
 *                              `telemetry/instrumentation`, which IS stubbed.
 *                              So the logger is null for the process lifetime.
 *
 * `build.ts` already blanks the `tengu_*` name passed to the first two, and the
 * bundle currently holds ZERO `tengu_` tokens — what is left at these call
 * sites is the work of building an argument object for a function that throws
 * it away.
 *
 * WHY NOT THE TYPESCRIPT AST: this repo is on TypeScript 7, whose package
 * exposes only `version` on its default export — the classic
 * `ts.createSourceFile` is gone, and the replacement (`typescript/unstable`)
 * wants a Program and a host. So the scan is lexical, over the same
 * code/comment/string/regex character map `scripts/verify/tengu-census.ts`
 * uses, which has tests that fail when its quote or regex handling breaks.
 * Being lexical is exactly why this codemod REFUSES instead of guessing.
 *
 * Usage:
 *   bun run scripts/migrations/strip-analytics/strip-analytics.ts --dry-run
 *   bun run scripts/migrations/strip-analytics/strip-analytics.ts
 *
 * A refusal blocks the WHOLE file, never just the one call: a half-stripped
 * file with a dangling import is harder to notice than an untouched one.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REGION_CODE, REGION_COMMENT, scanRegions } from '../../verify/tengu-census'
import { REPO_ROOT } from '../../repoRoot'

/** Callees whose call sites are deleted. */
const SINKS = [
  'logEvent',
  'logEventAsync',
  'logEventTo1P',
  'logOTelEvent',
] as const

/** Imported names that exist only to type an argument of those calls. */
const MARKER_TYPES = [
  'AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS',
  'AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED',
] as const

const PRUNABLE = new Set<string>([...SINKS, ...MARKER_TYPES])

export type Refusal = {
  file: string
  line: number
  /**
   * - `expression-position`: the call is a value, not a statement. Deleting it
   *   changes what the surrounding expression evaluates to.
   * - `member-call`: reached through a property (`m.logEvent(…)`), so the
   *   binding is not the import this codemod reasons about.
   * - `empties-block`: the call is the last thing in its block. An emptied
   *   `catch` is banned by .claudin/rules/typescript-patterns.md.
   * - `unterminated`: the argument list never closes — a scanner failure.
   */
  kind: 'expression-position' | 'member-call' | 'empties-block' | 'unterminated'
  detail: string
}

export type FileResult = {
  file: string
  calls: number
  specifiers: number
  /** Rewritten text, or null when nothing changed OR the file was refused. */
  text: string | null
  refusals: Refusal[]
}

type Range = { start: number; end: number }

const IDENT_RE = /[A-Za-z0-9_$]/

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/**
 * Previous index holding a character that matters to the grammar, or -1.
 *
 * Whitespace AND comments are skipped: a call written under its own explanatory
 * comment is still the first thing in its statement, and stopping on the
 * comment's last letter would misread it as expression position.
 */
function prevNonSpace(
  source: string,
  from: number,
  regions?: Uint8Array,
): number {
  let i = from
  for (;;) {
    while (i >= 0 && /\s/.test(source[i]!)) i--
    if (i >= 0 && regions && regions[i] === REGION_COMMENT) {
      i--
      continue
    }
    return i
  }
}

/** Characters that can only continue an expression, never end a statement. */
const CONTINUATION = new Set([
  ',', '.', '+', '-', '*', '/', '%', '=', '<', '>', '&', '|', '^', '!', '~',
  '?', ':', '(', '[',
])

/** Keywords that make whatever follows them part of an expression. */
const CONTINUATION_KEYWORD =
  /(?:^|[^A-Za-z0-9_$])(return|yield|throw|case|else|do|try|finally|new|typeof|in|of|instanceof|delete|export|extends|default)$/

/** Heads whose unbraced body is a single statement we must not orphan. */
const UNBRACED_HEAD = /(?:^|[^A-Za-z0-9_$])(if|while|for|switch|catch|with)$/

/** Index of the bracket opening the one that closes at `close`, or -1. */
function matchBracketBackward(
  source: string,
  regions: Uint8Array,
  close: number,
): number {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    if (regions[i] !== REGION_CODE) continue
    const c = source[i]
    if (c === ')' || c === ']' || c === '}') depth++
    else if (c === '(' || c === '[' || c === '{') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Where the statement wrapping a sink call begins, or null when the call sits
 * in expression position.
 *
 * The decision is what precedes it. `;`, `{` and `}` end a statement outright.
 * A newline also ends one — this tree omits semicolons in most files, so an
 * ASI boundary is the common case — UNLESS the previous character can only
 * continue an expression (`=`, `=>`, `&&`, `,`, `?`) or the previous word is a
 * keyword like `return`. The subtle one is a closing `)`: it ends a call
 * statement, but it also ends `if (…)`, whose unbraced body must not be
 * orphaned, so the matching `(` is checked for a statement head.
 */
function statementStart(
  source: string,
  regions: Uint8Array,
  identStart: number,
): number | null {
  let start = identStart
  for (;;) {
    const prev = prevNonSpace(source, start - 1, regions)
    if (prev < 0) return start
    if (regions[prev] !== REGION_CODE) return null

    const lookback = source.slice(Math.max(0, prev - 12), prev + 1)
    // `await f()` and `void f()` are still statements — step over the keyword.
    const stepOver = /(?:^|[^A-Za-z0-9_$])(await|void)$/.exec(lookback)
    if (stepOver) {
      start = prev - stepOver[1]!.length + 1
      continue
    }

    const c = source[prev]!
    if (c === ';' || c === '{' || c === '}') return start

    const newlineBetween = source.slice(prev + 1, start).includes('\n')
    if (!newlineBetween) return null
    if (CONTINUATION.has(c)) return null
    if (IDENT_RE.test(c) && CONTINUATION_KEYWORD.test(lookback)) return null
    if (c === ')') {
      const open = matchBracketBackward(source, regions, prev)
      if (open < 0) return null
      const head = source.slice(Math.max(0, open - 12), open)
      if (UNBRACED_HEAD.test(head.trimEnd())) return null
    }
    return start
  }
}

/** Offset just past the bracket that closes the one opened at `open`. */
function matchBracket(
  source: string,
  regions: Uint8Array,
  open: number,
): number | null {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (regions[i] !== REGION_CODE) continue
    const c = source[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * Widen a statement range to take the comment block written directly above it
 * and the rest of its last line — otherwise a removed call strands its own
 * explanation over unrelated code.
 */
function widen(
  source: string,
  regions: Uint8Array,
  start: number,
  end: number,
): Range {
  let e = end
  while (e < source.length && /[ \t;]/.test(source[e]!)) e++
  if (e < source.length && source[e] === '\r') e++
  if (e < source.length && source[e] === '\n') e++

  let s = start
  while (s > 0 && source[s - 1] !== '\n') {
    // Something else shares this line — keep the range tight.
    if (!/\s/.test(source[s - 1]!)) return { start, end: e }
    s--
  }
  for (;;) {
    if (s === 0) break
    const lineEnd = s - 1
    let lineStart = lineEnd
    while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--
    if (source.slice(lineStart, lineEnd).trim() === '') break
    let allComment = true
    for (let i = lineStart; i < lineEnd; i++) {
      if (/\s/.test(source[i]!)) continue
      if (regions[i] === REGION_CODE) {
        allComment = false
        break
      }
    }
    if (!allComment) break
    s = lineStart
  }
  return { start: s, end: e }
}

function inAnyRange(ranges: Range[], offset: number): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return true
  }
  return false
}

/**
 * The source line that opens the block containing `range`, trimmed.
 *
 * This is what a reviewer needs to decide whether the enclosing statement can
 * go too: `if (Math.random() < 0.05) {` is safe to drop whole, whereas
 * `if (await claim()) {` is not, and only the text says which one it is.
 */
function blockHead(source: string, regions: Uint8Array, range: Range): string {
  let depth = 0
  for (let i = range.start - 1; i >= 0; i--) {
    if (regions[i] !== REGION_CODE) continue
    const c = source[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        let lineStart = i
        while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--
        return source.slice(lineStart, i + 1).trim()
      }
      depth--
    }
  }
  return '<top level>'
}

/**
 * Does the block containing `range` still hold code once every removal lands?
 * Finds the enclosing `{ … }` by balancing braces outward from the range.
 */
function blockSurvives(
  source: string,
  regions: Uint8Array,
  range: Range,
  removals: Range[],
): boolean {
  let depth = 0
  let open = -1
  for (let i = range.start - 1; i >= 0; i--) {
    if (regions[i] !== REGION_CODE) continue
    const c = source[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    }
  }
  if (open < 0) return true // top level — nothing to empty

  const close = matchBracket(source, regions, open)
  if (close === null) return true

  for (let i = open + 1; i < close - 1; i++) {
    if (regions[i] !== REGION_CODE) continue
    if (/\s/.test(source[i]!)) continue
    if (inAnyRange(removals, i)) continue
    return true
  }
  return false
}

function applyRemovals(source: string, removals: Range[]): string {
  const sorted = [...removals].sort((a, b) => b.start - a.start)
  let out = source
  for (const { start, end } of sorted) out = out.slice(0, start) + out.slice(end)
  return out
}

/** Offsets where `name` appears as a standalone identifier in code position. */
function identOccurrences(
  source: string,
  regions: Uint8Array,
  name: string,
): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const i = source.indexOf(name, from)
    if (i < 0) break
    from = i + name.length
    if (regions[i] !== REGION_CODE) continue
    if (i > 0 && IDENT_RE.test(source[i - 1]!)) continue
    const after = source[i + name.length]
    if (after !== undefined && IDENT_RE.test(after)) continue
    out.push(i)
  }
  return out
}

/** Every `import { … } from '…'` declaration in the file, as source ranges. */
const IMPORT_RE =
  /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"];?[ \t]*\r?\n?/gm

/**
 * Drop named imports of the sinks and marker types that nothing references any
 * more, and the whole declaration when that empties its clause.
 *
 * Decided against the REWRITTEN text: a marker cast that survives on some
 * unrelated call has to keep its type import.
 */
function pruneImports(source: string): { text: string; dropped: number } {
  const regions = scanRegions(source)
  const edits: Array<{ range: Range; replacement: string }> = []
  let dropped = 0

  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(source)) !== null) {
    if (regions[m.index] !== REGION_CODE) continue
    const declStart = m.index
    const declEnd = m.index + m[0].length
    const open = declStart + m[0].indexOf('{')
    const close = declStart + m[0].indexOf('}')

    const keep: string[] = []
    let localDropped = 0
    for (const raw of m[1]!.split(',')) {
      const spec = raw.trim()
      if (spec === '') continue
      const local = (spec.split(/\s+as\s+/).pop() ?? spec)
        .replace(/^type\s+/, '')
        .trim()
      // Count references OUTSIDE this declaration's brace list.
      const used = identOccurrences(source, regions, local).some(
        o => o < open || o > close,
      )
      if (PRUNABLE.has(local) && !used) localDropped++
      else keep.push(spec)
    }
    if (localDropped === 0) continue
    dropped += localDropped

    if (keep.length === 0) {
      edits.push({ range: { start: declStart, end: declEnd }, replacement: '' })
    } else {
      edits.push({
        range: { start: open + 1, end: close },
        replacement: keep.length > 3 ? `\n  ${keep.join(',\n  ')},\n` : ` ${keep.join(', ')} `,
      })
    }
  }

  const sorted = [...edits].sort((a, b) => b.range.start - a.range.start)
  let out = source
  for (const { range, replacement } of sorted) {
    out = out.slice(0, range.start) + replacement + out.slice(range.end)
  }
  return { text: out, dropped }
}

export function transform(fileName: string, source: string): FileResult {
  const rel = relative(REPO_ROOT, fileName)
  const nothing: FileResult = {
    file: rel,
    calls: 0,
    specifiers: 0,
    text: null,
    refusals: [],
  }
  if (!SINKS.some(s => source.includes(s))) return nothing

  const regions = scanRegions(source)
  const refusals: Refusal[] = []
  const removals: Range[] = []

  for (const sink of SINKS) {
    for (const ident of identOccurrences(source, regions, sink)) {
      let j = ident + sink.length
      while (j < source.length && /\s/.test(source[j]!)) j++
      if (source[j] !== '(') continue // an import specifier or a bare reference

      const before = prevNonSpace(source, ident - 1)
      if (before >= 0 && source[before] === '.') {
        refusals.push({
          file: rel,
          line: lineAt(source, ident),
          kind: 'member-call',
          detail: `${sink} reached through a property access`,
        })
        continue
      }

      const stmtStart = statementStart(source, regions, ident)
      if (stmtStart === null) {
        refusals.push({
          file: rel,
          line: lineAt(source, ident),
          kind: 'expression-position',
          detail: `${sink}() is used as a value, not a statement`,
        })
        continue
      }

      const stmtEnd = matchBracket(source, regions, j)
      if (stmtEnd === null) {
        refusals.push({
          file: rel,
          line: lineAt(source, ident),
          kind: 'unterminated',
          detail: `argument list of ${sink}() never closes`,
        })
        continue
      }

      removals.push(widen(source, regions, stmtStart, stmtEnd))
    }
  }

  if (removals.length === 0) {
    return refusals.length > 0 ? { ...nothing, refusals } : nothing
  }

  for (const range of removals) {
    if (!blockSurvives(source, regions, range, removals)) {
      refusals.push({
        file: rel,
        line: lineAt(source, range.start),
        kind: 'empties-block',
        // Carry the head verbatim. Whether the enclosing `if` can go too turns
        // entirely on whether its condition has side effects, and that is a
        // judgement to make by reading it, not by pattern-matching it.
        detail: `empties \u2192 ${blockHead(source, regions, range)}`,
      })
    }
  }

  if (refusals.length > 0) return { ...nothing, refusals }

  const pruned = pruneImports(applyRemovals(source, removals))
  return {
    file: rel,
    calls: removals.length,
    specifiers: pruned.dropped,
    text: pruned.text,
    refusals: [],
  }
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name === '__fixtures__' || ent.name === '__snapshots__') continue
      collectSourceFiles(join(dir, ent.name), out)
      continue
    }
    if (!/\.tsx?$/.test(ent.name)) continue
    // Tests are handled by hand: several assert ON the events, so a silent
    // rewrite would turn a real assertion into a vacuous one.
    if (/\.test\.tsx?$/.test(ent.name)) continue
    out.push(join(dir, ent.name))
  }
  return out
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run')
  const files = collectSourceFiles(join(REPO_ROOT, 'src'))
  let calls = 0
  let specifiers = 0
  let touched = 0
  const refusals: Refusal[] = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const result = transform(file, source)
    refusals.push(...result.refusals)
    if (result.text === null) continue
    calls += result.calls
    specifiers += result.specifiers
    touched++
    if (!dryRun) writeFileSync(file, result.text)
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}${calls} call sites and ${specifiers} import specifiers removed across ${touched} files`,
  )
  if (refusals.length > 0) {
    console.log(`\n${refusals.length} refusal(s) — handle these by hand:`)
    for (const r of refusals) {
      console.log(`  ${r.kind.padEnd(20)} ${r.file}:${r.line}  ${r.detail}`)
    }
  }
}
