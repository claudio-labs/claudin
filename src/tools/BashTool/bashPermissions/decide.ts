/**
 * bashToolHasPermission — the 15-phase pipeline that turns a Bash command plus
 * a permission context into a single allow/deny/ask/passthrough verdict.
 *
 * Relocated verbatim from bashPermissions.ts, which is now a barrel over this
 * directory.
 */

import { feature } from 'bun:bundle'
import type { z } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { count } from 'src/shared/data/array.js'
import {
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from 'src/platform/bash/commands.js'
import { tryParseShellCommand } from 'src/platform/bash/shellQuote.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { AbortError } from 'src/shared/errors.js'
import {
  classifyBashCommand,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from 'src/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/permissions/PermissionResult.js'
import type {
  PermissionRule,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import { extractRules } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import { createPermissionRequestMessage } from 'src/permissions/permissions.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { windowsPathToPosixPath } from 'src/shared/fs/windowsPaths.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { checkCommandOperatorPermissions } from 'src/tools/BashTool/bashCommandHelpers.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from 'src/tools/BashTool/bashSecurity.js'
import { checkPathConstraints } from 'src/tools/BashTool/pathValidation.js'
import { shouldUseSandbox } from 'src/tools/BashTool/shouldUseSandbox.js'
import {
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from 'src/tools/BashTool/bashPermissions/wrappers.js'
import {
  suggestionForExactCommand,
  suggestionForPrefix,
} from 'src/tools/BashTool/bashPermissions/suggestions.js'
import {
  bashToolCheckExactMatchPermission,
  bashToolCheckPermission,
} from 'src/tools/BashTool/bashPermissions/ruleMatching.js'
import {
  checkCommandAndSuggestRules,
  checkEarlyExitDeny,
  checkSandboxAutoAllow,
  commandHasAnyCd,
  filterCdCwdSubcommands,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
} from 'src/tools/BashTool/bashPermissions/gates.js'
import {
  buildPendingClassifierCheck,
  logClassifierResultForAnts,
} from 'src/tools/BashTool/bashPermissions/speculative.js'

// Shorthand aliases for two long `_DEPRECATED` names used throughout this file.
//
// These used to be documented as a workaround for a "DCE cliff" — a
// per-function complexity budget in Bun's native feature() evaluator that
// `import { X as Y }` aliases counted against. That constraint is upstream's
// and does NOT apply to this fork: scripts/build/build.ts:137-164 folds
// feature() calls with a regex over the source text (featureCallRe) instead of
// letting Bun evaluate them, because Bun >=1.3.9 resolves `bun:bundle` in C++
// before plugins can intercept it. A regex substitution has no complexity
// budget, so neither file size nor alias count can affect the fold.
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED

// CC-643: On complex compound commands, splitCommand_DEPRECATED can produce a
// very large subcommands array (possible exponential growth; #21405's ReDoS fix
// may have been incomplete). Each subcommand then runs tree-sitter parse +
// ~20 validators + logEvent (bashSecurity.ts), and with memoized metadata the
// resulting microtask chain starves the event loop — REPL freeze at 100% CPU,
// strace showed /proc/self/stat reads at ~127Hz with no epoll_wait. Fifty is
// generous: legitimate user commands don't split that wide. Above the cap we
// fall back to 'ask' (safe default — we can't prove safety, so we prompt).
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380: Cap the number of per-subcommand rules suggested for compound
// commands. Beyond this, the "Yes, and don't ask again for X, Y, Z…" label
// degrades to "similar commands" anyway, and saving 10+ rules from one prompt
// is more likely noise than intent. Users chaining this many write commands
// in one && list are rare; they can always approve once and add rules manually.
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * The main implementation to check if we need to ask for user permission to call BashTool with a given input
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. The shell-quote pre-check. An AST security parse used to sit in front of
  // it and, on a clean parse, replace both this and the misparsing gate below
  // with a tokenized SimpleCommand[]. Its parser returned null unconditionally,
  // so the AST result was always 'parse-unavailable' and this is the branch that
  // has always run. The `too-complex` and `simple` arms, checkSemantics and
  // checkSemanticsDeny went with it.
  const parseResult = tryParseShellCommand(input.command)
  if (!parseResult.success) {
    const decisionReason = {
      type: 'other' as const,
      reason: `Command contains malformed syntax that cannot be parsed: ${parseResult.error}`,
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // Check sandbox auto-allow (which respects explicit deny/ask rules)
  // Only call this if sandboxing and auto-allow are both enabled
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(
      input,
      appState.toolPermissionContext,
    )
    if (
      sandboxAutoAllowResult.behavior === 'deny' ||
      sandboxAutoAllowResult.behavior === 'ask'
    ) {
      return sandboxAutoAllowResult
    }
  }

  // Check exact match first
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    appState.toolPermissionContext,
  )

  // Exact command was denied
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // Check Bash prompt deny and ask rules in parallel (both use Haiku).
  // Deny takes precedence over ask, and both take precedence over allow rules.
  // Skip when in auto mode - auto mode classifier handles all permission decisions
  if (
    isClassifierPermissionsEnabled() &&
    !(
      feature('TRANSCRIPT_CLASSIFIER') &&
      appState.toolPermissionContext.mode === 'auto'
    )
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(
      appState.toolPermissionContext,
    )
    const askDescriptions = getBashPromptAskDescriptions(
      appState.toolPermissionContext,
    )
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(
          input.command,
          'deny',
          denyDescriptions,
          denyResult,
        )
      }
      if (askResult) {
        logClassifierResultForAnts(
          input.command,
          'ask',
          askDescriptions,
          askResult,
        )
      }

      // Deny takes precedence
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // Skip the Haiku call — the UI computes the prefix locally
        // and lets the user edit it. Still call the injected function
        // when tests override it.
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"`,
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // Check for non-subcommand Bash operators like `>`, `|`, etc.
  // This must happen before dangerous path checks so that piped commands
  // are handled by the operator logic (which generates "multiple operations" messages)
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: z.infer<typeof BashTool.inputSchema>) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // SECURITY FIX: When pipe segment processing returns 'allow', we must still validate
    // the ORIGINAL command. The pipe segment processing strips redirections before
    // checking each segment, so commands like:
    //   echo 'x' | xargs printf '%s' >> /tmp/file
    // would have both segments allowed (echo and xargs printf) but the >> redirection
    // would bypass validation. We must check:
    // 1. Path constraints for output redirections
    // 2. Command safety for dangerous patterns (backticks, etc.) in redirect targets
    if (commandOperatorResult.behavior === 'allow') {
      // Check for dangerous patterns (backticks, $(), etc.) in the original command
      // This catches cases like: echo x | xargs echo > `pwd`/evil.txt
      // where the backtick is in the redirect target (stripped from segments)
      // This was gated on the AST having validated the structure already; that
      // gate was always open, since the parse never succeeded.
      const safetyResult = await bashCommandIsSafeAsync(input.command)
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // Attach pending classifier check - may auto-approve before user responds
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          }),
          decisionReason: {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // SECURITY: Compute compoundCommandHasCd from the full command, NOT
      // hardcode false. The pipe-handling path previously passed `false` here,
      // disabling the cd+redirect check at pathValidation.ts:821. Appending
      // `| echo done` to `cd .claudin && echo x > settings.json` routed through
      // this path with compoundCommandHasCd=false, letting the redirect write
      // to .claudin/settings.json without the cd+redirect block firing.
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // When pipe segments return 'ask' (individual segments not allowed by rules),
    // attach pending classifier check - may auto-approve before user responds.
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // SECURITY: the misparsing gate — "can splitCommand be trusted on this
  // input?". An AST parse used to be able to answer that instead and skip this
  // block; it never did, so this is the only thing answering it.
  if (!isEnvTruthy(process.env.CLAUDIN_DISABLE_COMMAND_INJECTION_CHECK)) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(
      input.command,
    )
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // Compound commands with safe heredoc patterns ($(cat <<'EOF'...EOF))
      // trigger the $() check on the unsplit command. Strip the safe heredocs
      // and re-check the remainder — if other misparsing patterns exist
      // (e.g. backslash-escaped operators), they must still block.
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult =
        remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' &&
          remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // Allow if the exact command has an explicit allow permission — the user
        // made a conscious choice to permit this specific command.
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // Attach pending classifier check - may auto-approve before user responds
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(
            BashTool.name,
            decisionReason,
          ),
          decisionReason,
          suggestions: [], // Don't suggest saving a potentially dangerous command
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // Split into subcommands. The AST-extracted spans used to be preferred here,
  // with splitCommand as the fallback; the spans never existed. The cd-cwd
  // filter strips the `cd ${cwd}` prefix that models like to prepend.
  const cwd = getCwd()
  const cwdMingw =
    getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const subcommands = filterCdCwdSubcommands(
    splitCommand(input.command),
    cwd,
    cwdMingw,
  )

  // CC-643: Cap subcommand fanout. splitCommand is the only splitter there is,
  // and it can explode on a long compound command.
  if (subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // Ask if there are multiple `cd` commands
  const cdCommands = subcommands.filter(subCommand =>
    isNormalizedCdCommand(subCommand),
  )
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // Track if compound command contains cd for security validation
  // This prevents bypassing path checks via: cd .claudin/ && mv test.txt settings.json
  const compoundCommandHasCd = cdCommands.length > 0

  // SECURITY: Block compound commands that have both cd AND git
  // This prevents sandbox escape via: cd /malicious/dir && git status
  // where the malicious directory contains a bare git repo with core.fsmonitor.
  // This check must happen HERE (before subcommand-level permission checks)
  // because bashToolCheckPermission checks each subcommand independently via
  // BashTool.isReadOnly(), which would re-derive compoundCommandHasCd=false
  // from just "git status" alone, bypassing the readOnlyValidation.ts check.
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some(cmd =>
      isNormalizedGitCommand(cmd.trim()),
    )
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab

  // SECURITY FIX: Check Bash deny/ask rules BEFORE path constraints
  // This ensures that explicit deny rules like Bash(ls:*) take precedence over
  // path constraint checks that return 'ask' for paths outside the project.
  // Without this ordering, absolute paths outside the project (e.g., ls /home)
  // would bypass deny rules because checkPathConstraints would return 'ask' first.
  //
  // Note: bashToolCheckPermission calls checkPathConstraints internally, which handles
  // output redirection validation on each subcommand. However, since splitCommand strips
  // redirections before we get here, we MUST validate output redirections on the ORIGINAL
  // command AFTER checking deny rules but BEFORE returning results.
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
    ),
  )

  // Deny if any subcommands are denied
  const deniedSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'deny',
  )
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // Validate output redirections on the ORIGINAL command (before splitCommand stripped them)
  // This must happen AFTER checking deny rules but BEFORE returning results.
  // Output redirections like "> /etc/passwd" are stripped by splitCommand, so the per-subcommand
  // checkPathConstraints calls won't see them. We validate them here on the original input.
  // SECURITY: When AST data is available, pass AST-derived redirects so
  // checkPathConstraints uses them directly instead of re-parsing with
  // shell-quote (which has a known single-quote backslash misparsing bug
  // that can silently hide redirect operators).
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'ask',
  )
  const nonAllowCount = count(
    subcommandPermissionDecisions,
    _ => _.behavior !== 'allow',
  )

  // SECURITY (GH#28784): Only short-circuit on a path-constraint 'ask' when no
  // subcommand independently produced an 'ask'. checkPathConstraints re-runs the
  // path-command loop on the full input, so `cd <outside-project> && python3 foo.py`
  // produces an ask with ONLY a Read(<dir>/**) suggestion — the UI renders it as
  // "Yes, allow reading from <dir>/" and picking that option silently approves
  // python3. When a subcommand has its own ask (e.g. the cd subcommand's own
  // path-constraint ask), fall through: either the askSubresult short-circuit
  // below fires (single non-allow subcommand) or the merge flow collects Bash
  // rule suggestions for every non-allow subcommand. The per-subcommand
  // checkPathConstraints call inside bashToolCheckPermission already captures
  // the Read rule for the cd target in that path.
  //
  // When no subcommand asked (all allow, or all passthrough like `printf > file`),
  // pathResult IS the only ask — return it so redirection checks surface.
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // Ask if any subcommands require approval (e.g., ls/cd outside boundaries).
  // Only short-circuit when exactly ONE subcommand needs approval — if multiple
  // do (e.g. cd-outside-project ask + python3 passthrough), fall through to the
  // merge flow so the prompt surfaces Bash rule suggestions for all of them
  // instead of only the first ask's Read rule (GH#28784).
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // Allow if exact command was allowed
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // If all subcommands are allowed via exact or prefix match, allow the
  // command — but only if no command injection is possible. A successful AST
  // parse used to make this per-subcommand re-check redundant; there was never
  // one, so it always ran.
  let hasPossibleCommandInjection = false
  if (!isEnvTruthy(process.env.CLAUDIN_DISABLE_COMMAND_INJECTION_CHECK)) {
    const results = await Promise.all(
      subcommands.map(c => bashCommandIsSafeAsync(c)),
    )
    hasPossibleCommandInjection = results.some(
      r => r.behavior !== 'passthrough',
    )
  }
  if (
    subcommandPermissionDecisions.every(_ => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // Query Haiku for command prefixes
  // Skip the Haiku call — the UI computes the prefix locally and
  // lets the user edit it. Still call when a custom fn is injected (tests).
  let commandSubcommandPrefix: Awaited<
    ReturnType<typeof getCommandSubcommandPrefixFn>
  > = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // If there is only one command, no need to process subcommands
  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
    )
    // If command wasn't allowed, attach pending classifier check.
    // At this point, 'ask' can only come from bashCommandIsSafe (security check inside
    // checkCommandAndSuggestRules), NOT from explicit ask rules - those were already
    // filtered out at step 13 (askSubresult check). The classifier can bypass security.
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // Check subcommand permission results
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // Pass through input params like `sandbox`
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
      ),
    )
  }

  // Allow if all subcommands are allowed
  // Note that this is different than 6b because we are checking the command injection results.
  if (
    subcommands.every(subcommand => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // Keep subcommandResults as PermissionResult for decisionReason
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // Otherwise, ask for permission
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (
      permissionResult.behavior === 'ask' ||
      permissionResult.behavior === 'passthrough'
    ) {
      const updates =
        'suggestions' in permissionResult
          ? permissionResult.suggestions
          : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // Use string representation as key for deduplication
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 follow-up: security-check asks (compound-cd+write, process
      // substitution, etc.) carry no suggestions. In a compound command like
      // `cd ~/out && rm -rf x`, that means only cd's Read rule gets collected
      // and the UI labels the prompt "Yes, allow reading from <dir>/" — never
      // mentioning rm. Synthesize a Bash(exact) rule so the UI shows the
      // chained command. Skip explicit ask rules (decisionReason.type 'rule')
      // where the user deliberately wants to review each time.
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(
          suggestionForExactCommand(subcommand),
        )) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // Note: We only collect rules, not other update types like mode changes
      // This is appropriate for bash subcommands which primarily need rule suggestions
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380: Cap at MAX_SUGGESTED_RULES_FOR_COMPOUND. Map preserves insertion
  // order (subcommand order), so slicing keeps the leftmost N.
  const cappedRules = Array.from(collectedRules.values()).slice(
    0,
    MAX_SUGGESTED_RULES_FOR_COMPOUND,
  )
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // Attach pending classifier check - may auto-approve before user responds.
  // Behavior is 'ask' if any subcommand was 'ask' (e.g., path constraint or ask
  // rule) — before the GH#28784 fix, ask subresults always short-circuited above
  // so this path only saw 'passthrough' subcommands and hardcoded that.
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}
