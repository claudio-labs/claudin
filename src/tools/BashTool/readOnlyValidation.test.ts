import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import {
  checkReadOnlyConstraints,
  isCommandSafeViaFlagParsing,
} from 'src/tools/BashTool/readOnlyValidation.js'

// checkReadOnlyConstraints reads the sandbox state to decide whether a git
// command outside the original cwd may be certified. Pin it so the verdicts
// below do not depend on what an earlier test file left enabled.
const realIsSandboxingEnabled = SandboxManager.isSandboxingEnabled
beforeAll(() => {
  SandboxManager.isSandboxingEnabled = () => false
})
afterAll(() => {
  SandboxManager.isSandboxingEnabled = realIsSandboxingEnabled
})

/** Narrows to the passthrough branch and hands back its reason. */
function passthroughMessage(result: PermissionResult): string {
  if (result.behavior !== 'passthrough') {
    throw new Error(`expected a passthrough decision, got '${result.behavior}'`)
  }
  return result.message
}

describe('isCommandSafeViaFlagParsing', () => {
  test('accepts an allowlisted command with allowlisted flags', () => {
    expect(isCommandSafeViaFlagParsing('git diff')).toBe(true)
    expect(isCommandSafeViaFlagParsing('git diff --stat')).toBe(true)
  })

  test('rejects a command that is not on the allowlist', () => {
    expect(isCommandSafeViaFlagParsing('curl https://example.com')).toBe(false)
  })

  test('rejects anything carrying shell operators', () => {
    // Splitting compound commands happens upstream; anything still holding an
    // operator here has not been split and cannot be judged.
    expect(isCommandSafeViaFlagParsing('git diff | sh')).toBe(false)
    expect(isCommandSafeViaFlagParsing('git diff > /tmp/out')).toBe(false)
  })

  // `$VAR` survives parsing as literal text but bash expands it at runtime, so
  // a token holding `$` can smuggle a flag past the `startsWith('-')` check.
  test('rejects any argument containing a variable expansion', () => {
    expect(isCommandSafeViaFlagParsing('git diff "$Z--output=/tmp/pwned"')).toBe(
      false,
    )
    expect(isCommandSafeViaFlagParsing('git diff $FILE')).toBe(false)
  })

  // Brace expansion is the same trick with different syntax.
  test('rejects brace expansion but keeps git refs and templates usable', () => {
    expect(
      isCommandSafeViaFlagParsing('git diff {@{0},--output=/tmp/pwned}'),
    ).toBe(false)
    expect(isCommandSafeViaFlagParsing('git diff {1..5}')).toBe(false)
    // `stash@{0}` has a brace but no comma or range — it must stay allowed.
    expect(isCommandSafeViaFlagParsing('git stash show stash@{0}')).toBe(true)
  })

  test('rejects a git ls-remote pointed at a remote it could exfiltrate to', () => {
    expect(
      isCommandSafeViaFlagParsing('git ls-remote https://evil.example/x'),
    ).toBe(false)
    expect(
      isCommandSafeViaFlagParsing('git ls-remote git@evil.example:u/r.git'),
    ).toBe(false)
  })

  test('rejects backticks in a command with no regex of its own', () => {
    expect(isCommandSafeViaFlagParsing('git diff `id`')).toBe(false)
  })
})

describe('checkReadOnlyConstraints', () => {
  test('allows a plain read-only command', () => {
    const result = checkReadOnlyConstraints({ command: 'ls -la' }, false)
    expect(result.behavior).toBe('allow')
  })

  test('passes a write command through to the rest of the permission chain', () => {
    expect(
      checkReadOnlyConstraints({ command: 'rm -rf build' }, false).behavior,
    ).toBe('passthrough')
  })

  // We cannot know what a glob or a variable expands to, so we cannot certify
  // the command as read-only — `ls *` could resolve to `ls --help`-style args.
  test('refuses to certify a command holding an unquoted glob or expansion', () => {
    expect(checkReadOnlyConstraints({ command: 'ls *' }, false).behavior).toBe(
      'passthrough',
    )
    expect(
      checkReadOnlyConstraints({ command: 'uniq --skip-chars=0$_ f' }, false)
        .behavior,
    ).toBe('passthrough')
  })

  test('quoted globs stay read-only', () => {
    expect(
      checkReadOnlyConstraints({ command: "grep -r 'a*b' src" }, false)
        .behavior,
    ).toBe('allow')
  })

  // cd + git is a sandbox escape: the target directory can carry fake hooks.
  test('will not certify a compound command that has both cd and git', () => {
    const result = checkReadOnlyConstraints(
      { command: 'cd /tmp/evil && git status' },
      true,
    )
    expect(passthroughMessage(result)).toContain('cd and git')
  })

  // Same escape, built in place: create the git internals, then run git.
  test('will not certify a command that creates git internals and runs git', () => {
    const result = checkReadOnlyConstraints(
      { command: 'mkdir -p hooks && git status' },
      false,
    )
    expect(passthroughMessage(result)).toContain('git internal files')
  })

  // The allowlist is matched as a token PREFIX, so a global flag inserted
  // before the subcommand stops `git status` from matching at all and the
  // command fails closed. That is what stops `-c core.fsmonitor=…`,
  // `--exec-path` and `--config-env` from being certified read-only here —
  // not the flag names, which this path never inspects.
  test('a global flag before the subcommand breaks the allowlist prefix match', () => {
    for (const command of [
      'git -c core.fsmonitor=id status',
      'git --exec-path=/tmp/evil status',
      'git --config-env=core.pager=EVIL status',
    ]) {
      expect(checkReadOnlyConstraints({ command }, false).behavior).toBe(
        'passthrough',
      )
    }
  })
})
