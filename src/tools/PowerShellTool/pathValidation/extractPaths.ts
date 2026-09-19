/**
 * Walking a parsed command's arguments to decide which of them name a path,
 * using the AST element types as ground truth rather than the leading dash.
 */

import type { ParsedCommandElement } from 'src/platform/shell/powershell/parser.js'
import { isPowerShellParameter } from 'src/platform/shell/powershell/parser.js'
import { COMMON_SWITCHES, COMMON_VALUE_PARAMS } from 'src/tools/PowerShellTool/commonParameters.js'
import { resolveToCanonical } from 'src/tools/PowerShellTool/readOnlyValidation.js'
import type { FileOperationType } from 'src/tools/PowerShellTool/pathValidation/cmdletPathConfig.js'
import { CMDLET_PATH_CONFIG } from 'src/tools/PowerShellTool/pathValidation/cmdletPathConfig.js'
import {
  hasComplexColonValue,
  matchesParam,
} from 'src/tools/PowerShellTool/pathValidation/paramMatching.js'

/**
 * Element types that are safe to extract as literal path strings.
 *
 * Only element types with statically-known string values are safe for path
 * extraction. Variable and ExpandableString have runtime-determined values —
 * even though they're defended downstream ($ detection in validatePath's
 * `includes('$')` check, and the hasExpandableStrings security flag), excluding
 * them here is defense-in-direct: fail-safe at the earliest gate rather than
 * relying on downstream checks to catch them.
 *
 * Any other type (e.g., 'Other' for ArrayLiteralExpressionAst, 'SubExpression',
 * 'ScriptBlock', 'Variable', 'ExpandableString') cannot be statically validated
 * and must force an ask.
 */
const SAFE_PATH_ELEMENT_TYPES = new Set<string>(['StringConstant', 'Parameter'])

/**
 * Extract file paths from a parsed PowerShell command element.
 * Uses the AST args to find positional and named path parameters.
 *
 * If any path argument has a complex elementType (e.g., array literal,
 * subexpression) that cannot be statically validated, sets
 * hasUnvalidatablePathArg so the caller can force an ask.
 */
export function extractPathsFromCommand(cmd: ParsedCommandElement): {
  paths: string[]
  operationType: FileOperationType
  hasUnvalidatablePathArg: boolean
  optionalWrite: boolean
} {
  const canonical = resolveToCanonical(cmd.name)
  const config = CMDLET_PATH_CONFIG[canonical]

  if (!config) {
    return {
      paths: [],
      operationType: 'read',
      hasUnvalidatablePathArg: false,
      optionalWrite: false,
    }
  }

  // Build per-cmdlet known-param sets, merging in common parameters.
  const switchParams = [...config.knownSwitches, ...COMMON_SWITCHES]
  const valueParams = [...config.knownValueParams, ...COMMON_VALUE_PARAMS]

  const paths: string[] = []
  const args = cmd.args
  // elementTypes[0] is the command name; elementTypes[i+1] corresponds to args[i]
  const elementTypes = cmd.elementTypes
  let hasUnvalidatablePathArg = false
  let positionalsSeen = 0
  const positionalSkip = config.positionalSkip ?? 0

  function checkArgElementType(argIdx: number): void {
    if (!elementTypes) return
    const et = elementTypes[argIdx + 1]
    if (et && !SAFE_PATH_ELEMENT_TYPES.has(et)) {
      hasUnvalidatablePathArg = true
    }
  }

  // Extract named parameter values (e.g., -Path "C:\foo")
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    // Check if this arg is a parameter name.
    // SECURITY: Use elementTypes as ground truth. PowerShell's tokenizer
    // accepts en-dash/em-dash/horizontal-bar (U+2013/2014/2015) as parameter
    // prefixes; a raw startsWith('-') check misses `–Path` (en-dash). The
    // parser maps CommandParameterAst → 'Parameter' regardless of dash char.
    // isPowerShellParameter also correctly rejects quoted "-Include"
    // (StringConstant, not a parameter).
    const argElementType = elementTypes ? elementTypes[i + 1] : undefined
    if (isPowerShellParameter(arg, argElementType)) {
      // Handle colon syntax: -Path:C:\secret
      // Normalize Unicode dash to ASCII `-` (pathParams are stored with `-`).
      const normalized = '-' + arg.slice(1)
      const colonIdx = normalized.indexOf(':', 1) // skip first char (the dash)
      const paramName =
        colonIdx > 0 ? normalized.substring(0, colonIdx) : normalized
      const paramLower = paramName.toLowerCase()

      if (matchesParam(paramLower, config.pathParams)) {
        // Known path parameter — extract its value as a path.
        let value: string | undefined
        if (colonIdx > 0) {
          // Colon syntax: -Path:value — the whole thing is one element.
          // SECURITY: comma-separated values (e.g., -Path:safe.txt,/etc/passwd)
          // produce ArrayLiteralExpressionAst inside the CommandParameterAst.
          // PowerShell writes to ALL paths, but we see a single string.
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          // Standard syntax: -Path value
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++ // Skip the value
          }
        }
        if (value) {
          paths.push(value)
        }
      } else if (
        config.leafOnlyPathParams &&
        matchesParam(paramLower, config.leafOnlyPathParams)
      ) {
        // Leaf-only path parameter (e.g., New-Item -Name). PowerShell resolves
        // this relative to ANOTHER parameter (-Path), not cwd. validatePath
        // resolves against cwd (L930), so non-leaf values (separators,
        // traversal) resolve to the WRONG location and can miss deny rules
        // (deny→ask downgrade). Extract simple leaf filenames; flag anything
        // path-like.
        let value: string | undefined
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++
          }
        }
        if (value !== undefined) {
          if (
            value.includes('/') ||
            value.includes('\\') ||
            value === '.' ||
            value === '..'
          ) {
            // Non-leaf: separators or traversal. Can't resolve correctly
            // without joining against -Path. Force ask.
            hasUnvalidatablePathArg = true
          } else {
            // Simple leaf: extract. Resolves to cwd/leaf (slightly wrong —
            // should be <-Path>/leaf) but -Path extraction covers the
            // directory, and a leaf filename can't traverse out of anywhere.
            paths.push(value)
          }
        }
      } else if (matchesParam(paramLower, switchParams)) {
        // Known switch parameter — takes no value, do NOT consume next arg.
        // (Colon syntax on a switch, e.g., -Confirm:$false, is self-contained
        // in one token and correctly falls through here without consuming.)
      } else if (matchesParam(paramLower, valueParams)) {
        // Known value-taking non-path parameter (e.g., -Encoding UTF8, -Filter *.txt).
        // Consume its value; do NOT validate as path, but DO check elementType.
        // SECURITY: A Variable elementType (e.g., $env:ANTHROPIC_API_KEY) in any
        // argument position means the runtime value is not statically knowable.
        // Without this check, `-Value $env:SECRET` would be silently auto-allowed
        // in acceptEdits mode because the Variable elementType was never examined.
        if (colonIdx > 0) {
          // Colon syntax: -Value:$env:FOO — the value is embedded in the token.
          // The outer CommandParameterAst 'Parameter' type masks the inner
          // expression type. Check for expression markers that indicate a
          // non-static value (mirrors pathParams colon-syntax guards).
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          }
        } else {
          const nextArg = args[i + 1]
          const nextArgType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextArg && !isPowerShellParameter(nextArg, nextArgType)) {
            checkArgElementType(i + 1)
            i++ // Skip the parameter's value
          }
        }
      } else {
        // Unknown parameter — we do not understand this invocation.
        // SECURITY: This is the structural fix for the KNOWN_SWITCH_PARAMS
        // whack-a-mole. Rather than guess whether this param is a switch
        // (and risk swallowing a positional path) or takes a value (and
        // risk the same), we flag the whole command as unvalidatable.
        // The caller will force an ask.
        hasUnvalidatablePathArg = true
        // SECURITY: Even though we don't recognize this param, if it uses
        // colon syntax (-UnknownParam:/etc/hosts) the bound value might be
        // a filesystem path. Extract it into paths[] so deny-rule matching
        // still runs. Without this, the value is trapped inside the single
        // token and paths=[] means deny rules are never consulted —
        // downgrading deny to ask. This is defense-in-depth: the primary
        // fix is adding all known aliases to pathParams above.
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (!hasComplexColonValue(rawValue)) {
            paths.push(rawValue)
          }
        }
        // Continue the loop so we still extract any recognizable paths
        // (useful for the ask message), but the flag ensures overall 'ask'.
      }
      continue
    }

    // Positional arguments: extract as paths (e.g., Get-Content file.txt)
    // The first positional arg is typically the source path.
    // Skip leading positionals that are non-path values (e.g., iwr's -Uri).
    if (positionalsSeen < positionalSkip) {
      positionalsSeen++
      continue
    }
    positionalsSeen++
    checkArgElementType(i)
    paths.push(arg)
  }

  return {
    paths,
    operationType: config.operationType,
    hasUnvalidatablePathArg,
    optionalWrite: config.optionalWrite ?? false,
  }
}
