/**
 * The paths one Grep `path` names.
 *
 * A model that wants three directories searched sometimes sends them in one
 * string, space-separated: `src/tools/BuildTool src/tools/RunTestsTool …`
 * (2b5c3f37 and 30177640 in the 2026-11-04..09 census). That path does not
 * exist, so the call was refused and sent again, one Grep per directory.
 * When the whole string is no path but every piece is one, the pieces are the
 * search targets.
 *
 * A path that exists whole is one target, spaces and all. When some pieces
 * exist and others do not, the first missing piece is the one to name; when
 * none exists the string was meant whole, and it is named whole.
 */
export type SearchTargets =
  | { kind: 'one'; path: string }
  | { kind: 'many'; paths: string[] }
  | { kind: 'missing'; path: string }

const WHITESPACE_RE = /\s+/

export function resolveSearchTargets(
  path: string,
  exists: (path: string) => boolean,
): SearchTargets {
  if (exists(path)) return { kind: 'one', path }
  const pieces = path.trim().split(WHITESPACE_RE).filter(Boolean)
  if (pieces.length < 2) return { kind: 'missing', path }
  const missing = pieces.filter(piece => !exists(piece))
  if (missing.length === pieces.length) return { kind: 'missing', path }
  if (missing.length > 0) return { kind: 'missing', path: missing[0]! }
  return { kind: 'many', paths: pieces }
}
