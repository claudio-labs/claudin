/**
 * Builds the permission context a session starts from, out of inputs the
 * caller has already gathered. Only the directory check touches the
 * filesystem, and it comes in through `StartContextDeps`.
 */
import type { AddDirectoryResult } from 'src/commands/add-dir/validation.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import { applyPermissionRulesToPermissionContext } from 'src/permissions/permissions.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'

export type StartContextInputs = {
  mode: PermissionMode
  /** `--allowed-tools` entries, already normalized. */
  cliAllowRules: string[]
  /** `--disallowed-tools` entries plus the base-tools denials, in that order. */
  cliDenyRules: string[]
  rulesFromDisk: PermissionRule[]
  bypassOffered: boolean
  /** Absent when the build carries no auto mode, so the field stays unset. */
  autoOffered: boolean | undefined
  /** Settings directories first, then `--add-dir`. */
  extraDirectories: string[]
  /** A `PWD` that is a symlink to the start directory, if there is one. */
  symlinkedPwd: string | undefined
}

export type StartContextDeps = {
  validateDirectory: (path: string, context: ToolPermissionContext) => Promise<AddDirectoryResult>
  explainRejection: (result: AddDirectoryResult) => string
}

function baseContext(inputs: StartContextInputs): ToolPermissionContext {
  const context: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: inputs.mode,
    alwaysAllowRules: { cliArg: inputs.cliAllowRules },
    alwaysDenyRules: { cliArg: inputs.cliDenyRules },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: inputs.bypassOffered,
  }
  if (inputs.autoOffered === undefined) return context
  return { ...context, isAutoModeAvailable: inputs.autoOffered }
}

function addDirectory(
  context: ToolPermissionContext,
  path: string,
  destination: 'cliArg' | 'session',
): ToolPermissionContext {
  return applyPermissionUpdate(context, { type: 'addDirectories', directories: [path], destination })
}

export async function buildStartContext(
  inputs: StartContextInputs,
  deps: StartContextDeps,
): Promise<{ context: ToolPermissionContext; warnings: string[] }> {
  let context = applyPermissionRulesToPermissionContext(baseContext(inputs), inputs.rulesFromDisk)
  const warnings: string[] = []

  // One at a time: each directory is checked against those already added, so
  // a nested one is not added twice.
  for (const requested of inputs.extraDirectories) {
    const verdict = await deps.validateDirectory(requested, context)
    if (verdict.resultType === 'success') {
      context = addDirectory(context, verdict.absolutePath, 'cliArg')
    } else if (verdict.resultType === 'pathNotFound' || verdict.resultType === 'alreadyInWorkingDirectory') {
      logForDebugging(`[permissions] start directory ${requested} skipped: ${verdict.resultType}`)
    } else {
      warnings.push(deps.explainRejection(verdict))
    }
  }

  if (inputs.symlinkedPwd !== undefined) {
    context = addDirectory(context, inputs.symlinkedPwd, 'session')
  }
  return { context, warnings }
}
