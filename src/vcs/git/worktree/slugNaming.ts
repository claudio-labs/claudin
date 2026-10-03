/**
 * Worktree slug validation and the name/path mapping derived from it.
 *
 * The slug is attacker-influenced (it arrives as an EnterWorktree argument and
 * as `--worktree <name>`) and is joined into `.claudin/worktrees/<slug>`, so
 * the allowlist and the length cap here are a security boundary, not cosmetics.
 */

import { join } from 'path'

/** `\w` without the `u` flag is exactly ASCII letters, digits and `_`. */
const SLUG_SEGMENT_ALPHABET = /^[\w.-]+$/
const SLUG_LENGTH_LIMIT = 64

/** `/` is a slug separator; `+` is outside the alphabet, which keeps the mapping injective. */
const SEGMENT_SEPARATOR = /\//g
const FLAT_SEPARATOR = '+'

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..'
}

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > SLUG_LENGTH_LIMIT) {
    throw new Error(
      `Invalid worktree name: must be ${SLUG_LENGTH_LIMIT} characters or fewer (got ${slug.length})`,
    )
  }
  for (const segment of slug.split('/')) {
    if (isDotSegment(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": "." and ".." path segments are not allowed`,
      )
    }
    if (!SLUG_SEGMENT_ALPHABET.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and use only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

export function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claudin', 'worktrees')
}

// A nested slug is flattened so that its branch never sits under another
// branch's ref directory and its worktree never lands inside another worktree.
function flattenSlug(slug: string): string {
  return slug.replace(SEGMENT_SEPARATOR, FLAT_SEPARATOR)
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

export function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}
