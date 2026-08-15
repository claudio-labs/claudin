import { toRelativePath } from 'src/shared/fs/path.js'

// Splits a ripgrep content line into path + line number. The path is matched
// non-greedily so the first `:<digits>:` wins — this keeps Windows drive
// letters (`C:\...`) part of the path instead of being mistaken for the
// line-number separator. Only the match form (`path:NN:`) is covered: context
// lines use `-` as the separator and are deliberately left out, so every
// caller that counts hits with this counts matches only.
//
// Lives here rather than in GrepTool.ts so autoPivot.ts can share it without
// importing the tool back (a cycle).
export const RG_LINE_RE = /^(.+?):(\d+):/

// Ripgrep prefixes every content line with the file it came from: `path:NN:text`
// for a match and `path-NN-text` for a context line (-A/-B/-C). The
// backreference pins both separators to the same character because rg never
// mixes the two forms on one line.
//
// Deliberately unanchored and global: `<sep><digits><sep>` occurs INSIDE real
// paths (`proj-2026-q1/`, `clip-pin-cache-ab-2026-07-25.md`) as readily as it
// does at the true boundary, so there is no leftmost split to trust. Taking the
// first one made every such search leak its absolute path — the guard below
// rejected the truncated candidate and the line was returned untouched.
export const RG_PREFIX_RE = /([:-])(\d+)\1/g

/**
 * Rewrites the absolute path rg emits into a cwd-relative one, for match AND
 * context lines. Splitting on the first `:` (the previous approach) silently
 * skipped every context line whose code text had no colon, leaving the full
 * absolute path in the payload.
 *
 * Every candidate split is tried left to right and the first one both guards
 * accept wins, so a path that contains its own `<sep><digits><sep>` run is
 * relativized at its real boundary instead of being skipped.
 *
 * Fail-open: a line that carries no candidate the guards accept is returned
 * untouched — a wrong path is worse than a long one.
 */
export function relativizeRgLine(line: string, searchRoot: string): string {
  for (const m of line.matchAll(RG_PREFIX_RE)) {
    const cut = m.index
    if (cut === 0) continue
    const rewritten = rewritePrefix(line, line.slice(0, cut), cut, searchRoot)
    if (rewritten !== line) return rewritten
  }
  // `-n: false` drops the line number, leaving `path:text` / `path-text`. Only
  // the colon form can be split safely (a path may legitimately contain '-'),
  // which is exactly what this function did before context lines were handled.
  const colonIndex = line.indexOf(':')
  if (colonIndex > 0) {
    return rewritePrefix(line, line.slice(0, colonIndex), colonIndex, searchRoot)
  }
  return line
}

/**
 * Swaps `candidate` for its cwd-relative form, or gives up. Two guards, both of
 * which failed open in the old implementation:
 *
 * 1. the candidate must live under the directory rg was pointed at — otherwise
 *    the split landed inside the path (a dir named `foo-12-bar` does that), and
 *    the caller moves on to the next candidate;
 * 2. relativizing must be a pure prefix strip. `path.relative` normalises, so a
 *    candidate that swallowed part of the code text (`…/a.ts-12-  // note`)
 *    would come back with its `//` collapsed — silently corrupting the text.
 */
function rewritePrefix(
  line: string,
  candidate: string,
  prefixLength: number,
  searchRoot: string,
): string {
  if (!candidate.startsWith(searchRoot)) return line
  const relative = toRelativePath(candidate)
  if (!candidate.endsWith(relative)) return line
  return relative + line.slice(prefixLength)
}
