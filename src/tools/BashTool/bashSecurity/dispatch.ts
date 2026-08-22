/**
 * The two legacy security dispatchers and the ordered validator lists they run.
 *
 * The lists are module-level consts shared by both dispatchers. They used to be
 * declared twice — once per function, byte-identical — and the async body never
 * executes under `bun test` (ParsedCommand.parse returns no tree-sitter
 * analysis, so it always takes the fallback below), which made a drifting second
 * copy of the ORDER invisible to every test. One declaration removes that.
 *
 * The two loops below are still duplicated on purpose: unifying them would
 * rewrite the deferral rule, which is the subtlest thing in this file.
 */

import { logEvent } from 'src/platform/analytics/index.js'
import { extractHeredocs } from 'src/platform/bash/heredoc.js'
import { ParsedCommand } from 'src/platform/bash/ParsedCommand.js'
import { hasShellQuoteSingleQuoteBug } from 'src/platform/bash/shellQuote.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { BASH_SECURITY_CHECK_IDS } from 'src/tools/BashTool/bashSecurity/checkIds.js'
import {
  CONTROL_CHAR_RE,
  extractQuotedContent,
  stripSafeRedirections,
  type ValidationContext,
} from 'src/tools/BashTool/bashSecurity/context.js'
import {
  validateEmpty,
  validateIncompleteCommands,
  validateSafeCommandSubstitution,
} from 'src/tools/BashTool/bashSecurity/validators/basic.js'
import { validateBraceExpansion } from 'src/tools/BashTool/bashSecurity/validators/braceExpansion.js'
import {
  validateBackslashEscapedOperators,
  validateBackslashEscapedWhitespace,
} from 'src/tools/BashTool/bashSecurity/validators/escaping.js'
import { validateGitCommit } from 'src/tools/BashTool/bashSecurity/validators/gitCommit.js'
import {
  validateDangerousPatterns,
  validateDangerousVariables,
  validateIFSInjection,
  validateMalformedTokenInjection,
  validateProcEnvironAccess,
  validateRedirections,
  validateShellMetacharacters,
} from 'src/tools/BashTool/bashSecurity/validators/injection.js'
import { validateJqCommand } from 'src/tools/BashTool/bashSecurity/validators/jq.js'
import { validateObfuscatedFlags } from 'src/tools/BashTool/bashSecurity/validators/obfuscatedFlags.js'
import {
  validateCarriageReturn,
  validateCommentQuoteDesync,
  validateMidWordHash,
  validateNewlines,
  validateQuotedNewline,
  validateUnicodeWhitespace,
} from 'src/tools/BashTool/bashSecurity/validators/whitespace.js'
import { validateZshDangerousCommands } from 'src/tools/BashTool/bashSecurity/validators/zsh.js'

const earlyValidators = [
  validateEmpty,
  validateIncompleteCommands,
  validateSafeCommandSubstitution,
  validateGitCommit,
]

// Validators that don't set isBashSecurityCheckForMisparsing — their ask
// results go through the standard permission flow rather than being blocked
// early. LF newlines and redirections are normal patterns that splitCommand
// handles correctly, not misparsing concerns.
//
// NOTE: validateCarriageReturn is NOT here — CR IS a misparsing concern.
// shell-quote's `[^\s]` treats CR as a word separator (JS `\s` ⊃ \r), but
// bash IFS does NOT include CR. splitCommand collapses CR→space, which IS
// misparsing. See validateCarriageReturn for the full attack trace.
//
// SECURITY: membership is tested by FUNCTION IDENTITY, so no validator may be
// re-wrapped or re-exported through a closure.
const nonMisparsingValidators = new Set([validateNewlines, validateRedirections])

const validators = [
  validateJqCommand,
  validateObfuscatedFlags,
  validateShellMetacharacters,
  validateDangerousVariables,
  // Run comment-quote-desync BEFORE validateNewlines: it detects cases where
  // the quote tracker would miss newlines due to # comment desync.
  validateCommentQuoteDesync,
  // Run quoted-newline BEFORE validateNewlines: it detects the INVERSE case
  // (newlines INSIDE quotes, which validateNewlines ignores by design). Quoted
  // newlines let attackers split commands across lines so that line-based
  // processing (stripCommentLines) drops sensitive content.
  validateQuotedNewline,
  // CR check runs BEFORE validateNewlines — CR is a MISPARSING concern
  // (shell-quote/bash tokenization differential), LF is not.
  validateCarriageReturn,
  validateNewlines,
  validateIFSInjection,
  validateProcEnvironAccess,
  validateDangerousPatterns,
  validateRedirections,
  validateBackslashEscapedWhitespace,
  validateBackslashEscapedOperators,
  validateUnicodeWhitespace,
  validateMidWordHash,
  validateBraceExpansion,
  validateZshDangerousCommands,
  // Run malformed token check last - other validators should catch specific patterns first
  // (e.g., $() substitution, backticks, etc.) since they have more precise error messages
  validateMalformedTokenInjection,
]

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 */
export function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult {
  // SECURITY: Block control characters before any other processing. Null bytes
  // and other non-printable chars are silently dropped by bash but confuse our
  // validators, allowing metacharacters adjacent to them to slip through.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Detect '\' patterns that exploit shell-quote's incorrect handling
  // of backslashes inside single quotes. Must run before shell-quote parsing.
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Strip heredoc bodies before running security validators.
  // Only strip bodies for quoted/escaped delimiters (<<'EOF', <<\EOF) where
  // the body is literal text — $(), backticks, and ${} are NOT expanded.
  // Unquoted heredocs (<<EOF) undergo full shell expansion, so their bodies
  // may contain executable command substitutions that validators must see.
  // When extractHeredocs bails out (can't parse safely), the raw command
  // goes through all validators — which is the safe direction.
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } =
    extractQuotedContent(processedCommand, baseCommand === 'jq')

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
  }

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // SECURITY: We must NOT short-circuit when a non-misparsing validator
  // returns 'ask' if there are still misparsing validators later in the list.
  // Non-misparsing ask results are discarded at bashPermissions.ts:~1301-1303
  // (the gate only blocks when isBashSecurityCheckForMisparsing is set). If
  // validateRedirections (index 10, non-misparsing) fires first on `>`, it
  // returns ask-without-flag — but validateBackslashEscapedOperators (index 12,
  // misparsing) would have caught `\;` WITH the flag. Short-circuiting lets a
  // payload like `cat safe.txt \; echo /etc/passwd > ./out` slip through.
  //
  // Fix: defer non-misparsing ask results. Continue running validators; if any
  // misparsing validator fires, return THAT (with the flag). Only if we reach
  // the end without a misparsing ask, return the deferred non-misparsing ask.
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 *
 * Async version of bashCommandIsSafe that uses tree-sitter when available
 * for more accurate parsing. Falls back to the sync regex version when
 * tree-sitter is not available.
 *
 * This should be used by async callers (bashPermissions.ts, bashCommandHelpers.ts).
 * Sync callers (readOnlyValidation.ts) should continue using bashCommandIsSafe().
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // Try to get tree-sitter analysis
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // If no tree-sitter, fall back to sync version
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // Run the same security checks but with tree-sitter enriched context.
  // The early checks (control chars, shell-quote bug) don't benefit from
  // tree-sitter, so we run them identically.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // Use tree-sitter quote context for more accurate analysis
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  // Use tree-sitter quote context as primary, but keep regex as reference
  // for divergence logging
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // Log divergence between tree-sitter and regex quote extraction.
  // Skip for heredoc commands: tree-sitter strips (quoted) heredoc bodies
  // to nothing while the regex path replaces them with placeholder strings
  // (via extractHeredocs), so the two outputs can never match. Logging
  // divergence for every heredoc command would poison the signal.
  //
  // onDivergence callback: when called in a fanout loop (bashPermissions.ts
  // Promise.all over subcommands), the caller batches divergences into a
  // single logEvent instead of N separate calls. Each logEvent triggers
  // getEventMetadata() → buildProcessMetrics() → process.memoryUsage() →
  // /proc/self/stat read; with memoized metadata these resolve as microtasks
  // and starve the event loop (CC-643). Single-command callers omit the
  // callback and get the original per-call logEvent behavior.
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('tengu_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}
