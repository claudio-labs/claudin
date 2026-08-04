import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { readSourceExcerpt } from '../shared/sourceExcerpt.js'
import type { TestFailure } from './types.js'

/**
 * The failure dossier. For each failure that resolved to a `file:line`, read a
 * small source window from disk and attach it, plus a one-line problem summary
 * distilled from the message/diff. This is the single-round-trip payoff: the
 * model sees which file, which line, the code there, and what broke — without a
 * follow-up Read per failure.
 */

const MAX_SUMMARY_CHARS = 200

function resolveFile(file: string, cwd: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file)
  return existsSync(abs) ? abs : null
}

function distillSummary(failure: TestFailure): string {
  const source = failure.message || failure.diff || ''
  const firstLine =
    source
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? 'Test failed'
  return firstLine.length > MAX_SUMMARY_CHARS
    ? `${firstLine.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : firstLine
}

export function buildDossier(failures: TestFailure[], cwd: string): void {
  for (const f of failures) {
    if (!f.summary) f.summary = distillSummary(f)
    if (f.excerpt || !f.file || !f.line) continue
    const abs = resolveFile(f.file, cwd)
    if (!abs) continue
    const excerpt = readSourceExcerpt(abs, f.line)
    if (excerpt) f.excerpt = excerpt
  }
}
