/**
 * The entry point: check every statement of a parsed PowerShell command, and
 * reduce the per-statement decisions so a deny always outranks an ask.
 */

import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getDirectoryForPath } from 'src/shared/fs/path.js'
import { allWorkingDirectories } from 'src/permissions/filePermissions.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  formatDirectoryList,
  isDangerousRemovalPath,
} from 'src/permissions/pathValidation.js'
import type { ParsedPowerShellCommand } from 'src/platform/shell/powershell/parser.js'
import { isNullRedirectionTarget } from 'src/platform/shell/powershell/parser.js'
import { resolveToCanonical } from 'src/tools/PowerShellTool/readOnlyValidation.js'
import { CMDLET_PATH_CONFIG } from 'src/tools/PowerShellTool/pathValidation/cmdletPathConfig.js'
import {
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from 'src/tools/PowerShellTool/pathValidation/dangerousRemoval.js'
import { extractPathsFromCommand } from 'src/tools/PowerShellTool/pathValidation/extractPaths.js'
import {
  checkDenyRuleForGuessedPath,
  validatePath,
} from 'src/tools/PowerShellTool/pathValidation/pathAllowlist.js'

/**
 * Checks path constraints for PowerShell commands.
 * Extracts file paths from the parsed AST and validates they are
 * within allowed directories.
 *
 * @param compoundCommandHasCd - Whether the full compound command contains a
 *   cwd-changing cmdlet (Set-Location/Push-Location/Pop-Location/New-PSDrive,
 *   excluding no-op Set-Location-to-CWD). When true, relative paths in ANY
 *   statement cannot be trusted — PowerShell executes statements sequentially
 *   and a cd in statement N changes the cwd for statement N+1, but this
 *   validator resolves all paths against the stale Node process cwd.
 *   BashTool parity (BashTool/pathValidation.ts:630-655).
 *
 * @returns
 * - 'ask' if any path command tries to access outside allowed directories
 * - 'deny' if a deny rule explicitly blocks the path
 * - 'passthrough' if no path commands were found or all paths are valid
 */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: 'Cannot validate paths for unparsed command',
    }
  }

  // SECURITY: Two-pass approach — check ALL statements/paths so deny rules
  // always take precedence over ask. Without this, an ask on statement 1
  // could return before checking statement 2 for deny rules, letting the
  // user approve a command that includes a denied path.
  let firstAsk: PermissionResult | undefined

  for (const statement of parsed.statements) {
    const result = checkPathConstraintsForStatement(
      statement,
      toolPermissionContext,
      compoundCommandHasCd,
    )
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && !firstAsk) {
      firstAsk = result
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}

function checkPathConstraintsForStatement(
  statement: ParsedPowerShellCommand['statements'][number],
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  const cwd = getCwd()
  let firstAsk: PermissionResult | undefined

  // SECURITY: BashTool parity — block path operations in compound commands
  // containing a cwd-changing cmdlet (BashTool/pathValidation.ts:630-655).
  //
  // When the compound contains Set-Location/Push-Location/Pop-Location/
  // New-PSDrive, relative paths in later statements resolve against the
  // CHANGED cwd at runtime, but this validator resolves them against the
  // STALE getCwd() snapshot. Example attack (finding #3):
  //   Set-Location ./.claudin; Set-Content ./settings.json '...'
  // Validator sees ./settings.json → /project/settings.json (not a config file).
  // Runtime writes /project/.claudin/settings.json (Claude's permission config).
  //
  // ALTERNATIVE APPROACH (rejected): simulate cwd through the statement chain
  // — after `Set-Location ./.claudin`, validate subsequent statements with
  // cwd='./.claudin'. This would be more permissive but requires careful
  // handling of:
  //   - Push-Location/Pop-Location stack semantics
  //   - Set-Location with no args (→ home on some platforms)
  //   - New-PSDrive root mapping (arbitrary filesystem root)
  //   - Conditional/loop statements where cd may or may not execute
  //   - Error cases where the cd target can't be statically determined
  // For now we take the conservative approach of requiring manual approval.
  //
  // Unlike BashTool which gates on `operationType !== 'read'`, we also block
  // READS (finding #27): `Set-Location ~; Get-Content ./.ssh/id_rsa` bypasses
  // Read(~/.ssh/**) deny rules because the validator matched the deny against
  // /project/.ssh/id_rsa. Reads from mis-resolved paths leak data just as
  // writes destroy it. We still run deny-rule matching below (via firstAsk,
  // not early return) so explicit deny rules on the stale-resolved path are
  // honored — deny > ask in the caller's reduce.
  if (compoundCommandHasCd) {
    firstAsk = {
      behavior: 'ask',
      message:
        'Compound command changes working directory (Set-Location/Push-Location/Pop-Location/New-PSDrive) — relative paths cannot be validated against the original cwd and require manual approval',
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with path operation — manual approval required to prevent path resolution bypass',
      },
    }
  }

  // SECURITY: Track whether this statement contains a non-CommandAst pipeline
  // element (string literal, variable, array expression). PowerShell pipes
  // these values to downstream cmdlets, often binding to -Path. Example:
  // `'/etc/passwd' | Remove-Item` — the string is piped to Remove-Item's -Path,
  // but Remove-Item has no explicit args so extractPathsFromCommand returns
  // zero paths and the command would passthrough. If ANY downstream cmdlet
  // appears alongside an expression source, we force an ask — the piped
  // path is unvalidatable regardless of operation type (reads leak data;
  // writes destroy it).
  let hasExpressionPipelineSource = false
  // Track the non-CommandAst element's text for deny-rule guessing (finding #23).
  // `'.git/hooks/pre-commit' | Remove-Item` — path comes via pipeline, paths=[]
  // from extractPathsFromCommand, so the deny loop below never iterates. We
  // feed the pipeline-source text through checkDenyRuleForGuessedPath so
  // explicit Edit(.git/**) deny rules still fire.
  let pipelineSourceText: string | undefined

  for (const cmd of statement.commands) {
    if (cmd.elementType !== 'CommandAst') {
      hasExpressionPipelineSource = true
      pipelineSourceText = cmd.text
      continue
    }

    const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
      extractPathsFromCommand(cmd)

    // SECURITY: Cmdlet receiving piped path from expression source.
    // `'/etc/shadow' | Get-Content` — Get-Content extracts zero paths
    // (no explicit args). The path comes from the pipeline, which we cannot
    // statically validate. Previously exempted reads (`operationType !== 'read'`),
    // but that was a bypass (review comment 2885739292): reads from
    // unvalidatable paths are still a security risk. Ask regardless of op type.
    if (hasExpressionPipelineSource) {
      const canonical = resolveToCanonical(cmd.name)
      // SECURITY (finding #23): Before falling back to ask, check if the
      // pipeline-source text matches a deny rule. `'.git/hooks/pre-commit' |
      // Remove-Item` should DENY (not ask) when Edit(.git/**) is configured.
      // Strip surrounding quotes (string literals are quoted in .text) and
      // feed through the same deny-guess helper used for ::/backtick paths.
      if (pipelineSourceText !== undefined) {
        const stripped = pipelineSourceText.replace(/^['"]|['"]$/g, '')
        const denyHit = checkDenyRuleForGuessedPath(
          stripped,
          cwd,
          toolPermissionContext,
          operationType,
        )
        if (denyHit) {
          return {
            behavior: 'deny',
            message: `${canonical} targeting '${denyHit.resolvedPath}' was blocked by a deny rule`,
            decisionReason: { type: 'rule', rule: denyHit.rule },
          }
        }
      }
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} receives its path from a pipeline expression source that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

    // SECURITY: Array literals, subexpressions, and other complex
    // argument types cannot be statically validated. An array literal
    // like `-Path ./safe.txt, /etc/passwd` produces a single 'Other'
    // element whose combined text may resolve within CWD while
    // PowerShell actually writes to ALL paths in the array.
    if (hasUnvalidatablePathArg) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

    // SECURITY: Write cmdlet in CMDLET_PATH_CONFIG that extracted zero paths.
    // Either (a) the cmdlet has no args at all (`Remove-Item` alone —
    // PowerShell will error, but we shouldn't optimistically assume that), or
    // (b) we failed to recognize the path among the args (shouldn't happen
    // with the unknown-param fail-safe, but defense-in-depth). Conservative:
    // write operation with no validated target → ask.
    // Read cmdlets and pop-location (pathParams: []) are exempt.
    // optionalWrite cmdlets (Invoke-WebRequest/Invoke-RestMethod without
    // -OutFile) are ALSO exempt — they only write to disk when a pathParam is
    // present; without one, output goes to the pipeline. The
    // hasUnvalidatablePathArg check above already covers unknown-param cases.
    if (
      operationType !== 'read' &&
      !optionalWrite &&
      paths.length === 0 &&
      CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
    ) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
      }
      continue
    }

    // SECURITY: bash-parity hard-deny for removal cmdlets on
    // system-critical paths. BashTool has isDangerousRemovalPath which
    // hard-DENIES `rm /`, `rm ~`, `rm /etc`, etc. regardless of user config.
    // Port: remove-item (and aliases rm/del/ri/rd/rmdir/erase → resolveToCanonical)
    // on a dangerous path → deny (not ask). User cannot approve system32 deletion.
    const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

    for (const filePath of paths) {
      // Hard-deny removal of dangerous system paths (/, ~, /etc, etc.).
      // Check the RAW path (pre-realpath) first: safeResolvePath can
      // canonicalize '/' → 'C:\' (Windows) or '/var/...' → '/private/var/...'
      // (macOS) which defeats isDangerousRemovalPath's string comparisons.
      if (isRemoval && isDangerousRemovalRawPath(filePath)) {
        return dangerousRemovalDeny(filePath)
      }

      const { allowed, resolvedPath, decisionReason } = validatePath(
        filePath,
        cwd,
        toolPermissionContext,
        operationType,
      )

      // Also check the resolved path — catches symlinks that resolve to a
      // protected location.
      if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
        return dangerousRemovalDeny(resolvedPath)
      }

      if (!allowed) {
        const canonical = resolveToCanonical(cmd.name)
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claudin may only access files in the allowed working directories for this session: ${dirListStr}.`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        const suggestions: PermissionUpdate[] = []
        if (resolvedPath) {
          if (operationType === 'read') {
            const suggestion = createReadRuleSuggestion(
              getDirectoryForPath(resolvedPath),
              'session',
            )
            if (suggestion) {
              suggestions.push(suggestion)
            }
          } else {
            suggestions.push({
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            })
          }
        }

        if (operationType === 'write' || operationType === 'create') {
          suggestions.push({
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          })
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions,
        }
      }
    }
  }

  // Also check nested commands from control flow
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
        extractPathsFromCommand(cmd)

      if (hasUnvalidatablePathArg) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
        }
        // Don't continue — fall through to path loop for deny checks.
      }

      // SECURITY: Write cmdlet with zero extracted paths (mirrors main loop).
      // optionalWrite cmdlets exempt — see main-loop comment.
      if (
        operationType !== 'read' &&
        !optionalWrite &&
        paths.length === 0 &&
        CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
      ) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
        }
        continue
      }

      // SECURITY: bash-parity hard-deny for removal on system-critical
      // paths — mirror the main-loop check above. Without this,
      // `if ($true) { Remove-Item / }` routes through nestedCommands and
      // downgrades deny→ask, letting the user approve root deletion.
      const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

      for (const filePath of paths) {
        // Check the RAW path first (pre-realpath); see main-loop comment.
        if (isRemoval && isDangerousRemovalRawPath(filePath)) {
          return dangerousRemovalDeny(filePath)
        }

        const { allowed, resolvedPath, decisionReason } = validatePath(
          filePath,
          cwd,
          toolPermissionContext,
          operationType,
        )

        if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
          return dangerousRemovalDeny(resolvedPath)
        }

        if (!allowed) {
          const canonical = resolveToCanonical(cmd.name)
          const workingDirs = Array.from(
            allWorkingDirectories(toolPermissionContext),
          )
          const dirListStr = formatDirectoryList(workingDirs)

          const message =
            decisionReason?.type === 'other' ||
            decisionReason?.type === 'safetyCheck'
              ? decisionReason.reason
              : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claudin may only access files in the allowed working directories for this session: ${dirListStr}.`

          if (decisionReason?.type === 'rule') {
            return {
              behavior: 'deny',
              message,
              decisionReason,
            }
          }

          const suggestions: PermissionUpdate[] = []
          if (resolvedPath) {
            if (operationType === 'read') {
              const suggestion = createReadRuleSuggestion(
                getDirectoryForPath(resolvedPath),
                'session',
              )
              if (suggestion) {
                suggestions.push(suggestion)
              }
            } else {
              suggestions.push({
                type: 'addDirectories',
                directories: [getDirectoryForPath(resolvedPath)],
                destination: 'session',
              })
            }
          }

          if (operationType === 'write' || operationType === 'create') {
            suggestions.push({
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            })
          }

          firstAsk ??= {
            behavior: 'ask',
            message,
            blockedPath: resolvedPath,
            decisionReason,
            suggestions,
          }
        }
      }

      // Red-team P11/P14: step 5 at powershellPermissions.ts:970 already
      // catches this via the same synthetic-CommandExpressionAst mechanism —
      // this is belt-and-suspenders so the nested loop doesn't rely on that
      // accident. Placed AFTER the path loop so specific asks (blockedPath,
      // suggestions) win via ??=.
      if (hasExpressionPipelineSource) {
        firstAsk ??= {
          behavior: 'ask',
          message: `${resolveToCanonical(cmd.name)} appears inside a control-flow or chain statement where piped expression sources cannot be statically validated and requires manual approval`,
        }
      }
    }
  }

  // Check redirections on nested commands (e.g., from && / || chains)
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      if (cmd.redirections) {
        for (const redir of cmd.redirections) {
          if (redir.isMerging) continue
          if (!redir.target) continue
          if (isNullRedirectionTarget(redir.target)) continue

          const { allowed, resolvedPath, decisionReason } = validatePath(
            redir.target,
            cwd,
            toolPermissionContext,
            'create',
          )

          if (!allowed) {
            const workingDirs = Array.from(
              allWorkingDirectories(toolPermissionContext),
            )
            const dirListStr = formatDirectoryList(workingDirs)

            const message =
              decisionReason?.type === 'other' ||
              decisionReason?.type === 'safetyCheck'
                ? decisionReason.reason
                : `Output redirection to '${resolvedPath}' was blocked. For security, Claudin may only write to files in the allowed working directories for this session: ${dirListStr}.`

            if (decisionReason?.type === 'rule') {
              return {
                behavior: 'deny',
                message,
                decisionReason,
              }
            }

            firstAsk ??= {
              behavior: 'ask',
              message,
              blockedPath: resolvedPath,
              decisionReason,
              suggestions: [
                {
                  type: 'addDirectories',
                  directories: [getDirectoryForPath(resolvedPath)],
                  destination: 'session',
                },
              ],
            }
          }
        }
      }
    }
  }

  // Check file redirections
  if (statement.redirections) {
    for (const redir of statement.redirections) {
      if (redir.isMerging) continue
      if (!redir.target) continue
      if (isNullRedirectionTarget(redir.target)) continue

      const { allowed, resolvedPath, decisionReason } = validatePath(
        redir.target,
        cwd,
        toolPermissionContext,
        'create',
      )

      if (!allowed) {
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claudin may only write to files in the allowed working directories for this session: ${dirListStr}.`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions: [
            {
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            },
          ],
        }
      }
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}
