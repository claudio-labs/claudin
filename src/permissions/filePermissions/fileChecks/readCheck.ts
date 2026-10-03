import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { hasSuspiciousWindowsPathPattern } from 'src/permissions/filePermissions/dangerousPaths.js'
import {
  OUTSIDE_WORKING_DIRS,
  readApprovalMessage,
  readDeniedMessage,
  uncReadMessage,
  windowsShapeReadMessage,
} from 'src/permissions/filePermissions/fileChecks/messages.js'
import { suggestionsFor } from 'src/permissions/filePermissions/fileChecks/suggestions.js'
import { runSteps, type CheckStep, type FileCheck } from 'src/permissions/filePermissions/fileChecks/target.js'
import { decideWrite } from 'src/permissions/filePermissions/fileChecks/writeCheck.js'
import { ruleCoveringAny } from 'src/permissions/filePermissions/fileRules/ruleQuery.js'
import { checkReadableInternalPath } from 'src/permissions/filePermissions/internalPaths.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'

const UNC_PREFIXES = ['//', '\\\\']

function isUncPath(path: string): boolean {
  return UNC_PREFIXES.some(prefix => path.startsWith(prefix))
}

/** Deny comes first, before the shapes that need a person (F4). */
const denyByReadRule: CheckStep = ({ target, context }) => {
  const rule = ruleCoveringAny(target.resolved, context, 'read', 'deny')
  if (!rule) return null
  return {
    behavior: 'deny',
    message: readDeniedMessage(target.path),
    decisionReason: { type: 'rule', rule },
  }
}

const askForUncPath: CheckStep = ({ target }) =>
  target.resolved.some(isUncPath)
    ? {
        behavior: 'ask',
        message: uncReadMessage(target.path),
        decisionReason: { type: 'other', reason: uncReadMessage(target.path) },
      }
    : null

const askForWindowsShape: CheckStep = ({ target }) =>
  target.resolved.some(hasSuspiciousWindowsPathPattern)
    ? {
        behavior: 'ask',
        message: windowsShapeReadMessage(target.path),
        decisionReason: { type: 'other', reason: windowsShapeReadMessage(target.path) },
      }
    : null

const askByReadRule: CheckStep = ({ target, context }) => {
  const rule = ruleCoveringAny(target.resolved, context, 'read', 'ask')
  if (!rule) return null
  return {
    behavior: 'ask',
    message: readApprovalMessage(target.path),
    decisionReason: { type: 'rule', rule },
  }
}

/** Whatever may be written may be read. A write that would deny or ask changes nothing here. */
const allowWhenWritable: CheckStep = check => {
  const write = decideWrite(check)
  return write.behavior === 'allow' ? write : null
}

const allowInWorkingDir: CheckStep = ({ target, input, context }) =>
  pathInAllowedWorkingPath(target.path, context, target.resolved)
    ? { behavior: 'allow', updatedInput: input, decisionReason: { type: 'mode', mode: 'default' } }
    : null

const allowHarnessReadable: CheckStep = ({ target, input }) => {
  const verdict = checkReadableInternalPath(target.path, input)
  return verdict.behavior === 'allow' ? verdict : null
}

/** Allow rules match the requested path only, not where its links lead (F6, pinned). */
const allowByReadRule: CheckStep = ({ target, input, context }) => {
  const rule = ruleCoveringAny([target.path], context, 'read', 'allow')
  return rule ? { behavior: 'allow', updatedInput: input, decisionReason: { type: 'rule', rule } } : null
}

function askToRead({ target, context }: FileCheck): PermissionDecision {
  return {
    behavior: 'ask',
    message: readApprovalMessage(target.path),
    decisionReason: { type: 'workingDir', reason: OUTSIDE_WORKING_DIRS },
    suggestions: suggestionsFor(target.path, 'read', context, target.resolved),
  }
}

const READ_STEPS: readonly CheckStep[] = [
  denyByReadRule,
  askForUncPath,
  askForWindowsShape,
  askByReadRule,
  allowWhenWritable,
  allowInWorkingDir,
  allowHarnessReadable,
  allowByReadRule,
]

/** The read check for one resolved file. */
export function decideRead(check: FileCheck): PermissionDecision {
  return runSteps(check, READ_STEPS, askToRead)
}
