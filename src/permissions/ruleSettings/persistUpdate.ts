/**
 * Saves a permission update to the settings file its destination names. The
 * session and the command line are not files, so their updates are not saved.
 */
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from 'src/permissions/PermissionUpdateSchema.js'
import {
  appendRulesToFile,
  removeRulesFromFile,
  replaceRulesInFile,
} from 'src/permissions/ruleSettings/ruleFileEdits.js'
import {
  editPermissionSettings,
  isEditableSource,
  listAsWritten,
  type PermissionsPatch,
} from 'src/permissions/ruleSettings/settingsFileEdit.js'

const DIRECTORIES_KEY = 'additionalDirectories'

export function isFileDestination(
  destination: PermissionUpdateDestination,
): destination is EditableSettingSource {
  return isEditableSource(destination)
}

function addDirectoriesToFile(directories: readonly string[], file: EditableSettingSource): void {
  editPermissionSettings(file, permissions => {
    const current = listAsWritten(permissions, DIRECTORIES_KEY) ?? []
    const known = new Set<unknown>(current)
    const added: string[] = []
    for (const dir of directories) {
      if (known.has(dir)) continue
      known.add(dir)
      added.push(dir)
    }
    return added.length > 0 ? { [DIRECTORIES_KEY]: [...current, ...added] } : null
  })
}

function removeDirectoriesFromFile(directories: readonly string[], file: EditableSettingSource): void {
  editPermissionSettings(file, permissions => {
    const current = listAsWritten(permissions, DIRECTORIES_KEY)
    if (!current) return null
    const doomed = new Set<unknown>(directories)
    const kept = current.filter(dir => !doomed.has(dir))
    return kept.length < current.length ? { [DIRECTORIES_KEY]: kept } : null
  })
}

function setDefaultModeInFile(mode: string, file: EditableSettingSource): void {
  editPermissionSettings(file, (permissions): PermissionsPatch | null =>
    permissions.defaultMode === mode ? null : { defaultMode: mode },
  )
}

export function saveUpdate(update: PermissionUpdate): void {
  const file = update.destination
  if (!isFileDestination(file)) return
  switch (update.type) {
    case 'addRules':
      appendRulesToFile({ ruleValues: update.rules, ruleBehavior: update.behavior }, file)
      return
    case 'replaceRules':
      replaceRulesInFile({ ruleValues: update.rules, ruleBehavior: update.behavior }, file)
      return
    case 'removeRules':
      removeRulesFromFile({ ruleValues: update.rules, ruleBehavior: update.behavior }, file)
      return
    case 'setMode':
      setDefaultModeInFile(update.mode, file)
      return
    case 'addDirectories':
      addDirectoriesToFile(update.directories, file)
      return
    case 'removeDirectories':
      removeDirectoriesFromFile(update.directories, file)
      return
  }
}
