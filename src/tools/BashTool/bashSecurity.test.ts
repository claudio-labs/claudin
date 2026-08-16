import { describe, expect, test } from 'bun:test'

import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  bashCommandIsSafe_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from 'src/tools/BashTool/bashSecurity.js'

/**
 * Narrows to the ask branch and reports whether it is flagged as a MISPARSING
 * concern — the flag the caller uses to block a command early.
 */
function askIsMisparsing(result: PermissionResult): boolean | undefined {
  if (result.behavior !== 'ask') {
    throw new Error(`expected an ask decision, got '${result.behavior}'`)
  }
  return result.isBashSecurityCheckForMisparsing
}

describe('bashCommandIsSafe_DEPRECATED', () => {
  test('passes an ordinary command through', () => {
    expect(bashCommandIsSafe_DEPRECATED('ls -la').behavior).toBe('passthrough')
  })

  // Bash drops these silently; our validators do not, so metacharacters next to
  // one could otherwise slip past the checks that follow.
  test('asks for a command carrying control characters, flagged as misparsing', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\u0000 -la')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test("asks for the '\\' pattern that desyncs shell-quote's quote tracker", () => {
    const result = bashCommandIsSafe_DEPRECATED("ls '\\' *")
    expect(askIsMisparsing(result)).toBe(true)
  })

  // A redirection is a normal pattern, so its ask must NOT claim misparsing —
  // the caller only blocks early on the misparsing flag.
  test('asks for a redirection without flagging it as misparsing', () => {
    const result = bashCommandIsSafe_DEPRECATED('echo hi > out.txt')
    expect(askIsMisparsing(result)).toBeUndefined()
  })

  // The regression: a non-misparsing ask must be DEFERRED, not returned, or a
  // later misparsing validator never runs and the payload is let through.
  test('a later misparsing verdict wins over an earlier redirection ask', () => {
    const result = bashCommandIsSafe_DEPRECATED(
      'cat safe.txt \\; echo /etc/passwd > ./out',
    )
    expect(askIsMisparsing(result)).toBe(true)
  })
})

describe('stripSafeHeredocSubstitutions', () => {
  test('returns null when there is no heredoc substitution to strip', () => {
    expect(stripSafeHeredocSubstitutions('ls -la')).toBeNull()
    expect(stripSafeHeredocSubstitutions('echo $(id)')).toBeNull()
  })

  test('strips a well-formed quoted heredoc substitution', () => {
    const stripped = stripSafeHeredocSubstitutions(
      "git commit -m $(cat <<'EOF'\nsubject line\nEOF\n)",
    )
    expect(stripped).not.toBeNull()
    expect(stripped).not.toContain('subject line')
    expect(stripped).toContain('git commit -m')
  })

  test('leaves an unterminated heredoc substitution alone', () => {
    expect(
      stripSafeHeredocSubstitutions("echo $(cat <<'EOF'\nbody never closed"),
    ).toBeNull()
  })
})
