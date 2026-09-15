/**
 * The git-commit early validator: allows `git commit -m "simple message"`
 * without dragging the message text through the main validator list.
 *
 * It returns 'allow', which short-circuits everything downstream — so each bail
 * to 'passthrough' here is load-bearing, not defensive.
 */

import { logEvent } from 'src/platform/analytics/index.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { BASH_SECURITY_CHECK_IDS } from 'src/tools/BashTool/bashSecurity/checkIds.js'
import type { ValidationContext } from 'src/tools/BashTool/bashSecurity/context.js'

export function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'Not a git commit' }
  }

  // SECURITY: Backslashes can cause our regex to mis-identify quote boundaries
  // (e.g., `git commit -m "test\"msg" && evil`). Legitimate commit messages
  // virtually never contain backslashes, so bail to the full validator chain.
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: 'Git commit contains backslash, needs full validation',
    }
  }

  // SECURITY: The `.*?` before `-m` must NOT match shell operators. Previously
  // `.*?` matched anything except `\n`, including `;`, `&`, `|`, `` ` ``, `$(`.
  // For `git commit ; curl evil.com -m 'x'`, `.*?` swallowed `; curl evil.com `
  // leaving remainder=`` (falsy → remainder check skipped) → returned `allow`
  // for a compound command. Early-allow skips ALL main validators (line ~1908),
  // nullifying validateQuotedNewline, validateBackslashEscapedOperators, etc.
  // While splitCommand currently catches this downstream, early-allow is a
  // POSITIVE ASSERTION that the FULL command is safe — which it is NOT.
  //
  // Also: `\s+` between `git` and `commit` must NOT match `\n`/`\r` (command
  // separators in bash). Use `[ \t]+` for horizontal-only whitespace.
  //
  // The `[^;&|`$<>()\n\r]*?` class excludes shell metacharacters. We also
  // exclude `<` and `>` here (redirects) — they're allowed in the REMAINDER
  // for `--author="Name <email>"` but must not appear BEFORE `-m`.
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: 'Git commit message contains command substitution patterns',
      }
    }

    // SECURITY: Check remainder for shell operators that could chain commands
    // or redirect output. The `.*` before `-m` in the regex can swallow flags
    // like `--amend`, leaving `&& evil` or `> ~/.bashrc` in the remainder.
    // Previously we only checked for $() / `` / ${} here, missing operators
    // like ; | & && || < >.
    //
    // `<` and `>` can legitimately appear INSIDE quotes in --author values
    // like `--author="Name <email>"`. An UNQUOTED `>` is a shell redirect
    // operator. Because validateGitCommit is an EARLY validator, returning
    // `allow` here short-circuits bashCommandIsSafe and SKIPS
    // validateRedirections. So we must bail to passthrough on unquoted `<>`
    // to let the main validators handle it.
    //
    // Attack: `git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit returns allow → bashCommandIsSafe short-circuits →
    //   validateRedirections NEVER runs → ~/.bashrc overwritten with git
    //   stdout containing `payload` → RCE on next shell login.
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: 'Git commit remainder contains shell metacharacters',
      }
    }
    if (remainder) {
      // Strip quoted content, then check for `<` or `>`. Quoted `<>` (email
      // brackets in --author) are safe; unquoted `<>` are shell redirects.
      // NOTE: This simple quote tracker has NO backslash handling. `\'`/`\"`
      // outside quotes would desync it (bash: \' = literal ', tracker: toggles
      // SQ). BUT line 584 already bailed on ANY backslash in originalCommand,
      // so we never reach here with backslashes. For backslash-free input,
      // simple quote toggling is correct (no way to escape quotes without \\).
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) unquoted += c
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: 'Git commit remainder contains unquoted redirect operator',
        }
      }
    }

    // Security hardening: block messages starting with dash
    // This catches potential obfuscation patterns like git commit -m "---"
    if (messageContent && messageContent.startsWith('-')) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: 'Command contains quoted characters in flag names',
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Git commit with simple quoted message is allowed',
      },
    }
  }

  return { behavior: 'passthrough', message: 'Git commit needs validation' }
}
