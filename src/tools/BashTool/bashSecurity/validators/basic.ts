/**
 * The three early validators: empty command, incomplete fragment, and the
 * heredoc-substitution early-allow.
 *
 * These run before the main list and their verdicts short-circuit — an 'allow'
 * here becomes 'passthrough' and skips every other validator, which is why
 * validateSafeCommandSubstitution delegates to the provably-safe isSafeHeredoc
 * rather than a looser pattern match.
 */

import { logEvent } from 'src/platform/analytics/index.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { BASH_SECURITY_CHECK_IDS } from 'src/tools/BashTool/bashSecurity/checkIds.js'
import type { ValidationContext } from 'src/tools/BashTool/bashSecurity/context.js'
import { HEREDOC_IN_SUBSTITUTION } from 'src/tools/BashTool/bashSecurity/context.js'
import { isSafeHeredoc } from 'src/tools/BashTool/bashSecurity/heredoc.js'

export function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    }
  }
  return { behavior: 'passthrough', message: 'Command is not empty' }
}

export function validateIncompleteCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with tab)',
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be an incomplete fragment (starts with flags)',
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be a continuation line (starts with operator)',
    }
  }

  return { behavior: 'passthrough', message: 'Command appears complete' }
}

export function validateSafeCommandSubstitution(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'No heredoc in substitution' }
  }

  if (isSafeHeredoc(originalCommand)) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason:
          'Safe command substitution: cat with quoted/escaped heredoc delimiter',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Command substitution needs validation',
  }
}
