import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { checkPathSafetyForAutoEdit } from 'src/permissions/filePermissions/dangerousPaths.js'
import {
  editDeniedMessage,
  OUTSIDE_WORKING_DIRS,
  writeApprovalMessage,
} from 'src/permissions/filePermissions/fileChecks/messages.js'
import { suggestionsFor } from 'src/permissions/filePermissions/fileChecks/suggestions.js'
import {
  runSteps,
  type CheckStep,
  type FileCheck,
  type FileTarget,
} from 'src/permissions/filePermissions/fileChecks/target.js'
import {
  ruleAmongCoveringAny,
  ruleCoveringAny,
} from 'src/permissions/filePermissions/fileRules/ruleQuery.js'
import { fileRulesOf, type FileRule } from 'src/permissions/filePermissions/fileRules/ruleSelection.js'
import {
  checkEditableInternalPath,
  getClaudeSkillScope,
} from 'src/permissions/filePermissions/internalPaths.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from 'src/tools/FileEditTool/constants.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

const WHOLE_TREE_SUFFIX = '/**'
const TRAVERSAL = '..'

/** Where a `.claudin` grant must be written: `/.claudin/` or `~/.claudin/`. */
const CLAUDIN_GRANT_PREFIXES = [
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
].map(pattern => pattern.slice(0, -'**'.length))

/** The `Edit` deny rule that covers any spelling of the target, if one does. */
export function editDenyRuleFor(target: FileTarget, context: ToolPermissionContext): PermissionRule | null {
  return ruleCoveringAny(target.resolved, context, 'edit', 'deny')
}

function editDeniedDecision(path: string, rule: PermissionRule): PermissionDecision {
  return {
    behavior: 'deny',
    message: editDeniedMessage(path),
    decisionReason: { type: 'rule', rule },
  }
}

const denyByEditRule: CheckStep = check => {
  const rule = editDenyRuleFor(check.target, check.context)
  return rule ? editDeniedDecision(check.target.path, rule) : null
}

const allowHarnessEditable: CheckStep = ({ target, input }) => {
  const verdict = checkEditableInternalPath(target.path, input)
  return verdict.behavior === 'allow' ? verdict : null
}

/**
 * The one way an allow rule opens a protected `.claudin` path: a session rule
 * written under `.claudin/`, ending in `/**`, with no `..` anywhere.
 */
function isClaudinSessionGrant({ rule, text }: FileRule): boolean {
  return (
    rule.source === 'session' &&
    CLAUDIN_GRANT_PREFIXES.some(prefix => text.startsWith(prefix)) &&
    text.endsWith(WHOLE_TREE_SUFFIX) &&
    !text.includes(TRAVERSAL)
  )
}

const allowClaudinSessionGrant: CheckStep = ({ target, input, context }) => {
  const grants = fileRulesOf(context, 'edit', 'allow').filter(isClaudinSessionGrant)
  const rule = ruleAmongCoveringAny([target.path], grants, 'allow')
  return rule ? { behavior: 'allow', updatedInput: input, decisionReason: { type: 'rule', rule } } : null
}

function protectedPathSuggestions({ target, context }: FileCheck): PermissionUpdate[] {
  const skill = getClaudeSkillScope(target.path)
  if (!skill) return suggestionsFor(target.path, 'write', context, target.resolved)
  return [
    {
      type: 'addRules',
      rules: [{ toolName: FILE_EDIT_TOOL_NAME, ruleContent: skill.pattern }],
      behavior: 'allow',
      destination: 'session',
    },
  ]
}

/** Protected files ask under every mode and every allow rule but the grant above. */
const askForProtectedPath: CheckStep = check => {
  const safety = checkPathSafetyForAutoEdit(check.target.path, check.target.resolved)
  if (safety.safe) return null
  return {
    behavior: 'ask',
    message: safety.message,
    decisionReason: {
      type: 'safetyCheck',
      reason: safety.message,
      classifierApprovable: safety.classifierApprovable,
    },
    suggestions: protectedPathSuggestions(check),
  }
}

const askByEditRule: CheckStep = ({ target, context }) => {
  const rule = ruleCoveringAny(target.resolved, context, 'edit', 'ask')
  if (!rule) return null
  return {
    behavior: 'ask',
    message: writeApprovalMessage(target.path),
    decisionReason: { type: 'rule', rule },
  }
}

const allowAcceptEditsInWorkingDir: CheckStep = ({ target, input, context }) => {
  if (context.mode !== 'acceptEdits') return null
  if (!pathInAllowedWorkingPath(target.path, context, target.resolved)) return null
  return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'mode', mode: 'acceptEdits' } }
}

/** Allow rules match the requested path only, not where its links lead (F6, pinned). */
const allowByEditRule: CheckStep = ({ target, input, context }) => {
  const rule = ruleCoveringAny([target.path], context, 'edit', 'allow')
  return rule ? { behavior: 'allow', updatedInput: input, decisionReason: { type: 'rule', rule } } : null
}

function askToWrite({ target, context }: FileCheck): PermissionDecision {
  const inside = pathInAllowedWorkingPath(target.path, context, target.resolved)
  return {
    behavior: 'ask',
    message: writeApprovalMessage(target.path),
    suggestions: suggestionsFor(target.path, 'write', context, target.resolved),
    ...(inside ? {} : { decisionReason: { type: 'workingDir', reason: OUTSIDE_WORKING_DIRS } }),
  }
}

const WRITE_STEPS: readonly CheckStep[] = [
  denyByEditRule,
  allowHarnessEditable,
  allowClaudinSessionGrant,
  askForProtectedPath,
  askByEditRule,
  allowAcceptEditsInWorkingDir,
  allowByEditRule,
]

/** The write check for one resolved file. */
export function decideWrite(check: FileCheck): PermissionDecision {
  return runSteps(check, WRITE_STEPS, askToWrite)
}
