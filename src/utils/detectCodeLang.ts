/**
 * Content-based source-code language detection for the tool-result summarizer's
 * `code-outline` strategy. The summarizer call site has no filename (only the
 * output text + tool name — the Bash command never reaches it), so the language
 * is inferred from the content via per-language anchor patterns. Pure,
 * deterministic, no I/O — bun-test-loadable.
 *
 * Conservative by design: it must reject prose, unified diffs, logs, grep
 * output and JSON (the strategy falls through to head/tail when this returns
 * null). The cost of a false negative is the status-quo head/tail; the cost of
 * a false positive is a garbage outline, so the gates lean toward null.
 */
import type { OutlineLang } from 'src/tools/shared/codeOutline/scanSymbols.js'

// A uniform numeric line-number prefix as emitted by `cat -n` ("   12<TAB>"),
// `grep -n` ("12:"), or a Read-style gutter ("12→"). Stripping it lets
// scanSymbols' line-anchored patterns match. It strips one prefix per existing
// line, so line COUNT/positions are unchanged. Outline ranges are derived from
// those dump POSITIONS (1, 2, 3, …), so they equal the real file line numbers
// only when the dump is numbered from 1 and unbroken — the `cat -n` signature.
// stripLineNumberPrefix enforces that (start == 1 AND strictly consecutive); a
// `grep -n` (sparse, or a consecutive block at an offset like lines 50-67) is
// left untouched so it fails detection rather than emitting an outline whose
// ranges point at the wrong source lines.
// The capture group is the line number (used by the start/consecutiveness
// check); the separator is the `[:\t→]` itself. Do NOT also consume a following
// space — that space belongs to the code's own indentation (`cat -n` uses a tab,
// grep `-n` uses a bare colon), and eating it would shift the body left.
const LINE_NUMBER_PREFIX_RE = /^[ \t]*(\d+)[:\t→]/

// Only strip when the prefix is *uniform* across the dump (cat -n / grep -n),
// never when a few normal code lines happen to begin with a number.
const PREFIX_MIN_FRACTION = 0.8

/**
 * Strips a uniform numeric line-number prefix from a `cat -n` dump. Returns the
 * input unchanged when fewer than {@link PREFIX_MIN_FRACTION} of non-blank lines
 * are prefixed, or when the numbers are not a 1-based unbroken run (any `grep -n`
 * output, whose dump positions would not equal the real file line numbers).
 * Never changes the number of lines.
 */
export function stripLineNumberPrefix(lines: string[]): string[] {
  let nonBlank = 0
  let prefixed = 0
  const nums: number[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    nonBlank++
    const m = LINE_NUMBER_PREFIX_RE.exec(line)
    if (m) {
      prefixed++
      nums.push(Number(m[1]))
    }
  }
  if (nonBlank === 0 || prefixed / nonBlank < PREFIX_MIN_FRACTION) return lines
  // Alignment gate. scanSymbols re-derives line numbers from POSITIONS in the
  // stripped dump (1, 2, 3, …), so the outline ranges equal the real file lines
  // only when the dump is numbered from 1 and unbroken — the `cat -n` signature.
  //   • start ≠ 1     → a `grep -n` block at an offset (e.g. lines 50-67);
  //     stripping it would emit ranges off by (firstLine − 1).
  //   • non-consecutive → a sparse `grep -n` (matches with gaps); scanSymbols
  //     would also stitch non-adjacent lines into bogus signatures.
  // In either case leave the dump untouched so detection fails on the remaining
  // `NN:` prefixes and the result falls through to head/tail.
  if (nums[0] !== 1) return lines
  for (let i = 1; i < nums.length; i++) {
    const prev = nums[i - 1]!
    const cur = nums[i]!
    if (cur !== prev + 1) return lines
  }
  return lines.map(line => line.replace(LINE_NUMBER_PREFIX_RE, ''))
}

type LangAnchors = { lang: OutlineLang; re: RegExp }

// Line-anchored "this line declares/imports/headers something" patterns per
// language. Every alternative is `^\s*`-anchored so (a) each source line yields
// at most one match (clean per-line counting) and (b) diff lines (`+export…`),
// grep `path:line:` output and prose with a stray mid-line keyword all score ~0.
// TS and JS collapse to 'typescript' (scanSymbols parses JS fine as a TS subset).
const ANCHORS: LangAnchors[] = [
  {
    lang: 'typescript',
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\b|class\b|interface\b|enum\b|const\b|let\b|var\b|type\s+\w+\s*=)|^\s*export\s*\{|^\s*import\s+[\w*{]/gm,
  },
  {
    lang: 'python',
    re: /^\s*(?:async\s+)?def\s|^\s*class\s|^\s*from\s+\S+\s+import\s|^\s*import\s+\w|^#!.*\bpython/gm,
  },
  {
    lang: 'go',
    re: /^\s*package\s|^\s*func\s|^\s*type\s+\w+\s+(?:struct|interface)\b|^\s*import\s*\(/gm,
  },
  {
    lang: 'rust',
    re: /^\s*(?:pub\s+)?(?:async\s+)?(?:fn\s|struct\s|enum\s|trait\s|impl\b|mod\s|use\s)/gm,
  },
  {
    lang: 'java',
    re: /^\s*package\s+[\w.]+;|^\s*import\s+[\w.]+;|^\s*(?:public|private|protected)\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|enum)\b/gm,
  },
  {
    lang: 'kotlin',
    re: /^\s*(?:fun\s|class\s|object\s|interface\s|val\s|var\s|package\s|import\s)/gm,
  },
  {
    lang: 'csharp',
    re: /^\s*using\s+[\w.]+;|^\s*namespace\s|^\s*(?:public|private|protected|internal)\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|struct|enum)\b/gm,
  },
]

// Unified-diff markers (`git show <sha>`, `git diff`). A diff's context lines
// carry a single leading space, which `^\s*`-anchored code patterns would eat
// and mis-score as source — so a diff is rejected outright before scoring.
const DIFF_MARKER_RE = /^(?:@@ |diff --git |index [0-9a-f]{7,}|\+\+\+ |--- )/gm
const DIFF_MARKER_MIN = 2

// A single proper hunk header is unmistakable on its own — real source never
// contains `@@ -N,M +N,M @@`. One is enough to reject, which catches a
// truncated/streamed diff that lost its git header (and so carries fewer than
// DIFF_MARKER_MIN of the weaker markers above) yet whose space-prefixed context
// lines would otherwise score as code.
const DIFF_HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m

// Minimum absolute declaration/import lines to consider the blob "code" — keeps
// a short snippet (a few stray keywords) below the bar.
const MIN_ANCHORS = 4
// Minimum declaration-line density (matches / non-blank lines) — rejects prose
// or a huge log that happens to contain a handful of keyword-shaped lines.
const DENSITY_MIN = 0.05

/**
 * Sniffs the source language of a whole text blob, or null if it does not look
 * like a single source file. Excludes markdown (whole-text markdown is a prose
 * page, not code). Pick the highest-scoring language; gate on absolute count and
 * density so prose/diffs/logs/JSON fall through.
 */
export function detectCodeLang(text: string): OutlineLang | null {
  if (!text) return null
  if (DIFF_HUNK_HEADER_RE.test(text)) return null
  if ((text.match(DIFF_MARKER_RE) || []).length >= DIFF_MARKER_MIN) return null
  const lines = text.split('\n')
  let nonBlank = 0
  for (const line of lines) if (line.trim() !== '') nonBlank++
  if (nonBlank === 0) return null

  let bestLang: OutlineLang | null = null
  let bestScore = 0
  for (const { lang, re } of ANCHORS) {
    const score = (text.match(re) || []).length
    if (score > bestScore) {
      bestScore = score
      bestLang = lang
    }
  }

  if (bestScore < MIN_ANCHORS) return null
  if (bestScore / nonBlank < DENSITY_MIN) return null
  return bestLang
}
