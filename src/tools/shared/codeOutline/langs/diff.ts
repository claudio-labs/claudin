// Unified-diff scanner — one symbol per file section, one nested symbol per
// hunk.
//
// Why a diff is an outline language at all: the 2026-09-10 census found the
// largest single Reads of the period were `git show` output the model had
// piped into `/tmp/*.diff` and then read whole (47k, 30k, 27k chars — ~14k
// tokens each, carried by every later call). A diff has a natural index — its
// files — and the auto-pivot already knows how to serve one: the file rows
// below become `Read(symbol='<path>')` targets, and a file section long
// enough to trip the symbol pivot is answered with its hunks.
//
// Sections are split the way `src/tools/GitTool/parsers/diff.ts` splits them,
// on `diff --git`, with the same headerless fallback (the Bash output filter
// strips that header line, leaving `--- a/x` / `+++ b/x` as the only
// boundary). The add/remove counts are counted off the raw lines for the same
// reason that module does it: a stat that lies is worse than none.

import { MAX_SIGNATURE_CHARS } from 'src/tools/shared/codeOutline/internal.js'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/types.js'

const RE_FILE_HEADER = /^diff --git (?:a\/|.\/)?(.+?) (?:b\/|.\/)?(.+)$/
const RE_PLUS_HEADER = /^\+\+\+ (?:[a-z]\/)?(.+)$/
const RE_MINUS_HEADER = /^--- /
const RE_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

type Section = { start: number; path: string }

/**
 * Line index of every file section start, with the path it belongs to.
 *
 * A `diff --git` line always wins. Without one, a `--- ` line whose NEXT line
 * is `+++ ` opens a section — the two-line pair is what keeps a removed
 * content line that happens to start with `--- ` from becoming a phantom
 * file, the same rule `summarizeHeaderlessSection` applies.
 */
function findSections(lines: readonly string[], lineCount: number): Section[] {
  const sections: Section[] = []
  const hasGitHeaders = lines.some(l => l.startsWith('diff --git '))
  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    if (hasGitHeaders) {
      const m = RE_FILE_HEADER.exec(line)
      if (m) sections.push({ start: L, path: m[2] ?? m[1] ?? '' })
      continue
    }
    if (!RE_MINUS_HEADER.test(line)) continue
    const plus = lines[L + 1] === undefined ? null : RE_PLUS_HEADER.exec(lines[L + 1]!)
    if (!plus?.[1]) continue
    sections.push({ start: L, path: plus[1] })
  }
  return sections
}

function clip(signature: string): string {
  return signature.length > MAX_SIGNATURE_CHARS
    ? signature.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
    : signature
}

export function scanDiff(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  // Phantom empty element from a trailing newline — mirror the caller's
  // cat -n line accounting so the last section's endLine stays real.
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  const sections = findSections(lines, lineCount)
  const out: SymbolEntry[] = []
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!
    const end = s + 1 < sections.length ? sections[s + 1]!.start - 1 : lineCount - 1

    let added = 0
    let removed = 0
    const hunks: SymbolEntry[] = []
    for (let L = section.start; L <= end; L++) {
      const line = lines[L]!
      if (RE_HUNK_HEADER.test(line)) {
        // Close the previous hunk on the line before this header.
        const prev = hunks[hunks.length - 1]
        if (prev) prev.endLine = L
        hunks.push({
          name: line.slice(0, line.indexOf('@@', 3) + 2),
          kind: 'hunk',
          signature: clip(line.trim()),
          startLine: L + 1,
          endLine: end + 1,
          depth: 1,
        })
        continue
      }
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }

    out.push({
      name: section.path,
      kind: 'file',
      signature: clip(
        `${section.path}  +${added}/-${removed}` +
          (hunks.length > 0 ? ` (${hunks.length} hunk${hunks.length === 1 ? '' : 's'})` : ''),
      ),
      startLine: section.start + 1,
      endLine: end + 1,
      depth: 0,
    })
    out.push(...hunks)
  }
  return out
}
