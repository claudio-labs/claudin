/**
 * Which gitignored files of the main checkout a new worktree receives, decided
 * from the `.worktreeinclude` text and git's NUL-separated listings alone.
 *
 * git lists a directory whose whole content is ignored as one `dir/` entry.
 * Walking every such directory would mean walking `node_modules/`, so one is
 * opened only when a pattern points into it by its literal start, or names it.
 */

import ignore, { type Ignore } from 'ignore'

const LINE_BREAK = /\r?\n/
const TRAILING_BLANKS = /[ \t]+$/
const GLOB_CHARACTER = /[*?[]/

export type IncludeRules = {
  /** The patterns as gitignore reads them; empty when nothing would match. */
  readonly patterns: readonly string[]
  readonly matcher: Ignore
}

export function readIncludeRules(text: string): IncludeRules {
  const lines = text.split(LINE_BREAK)
  const patterns = lines
    .map(line => line.replace(TRAILING_BLANKS, ''))
    .filter(line => line !== '' && !line.startsWith('#'))
  return { patterns, matcher: ignore().add(lines) }
}

/** Entries of a `-z` listing; the last NUL leaves an empty tail that is dropped. */
export function splitNulListing(listing: string): string[] {
  return listing.split('\0').filter(entry => entry !== '')
}

export function isDirectoryEntry(entry: string): boolean {
  return entry.endsWith('/')
}

export function isIncluded(rules: IncludeRules, path: string): boolean {
  return rules.matcher.ignores(path)
}

/** Whether one positive pattern reaches into `dir/` by its literal start. */
function pointsInto(pattern: string, dir: string): boolean {
  const unanchored = pattern.startsWith('/') ? pattern.slice(1) : pattern
  if (unanchored.startsWith(dir)) return true
  const glob = unanchored.search(GLOB_CHARACTER)
  // An anchorless glob (`*.key`) has no literal start and reaches nowhere.
  return glob > 0 && dir.startsWith(unanchored.slice(0, glob))
}

/** Whether a wholly ignored `dir/` entry can hold an included file. */
export function shouldOpenDirectory(rules: IncludeRules, dir: string): boolean {
  if (rules.matcher.ignores(dir)) return true
  return rules.patterns.some(pattern => !pattern.startsWith('!') && pointsInto(pattern, dir))
}
