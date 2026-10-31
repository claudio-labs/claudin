import { isAbsolute, relative, sep } from 'path'

const LEADING_DOT_SLASH_RE = /^\.\//
const GLOB_META_RE = /[*?[\]{}\\!]/g

/**
 * Anchors a Grep `glob` holding a `/` at the search path.
 *
 * ripgrep anchors such a glob at the directory it RUNS in, and GrepTool runs
 * it in the session cwd so that the Read deny patterns, which are normalized
 * to that cwd, keep hiding files. Under any other search path the model's
 * `src/*.ts` therefore matched nothing — 24 of 28 such searches came back
 * "No matches found" in the 10-25..31 census, each followed by a retry through
 * Bash — and a negated one excluded nothing.
 *
 * The glob is rewritten from the search path instead: led by the path relative
 * to the cwd when the search path is inside it, by the absolute path (which
 * ripgrep matches against the absolute paths it walks) when it is not. Running
 * ripgrep in the search path, as GlobTool does, would anchor the glob too, but
 * deny patterns rooted above that directory would then be dropped by
 * `normalizePatternsToPath`. A glob with no `/`, a rooted one and one led by a
 * `**` segment are returned unchanged.
 */
export function anchorGlobAtSearchPath(pattern: string, searchDir: string, rgCwd: string): string {
  const negated = pattern.startsWith('!')
  const body = (negated ? pattern.slice(1) : pattern).replace(LEADING_DOT_SLASH_RE, '')
  if (!body.includes('/') || body.startsWith('/') || body.startsWith('**/')) return pattern
  const rel = relative(rgCwd, searchDir)
  if (rel === '') return pattern
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (outside && !searchDir.startsWith('/')) return pattern
  const anchor = (outside ? searchDir : rel.split(sep).join('/')).replace(GLOB_META_RE, '\\$&')
  return `${negated ? '!' : ''}/${anchor}/${body}`
}
