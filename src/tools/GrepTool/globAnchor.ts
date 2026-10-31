import { isAbsolute, relative, sep } from 'path'

const LEADING_DOT_SLASH_RE = /^\.\//
const TRAILING_SLASHES_RE = /\/+$/
const GLOB_META_RE = /[*?[\]{}\\!]/g

/** The patterns a Grep `glob` input becomes: split on whitespace, and on commas outside braces. */
export function splitGlobInput(glob: string): string[] {
  const patterns: string[] = []
  for (const raw of glob.split(/\s+/)) {
    if (raw.includes('{') && raw.includes('}')) patterns.push(raw)
    else patterns.push(...raw.split(','))
  }
  return patterns.filter(Boolean)
}

/**
 * Whether ripgrep anchors this glob at the directory it runs in: a `/` inside
 * it, not led by `/` or a `**` segment. A trailing `/` alone is not one — it
 * only says "a directory", matched at any depth.
 */
export function isDirAnchoredGlob(pattern: string): boolean {
  const p = pattern.startsWith('!') ? pattern.slice(1) : pattern
  return p.replace(TRAILING_SLASHES_RE, '').includes('/') && !p.startsWith('/') && !p.startsWith('**/')
}

/**
 * The `--glob` arguments one Grep glob becomes, so that it is also read from
 * the search path.
 *
 * ripgrep anchors a glob holding a `/` at the directory it RUNS in, and
 * GrepTool runs it in the session cwd so that the Read deny patterns, which
 * are normalized to that cwd, keep hiding files. Under any other search path
 * the model's `src/*.ts` therefore matched nothing: 24 of 28 such searches
 * came back "No matches found" in the 10-25..31 census, and a negated one
 * excluded nothing.
 *
 * The glob is passed twice: as written, and led by the search path — relative
 * to the cwd inside it, absolute (which ripgrep matches against the absolute
 * paths it walks) outside it. Positive globs match either reading and negated
 * ones exclude both, so a glob written from the cwd matches as it did before.
 * Running ripgrep in the search path, as GlobTool does, would anchor the glob
 * too, but deny patterns rooted above that directory would then be dropped by
 * `normalizePatternsToPath`. A leading `./`, which ripgrep never matches, is
 * read from the search path alone.
 */
export function globsForSearchPath(pattern: string, searchDir: string, rgCwd: string): string[] {
  const bang = pattern.startsWith('!') ? '!' : ''
  const raw = pattern.slice(bang.length)
  const body = raw.replace(LEADING_DOT_SLASH_RE, '')
  const rooted = body !== raw
  if (!rooted && !isDirAnchoredGlob(body)) return [pattern]
  const lead = searchPathLead(searchDir, rgCwd)
  if (rooted) return [`${bang}${lead ?? ''}/${body}`]
  return lead ? [pattern, `${bang}${lead}/${body}`] : [pattern]
}

/** `''` at the cwd, `/<path>` elsewhere, null where a glob cannot name the path. */
function searchPathLead(searchDir: string, rgCwd: string): string | null {
  const rel = relative(rgCwd, searchDir)
  if (rel === '') return ''
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  // A Windows drive path cannot lead a glob.
  if (outside && !searchDir.startsWith('/')) return null
  return `/${(outside ? searchDir : rel.split(sep).join('/')).replace(GLOB_META_RE, '\\$&')}`
}
