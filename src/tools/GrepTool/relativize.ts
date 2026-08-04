import { toRelativePath } from '../../utils/path.js'

// Ripgrep prefixes every content line with the file it came from: `path:NN:text`
// for a match and `path-NN-text` for a context line (-A/-B/-C). The path is
// non-greedy so the first `<sep><digits><sep>` wins — that keeps Windows drive
// letters (`C:\...`) inside the path, same reasoning as RG_LINE_RE. The
// backreference pins both separators to the same character because rg never
// mixes the two forms on one line.
export const RG_PREFIX_RE = /^(.+?)([:-])(\d+)\2/

/**
 * Rewrites the absolute path rg emits into a cwd-relative one, for match AND
 * context lines. Splitting on the first `:` (the previous approach) silently
 * skipped every context line whose code text had no colon, leaving the full
 * absolute path in the payload.
 *
 * Fail-open: a line that doesn't carry a recognisable prefix, or whose candidate
 * path isn't under the directory rg was pointed at, is returned untouched. That
 * guard matters because a directory named like `foo-12-bar` can make the
 * non-greedy match land inside the path — and a wrong path is worse than a long
 * one.
 */
export function relativizeRgLine(line: string, searchRoot: string): string {
  const m = RG_PREFIX_RE.exec(line)
  if (m) return rewritePrefix(line, m[1]!, m[1]!.length, searchRoot)
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
 *    the split landed inside the path (a dir named `foo-12-bar` does that);
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
