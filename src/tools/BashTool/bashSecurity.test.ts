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

/**
 * A quoted outer delimiter makes the body literal text in bash, so the inner
 * `$(cat <<'B'` is characters — but the raw-text regex matches both and
 * produces two ranges, the second nested in the first.
 */
const NESTED_HEREDOC_COMMAND = [
  "echo $(cat <<'A'",
  "x $(cat <<'B'",
  'y',
  'B',
  ')',
  'A',
  ') ; rm -rf /tmp/x',
].join('\n')

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

  // Regression: the strip walks its ranges in reverse so earlier indices stay
  // valid, which only holds while no range sits INSIDE another. With a nested
  // one the outer `end` is stale after the inner is removed, so `slice(end)`
  // returned '' and everything after the outer heredoc disappeared before the
  // validators ran. isSafeHeredoc has always rejected nesting for this exact
  // reason; the strip did not.
  test('refuses to strip nested heredoc substitutions', () => {
    expect(stripSafeHeredocSubstitutions(NESTED_HEREDOC_COMMAND)).toBeNull()
  })

  test('never drops the text that follows the outer heredoc', () => {
    const stripped = stripSafeHeredocSubstitutions(NESTED_HEREDOC_COMMAND)
    // Refusing (null) is fine; returning "echo " is not — that is what let
    // `; rm -rf /tmp/x` reach the caller as if it had never been typed.
    expect(stripped ?? NESTED_HEREDOC_COMMAND).toContain('rm -rf /tmp/x')
  })
})
