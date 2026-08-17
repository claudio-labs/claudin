/**
 * Extracts the checkable claims a rule file makes *inside* a fenced block.
 *
 * `rulesLint.ts` sees prose only: its extractor walks single-backtick spans
 * (`INLINE_CODE_RE`), and a Module Map is a fenced tree whose lines carry no
 * backticks at all. That blind region is where a navigation rule keeps its most
 * load-bearing and most perishable statements — which directories exist, how
 * many files each holds, which file defines which symbol, how big a file is.
 * An audit of this repo's map scored 183 claims at 97.3% and found all five
 * errors in there.
 *
 * Everything here is pure: markdown in, claims out. Resolution against the tree
 * lives in `rulesLint.ts` (report) and `rulesMapSync.ts` (heal), so both
 * directions read the map through one grammar and cannot disagree about what
 * the file says.
 */

/** A path named inside a fenced block, with where it was found. */
export type FencedPathClaim = {
  path: string
  line: string
  lineNumber: number
}

/** `dir/ (N)` — a directory and the file count claimed for it. */
export type DirCountClaim = {
  path: string
  claimed: number
  line: string
  lineNumber: number
}

/** `file.ts (symA, symB)` — symbols claimed to live in a file. */
export type SymbolAttributionClaim = {
  file: string
  symbols: string[]
  line: string
  lineNumber: number
}

/** `file.ts (…, ~2.2k lines)` — a size claimed for a file. */
export type LineCountClaim = {
  file: string
  claimed: number
  line: string
  lineNumber: number
}

export type RuleClaims = {
  fencedPaths: FencedPathClaim[]
  dirCounts: DirCountClaim[]
  attributions: SymbolAttributionClaim[]
  lineCounts: LineCountClaim[]
}

/**
 * Fence languages whose contents are illustrations, not claims. A `typescript`
 * block shows how to write something and cites paths that need not exist; a
 * bare or `bash` block in a navigation rule is the map and the commands that
 * walk it.
 */
const CODE_FENCE_LANGS = new Set([
  'typescript',
  'ts',
  'tsx',
  'javascript',
  'js',
  'jsx',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'diff',
  'python',
  'go',
  'rust',
])

const FENCE_RE = /^\s*```(\S*)/

/**
 * A tree entry line. The `├──`/`└──` marker is required and is half the reason
 * this parser is safe: an annotation that wraps onto the next line carries no
 * marker, so `│   │        agent/context.ts, terminal/contexts/` stays prose
 * instead of becoming two children of whatever opened the level.
 */
const TREE_ENTRY_RE = /^((?:[│|]\s{0,4}|\s{4}|\s{2})*)(?:├──|└──|├─|└─|\|--)\s*/
/** One indentation level, in the same alternation the entry regex consumes. */
const TREE_INDENT_UNIT_RE = /[│|]\s{0,4}|\s{4}|\s{2}/g
/** The `src/` line that opens a tree, before any marker appears. */
const TREE_ROOT_RE = /^((?:[\w.@-]+\/)+)\s*$/
/**
 * The `←` gloss. Everything after it describes the entry in prose and names
 * files by their own name rather than relative to the tree, so tokenizing it
 * turns `← model.ts (…)` under `providers/` into `src/providers/model.ts`.
 */
export const TREE_ANNOTATION_RE = /\s*(?:←|<-|<--)\s*/

/** A directory token inside a tree entry. */
const DIR_TOKEN_RE = /^[\w.@-]+\/$/
/** A file token inside a tree entry. */
const FILE_TOKEN_RE = /^[\w.@-]*[\w-]\.[a-zA-Z]\w{0,3}$/
/** The `(N)` file count attached to the token before it. */
const COUNT_TOKEN_RE = /^\((\d[\d,]*)\)$/

/**
 * A filename and the parenthetical attached to it — `REPL.tsx (3160 lines)`,
 * `model.ts (getPrimaryModel, getContextWindowForModel)`.
 *
 * Attachment is the whole guard against reading prose as a claim. Associating a
 * number with the nearest filename to its left read "*eight lines of a
 * 2,200-line file*" — a sentence about whatever file the agent happens to open
 * — as a claim about the `FileReadTool.ts` cited earlier on the line. Requiring
 * the number to sit in the parenthetical the filename itself opens costs one
 * true claim written as running prose and removes the false one.
 */
const ANNOTATED_FILE_RE =
  /((?:[\w.@-]+\/)*[\w.@-]*[\w-]\.[a-zA-Z]\w{0,3})`?\s*\(([^()\n]*)\)/g
/** `(3160 lines)`, `~2.2k lines` — inside that parenthetical. */
const LINE_COUNT_RE = /~?(\d[\d,]*(?:\.\d+)?)\s*(k?)[-\s]lines?\b/i
/** A single member of an attribution list. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
/**
 * An identifier a human would not write as a plain English gloss. Without it,
 * `activeProvider.ts (resolver)` reads as a symbol claim; with it,
 * `providers.ts (getAPIProvider)` still does and the gloss does not.
 */
const CODE_SHAPED_RE = /[a-z][A-Z]|_/

type ScannedLine = { text: string; number: number; fence: string | null }

/** Splits content into lines tagged with the fence language enclosing them. */
function scanLines(content: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let fence: string | null = null
  content.split('\n').forEach((text, index) => {
    const fenceMatch = FENCE_RE.exec(text)
    if (fenceMatch) {
      fence = fence === null ? (fenceMatch[1] ?? '') : null
      return
    }
    lines.push({ text, number: index + 1, fence })
  })
  return lines
}

/** The path-ish tokens on the entry side of a tree line, in order. */
function treeEntryTokens(entry: string): string[] {
  return entry
    .split(/\s+/)
    .map(token => token.replace(/[,;]+$/, ''))
    .filter(token => token.length > 0)
}

/**
 * How many levels an entry's indent represents.
 *
 * Counts the units the entry regex itself consumed rather than dividing by a
 * fixed width: the alternation accepts a two-space level as readily as a
 * four-space one, so a constant divisor halved the depth of every two-space
 * tree and reported each of its children as a missing path.
 */
function indentDepth(indent: string): number {
  return indent.match(TREE_INDENT_UNIT_RE)?.length ?? 0
}

/**
 * Walks the fenced trees, joining each entry to the parent its indentation puts
 * it under, and reading the `(N)` counts off the entry side.
 */
function collectTreeClaims(
  lines: ScannedLine[],
  fencedPaths: FencedPathClaim[],
  dirCounts: DirCountClaim[],
): void {
  let root = ''
  // prefixes[d] is the path every entry at depth d hangs off.
  let prefixes: string[] = []

  for (const { text, number, fence } of lines) {
    if (fence === null || CODE_FENCE_LANGS.has(fence)) continue

    const rootMatch = TREE_ROOT_RE.exec(text)
    if (rootMatch?.[1] !== undefined) {
      root = rootMatch[1]
      prefixes = []
      continue
    }

    const entryMatch = TREE_ENTRY_RE.exec(text)
    if (!entryMatch) continue

    const depth = indentDepth(entryMatch[1] ?? '')
    const parent = prefixes[depth] ?? root
    const entry =
      text.slice(entryMatch[0].length).split(TREE_ANNOTATION_RE)[0] ?? ''

    // Only the FIRST directory on an entry line becomes the parent of the
    // deeper lines under it: `contexts/ (9) state/ (8)` names two siblings, not
    // a nesting.
    let childPrefixSet = false
    let pendingDir: string | null = null

    for (const token of treeEntryTokens(entry)) {
      const countMatch = COUNT_TOKEN_RE.exec(token)
      if (countMatch?.[1] !== undefined && pendingDir !== null) {
        dirCounts.push({
          path: pendingDir,
          claimed: Number(countMatch[1].replace(/,/g, '')),
          line: text,
          lineNumber: number,
        })
        pendingDir = null
        continue
      }
      pendingDir = null

      const isDir = DIR_TOKEN_RE.test(token)
      if (!isDir && !FILE_TOKEN_RE.test(token)) continue

      const path = parent + token
      fencedPaths.push({ path, line: text, lineNumber: number })
      if (!isDir) continue

      pendingDir = path
      if (!childPrefixSet) {
        prefixes[depth + 1] = path
        childPrefixSet = true
      }
    }

    // A deeper level always re-derives from the entry that opened it.
    prefixes.length = Math.min(prefixes.length, depth + 2)
  }
}

/** Reads the size and symbol claims a line attaches to a filename. */
function collectAnnotatedClaims(
  lines: ScannedLine[],
  lineCounts: LineCountClaim[],
  attributions: SymbolAttributionClaim[],
): void {
  for (const { text, number, fence } of lines) {
    if (fence !== null && CODE_FENCE_LANGS.has(fence)) continue

    for (const match of text.matchAll(ANNOTATED_FILE_RE)) {
      const file = match[1]
      const inner = match[2]
      if (file === undefined || inner === undefined) continue

      const size = LINE_COUNT_RE.exec(inner)
      if (size?.[1] !== undefined) {
        const scale = size[2]?.toLowerCase() === 'k' ? 1000 : 1
        const claimed = Math.round(Number(size[1].replace(/,/g, '')) * scale)
        if (Number.isFinite(claimed) && claimed > 0) {
          lineCounts.push({ file, claimed, line: text, lineNumber: number })
        }
        continue
      }

      const symbols = inner.split(',').map(s => s.trim())
      if (symbols.length === 0 || symbols.some(s => s.length === 0)) continue
      if (!symbols.every(s => IDENTIFIER_RE.test(s) && CODE_SHAPED_RE.test(s))) {
        continue
      }
      attributions.push({ file, symbols, line: text, lineNumber: number })
    }
  }
}

/** Every claim a rule file makes that can be checked against the tree. */
export function extractRuleClaims(content: string): RuleClaims {
  const lines = scanLines(content)
  const claims: RuleClaims = {
    fencedPaths: [],
    dirCounts: [],
    attributions: [],
    lineCounts: [],
  }
  collectTreeClaims(lines, claims.fencedPaths, claims.dirCounts)
  collectAnnotatedClaims(lines, claims.lineCounts, claims.attributions)
  return claims
}

/**
 * Resolves a name written the way a map writes it — usually a bare basename —
 * to the one tracked file it can mean. Ambiguity returns null and the claim is
 * skipped: two files called `context.ts` make "which one is 82 lines" a
 * question the map did not answer, and guessing invents a finding.
 */
export function resolveUniqueBasename(
  tracked: readonly string[],
  name: string,
): string | null {
  if (name.includes('/')) {
    return tracked.includes(name) ? name : null
  }
  let found: string | null = null
  for (const file of tracked) {
    if (!file.endsWith(`/${name}`) && file !== name) continue
    if (found !== null) return null
    found = file
  }
  return found
}

/** Tracked files under a directory, recursively, restricted to `extensions`. */
export function countTrackedSources(
  tracked: readonly string[],
  dir: string,
  extensions: readonly string[],
): number {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return tracked.filter(
    file =>
      file.startsWith(prefix) &&
      extensions.some(extension => file.endsWith(extension)),
  ).length
}

/**
 * Extensions that are tracked, and often numerous, but are not what a
 * navigation map is counting. Keeping them out is what stops `__tests__/ (612)`
 * from meaning "590 snapshots", and what stops a repo's `docs/` tree from
 * outweighing its source.
 */
const NON_CODE_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.mod',
  '.ini',
  '.cfg',
  '.lock',
  '.snap',
  '.csv',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.pdf',
  '.pem',
  '.exe',
  '.bin',
  '.wasm',
  '.map',
])

/** Share of the counted files the chosen extensions have to cover. */
const EXTENSION_COVERAGE_TARGET = 0.9
/** A long tail below this share is noise, not a language. */
const EXTENSION_MIN_SHARE = 0.02
/** No repo needs more than this many to describe what it is written in. */
const MAX_EXTENSIONS = 6

/** Lowercased extension of a path, or null when it has none. */
function extensionOf(file: string): string | null {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return base.slice(dot).toLowerCase()
}

function histogram(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const extension = extensionOf(file)
    if (extension === null) continue
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return counts
}

function topExtensions(counts: Map<string, number>): string[] {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  if (total === 0) return []
  const ranked = [...counts].sort(([, a], [, b]) => b - a)

  const chosen: string[] = []
  let covered = 0
  for (const [extension, count] of ranked) {
    if (chosen.length >= MAX_EXTENSIONS) break
    if (chosen.length > 0 && count / total < EXTENSION_MIN_SHARE) break
    chosen.push(extension)
    covered += count
    if (covered / total >= EXTENSION_COVERAGE_TARGET) break
  }
  return chosen
}

/**
 * The extensions a project is actually written in, derived from its tracked
 * files rather than assumed.
 *
 * This is what makes the map portable: the counts in this repo's map are
 * `.ts`/`.tsx` because that is what 98.9% of its code is, and the same function
 * gives `.py` for a Python repo and `.go` for a Go one with nothing configured.
 * A repo with no code at all falls back to whatever it does hold, so a docs
 * repo still gets counts instead of a map full of zeros.
 */
export function dominantSourceExtensions(
  tracked: readonly string[],
): string[] {
  const code = tracked.filter(file => {
    const extension = extensionOf(file)
    return extension !== null && !NON_CODE_EXTENSIONS.has(extension)
  })
  const fromCode = topExtensions(histogram(code))
  return fromCode.length > 0 ? fromCode : topExtensions(histogram(tracked))
}

/**
 * Whether a `(N)` count has moved enough to be worth reporting or rewriting.
 *
 * Relative, with a floor, and deliberately loose. The counts self-declare as
 * approximate and 9 of the 55 in this repo's map had drifted within two days of
 * being measured — none by more than 1.2%. An exact ratchet over numbers nobody
 * re-measures is a permanently red check, and a permanently red check gets
 * deleted. What survives this threshold is a slice that died, moved or doubled.
 */
export function dirCountDrifted(claimed: number, actual: number): boolean {
  return Math.abs(actual - claimed) > Math.max(3, claimed * 0.1)
}

/**
 * Whether a size claim is wrong in the way that misleads. `~2.2k lines` against
 * a 1,500-line file is the prose working as intended; against a 51-line barrel
 * it sends the reader to budget an afternoon for a re-export.
 */
export function lineCountDrifted(claimed: number, actual: number): boolean {
  return actual * 2 < claimed || claimed * 2 < actual
}
