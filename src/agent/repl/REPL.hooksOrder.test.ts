/**
 * REPL renders in two modes from one component: the prompt view falls through
 * to the end, and `if (screen === 'transcript')` returns early. That return is
 * a RUNTIME branch — ctrl+o (`app:toggleTranscript`) flips `screen` — so any
 * hook placed after it runs on one path and not the other. React answers that
 * with "Rendered fewer hooks than expected" and the whole TUI is replaced by a
 * stack trace.
 *
 * This reads REPL.tsx as text rather than rendering it: the component pulls in
 * the entire REPL subsystem, and the invariant is lexical anyway — a hook below
 * the early return is wrong no matter what it computes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPL_PATH = join(import.meta.dir, 'REPL.tsx')
const TRANSCRIPT_RETURN = "if (screen === 'transcript') {"
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/

/** Strip line comments so prose naming a hook isn't read as a call. */
function stripComments(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''
  return line.replace(/\/\/.*$/, '')
}

describe('REPL hook order', () => {
  const source = readFileSync(REPL_PATH, 'utf8')
  const lines = source.split('\n')

  test('the transcript early return is still there to guard', () => {
    // If this fails the branch was restructured and the guard below is
    // measuring nothing — re-derive it rather than deleting it.
    expect(source).toContain(TRANSCRIPT_RETURN)
  })

  test('no hook is called after the transcript early return', () => {
    const returnLine = lines.findIndex(l => l.includes(TRANSCRIPT_RETURN))
    expect(returnLine).toBeGreaterThan(0)

    const offenders: string[] = []
    for (let i = returnLine + 1; i < lines.length; i++) {
      const code = stripComments(lines[i]!)
      if (HOOK_CALL.test(code)) {
        offenders.push(`${i + 1}: ${code.trim()}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
