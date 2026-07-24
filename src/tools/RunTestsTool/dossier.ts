import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { logError } from '../../utils/log.js'
import type { TestFailure } from './types.js'

/**
 * The failure dossier. For each failure that resolved to a `file:line`, read a
 * small source window from disk and attach it, plus a one-line problem summary
 * distilled from the message/diff. This is the single-round-trip payoff: the
 * model sees which file, which line, the code there, and what broke — without a
 * follow-up Read per failure.
 */

const CONTEXT_LINES = 3
const MAX_EXCERPT_FILE_BYTES = 2_000_000
const MAX_SUMMARY_CHARS = 200

function resolveFile(file: string, cwd: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file)
  return existsSync(abs) ? abs : null
}

function readExcerpt(absFile: string, line: number): string | undefined {
  try {
    if (statSync(absFile).size > MAX_EXCERPT_FILE_BYTES) return undefined
    const lines = readFileSync(absFile, 'utf8').split('\n')
    if (line < 1 || line > lines.length) return undefined
    const start = Math.max(0, line - 1 - CONTEXT_LINES)
    const end = Math.min(lines.length, line + CONTEXT_LINES)
    const width = String(end).length
    const out: string[] = []
    for (let i = start; i < end; i++) {
      const n = i + 1
      const marker = n === line ? '>' : ' '
      out.push(`${marker} ${String(n).padStart(width)} | ${lines[i]}`)
    }
    return out.join('\n')
  } catch (e) {
    logError(`RunTests: failed to read excerpt from ${absFile} — ${String(e)}`)
    return undefined
  }
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
    const excerpt = readExcerpt(abs, f.line)
    if (excerpt) f.excerpt = excerpt
  }
}
