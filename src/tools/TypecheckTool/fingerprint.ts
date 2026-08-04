import { createHash } from 'crypto'
import { isAbsolute, relative, sep } from 'path'
import type { RawDiagnostic } from './types.js'

/**
 * Diagnostic identity, for comparing one run against a recorded baseline.
 *
 * The fingerprint hashes file + code + message and deliberately EXCLUDES line
 * and column. That is the whole trick: in a project with a large known backlog
 * (this repo carries ~4300 tsc errors), inserting a single line at the top of a
 * file would otherwise shift every diagnostic below it and re-report the lot as
 * newly introduced, which makes the tool worse than useless.
 *
 * Trade-off accepted: two identical messages at different lines in one file
 * collapse to one fingerprint, so fixing one of them reads as fixing both. A
 * multiset comparison keeps the COUNTS honest even then.
 *
 * SHA-1 rather than the shared `hashContent` helper: that one returns Bun.hash
 * under Bun and SHA-256 under Node, and this value is written to disk by a
 * Node-launched CLI and read back by Bun-launched tests. A runtime-dependent
 * digest would make every entry look new the moment the runtime changed.
 */

/** 48 bits — with a few thousand entries per project, collisions are noise. */
const FINGERPRINT_CHARS = 12

const WHITESPACE_RUN_RE = /\s+/g

/**
 * tsc's TS2460 names an ARBITRARY sibling export of the broken module, and
 * picks a different one on every run — two back-to-back `tsc --noEmit` over an
 * unchanged tree disagreed on 23 of 27 such messages in this repo. Hashing that
 * text made the same diagnostic look new every single call, and the equal
 * "no longer reproduce" count made it read like real churn: 63 new, 63 fixed,
 * from a tree nobody had touched.
 *
 * Only the volatile clause is elided, not the message: a diagnostic whose text
 * is stable must keep distinguishing itself from its neighbours in the same
 * file, which is what makes a NEW error in a file that already has some
 * visible at all.
 */
const VOLATILE_EXPORT_NAME_RE = /but it is exported as '[^']*'/g

/**
 * Checkers disagree about paths: tsc prints them relative to the project,
 * pyright absolute. Normalising to a project-relative POSIX path is what lets a
 * baseline survive the project being moved or checked out at another path.
 */
export function normalizeDiagnosticPath(file: string, cwd: string): string {
  if (!file) return ''
  const rel = isAbsolute(file) ? relative(cwd, file) : file
  return rel.split(sep).join('/').replace(/^\.\//, '')
}

export function fingerprintDiagnostic(diagnostic: RawDiagnostic, cwd: string): string {
  const file = normalizeDiagnosticPath(diagnostic.file, cwd)
  const message = diagnostic.message
    .replace(VOLATILE_EXPORT_NAME_RE, 'but it is exported as <name>')
    .replace(WHITESPACE_RUN_RE, ' ')
    .trim()
  return createHash('sha1')
    .update(file)
    .update('\0')
    .update(diagnostic.code ?? '')
    .update('\0')
    .update(message)
    .digest('hex')
    .slice(0, FINGERPRINT_CHARS)
}

/**
 * Compare a run against a baseline as MULTISETS, not sets. Three copies of the
 * same error where the baseline recorded one means two are new; set semantics
 * would call all three pre-existing and hide a real regression.
 */
export function partitionAgainstBaseline(
  fingerprints: string[],
  baseline: readonly string[],
): { isNew: boolean[]; fixedCount: number } {
  const remaining = new Map<string, number>()
  for (const fp of baseline) remaining.set(fp, (remaining.get(fp) ?? 0) + 1)

  const isNew = fingerprints.map(fp => {
    const left = remaining.get(fp) ?? 0
    if (left === 0) return true
    remaining.set(fp, left - 1)
    return false
  })

  let fixedCount = 0
  for (const count of remaining.values()) fixedCount += count
  return { isNew, fixedCount }
}
