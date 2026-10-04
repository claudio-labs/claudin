import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type {
  AdditionalWorkingDirectory,
  PermissionBehavior,
  WorkingDirectorySource,
} from 'src/shared/types/permissions.js'
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import { toPosixPath } from 'src/shared/fs/path.js'
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from 'src/permissions/PermissionUpdateSchema.js'
import {
  canonicalRuleString,
  canonicalRuleValueString,
} from 'src/permissions/permissionRuleParser.js'
import {
  isFileDestination,
  saveUpdate,
} from 'src/permissions/ruleSettings/persistUpdate.js'

export type { WorkingDirectorySource }

/** The rules the `addRules` updates of a list grant, in order. */
export function extractRules(
  updates: PermissionUpdate[] | undefined,
): PermissionRuleValue[] {
  const granted: PermissionRuleValue[] = []
  for (const update of updates ?? []) {
    if (update.type === 'addRules') granted.push(...update.rules)
  }
  return granted
}

const RULES_KEY = {
  allow: 'alwaysAllowRules',
  deny: 'alwaysDenyRules',
  ask: 'alwaysAskRules',
} as const satisfies Record<PermissionBehavior, keyof ToolPermissionContext>

type RuleListEdit = (current: readonly string[]) => string[]

/**
 * A copy of the context with one destination's list of one behavior edited.
 * Lists are stored in canonical form so removal finds a rule however it was
 * first spelled.
 */
function withRuleList(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
  destination: PermissionUpdateDestination,
  edit: RuleListEdit,
): ToolPermissionContext {
  const key = RULES_KEY[behavior]
  const current = context[key]
  const bySource: typeof current = {
    ...current,
    [destination]: edit(current[destination] ?? []),
  }
  return { ...context, [key]: bySource }
}

function withDirectories(
  context: ToolPermissionContext,
  edit: (directories: Map<string, AdditionalWorkingDirectory>) => void,
): ToolPermissionContext {
  const directories = new Map(context.additionalWorkingDirectories)
  edit(directories)
  return { ...context, additionalWorkingDirectories: directories }
}

export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'addRules': {
      const added = update.rules.map(canonicalRuleValueString)
      return withRuleList(context, update.behavior, update.destination, current => [...current, ...added])
    }
    case 'replaceRules': {
      const replacement = update.rules.map(canonicalRuleValueString)
      return withRuleList(context, update.behavior, update.destination, () => replacement)
    }
    case 'removeRules': {
      const doomed = new Set(update.rules.map(canonicalRuleValueString))
      return withRuleList(context, update.behavior, update.destination, current =>
        current.filter(entry => !doomed.has(canonicalRuleString(entry))),
      )
    }
    case 'setMode':
      return { ...context, mode: update.mode }
    case 'addDirectories':
      return withDirectories(context, directories => {
        for (const path of update.directories) {
          directories.set(path, { path, source: update.destination })
        }
      })
    case 'removeDirectories':
      return withDirectories(context, directories => {
        for (const path of update.directories) directories.delete(path)
      })
    default:
      return context
  }
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  return updates.reduce(applyPermissionUpdate, context)
}

export function supportsPersistence(
  destination: PermissionUpdateDestination,
): destination is EditableSettingSource {
  return isFileDestination(destination)
}

export function persistPermissionUpdate(update: PermissionUpdate): void {
  saveUpdate(update)
}

export function persistPermissionUpdates(updates: PermissionUpdate[]): void {
  for (const update of updates) saveUpdate(update)
}

const DRIVE_ROOT = /^[A-Za-z]:[\\/]*$/

/**
 * One `Read` allow rule for everything under a directory. A root (`/`, `//`,
 * `C:\`, or an empty path) gets no suggestion: the rule would cover the whole
 * filesystem.
 */
export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  if (DRIVE_ROOT.test(dirPath)) return undefined
  const directory = toPosixPath(dirPath).replace(/\/+$/, '')
  if (directory === '') return undefined

  // An absolute path is written with a leading `//` in a rule, so that it is
  // not read relative to the settings file.
  const pattern = directory.startsWith('/') ? `/${directory}/**` : `${directory}/**`
  return {
    type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: pattern }],
    behavior: 'allow',
    destination,
  }
}
