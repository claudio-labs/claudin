/**
 * Edits the `permissions` block of a user, project or local settings file,
 * starting from the file as written rather than from its validated read.
 */
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import {
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from 'src/platform/settings/settings.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import { stripBOM } from 'src/shared/data/jsonRead.js'
import { isENOENT } from 'src/shared/errors.js'
import { readFileSync } from 'src/shared/fs/fileRead.js'
import { logError } from 'src/shared/log.js'
import type { PermissionBehavior } from 'src/permissions/PermissionRule.js'

/** The `permissions` object of a settings file, unvalidated. */
type PermissionsAsWritten = Readonly<Record<string, unknown>>

/** Keys of `permissions` to set. A list replaces the list on disk. */
export type PermissionsPatch = Record<string, unknown>

/**
 * - `written`: the file now holds the edit.
 * - `unchanged`: the edit had nothing to do, and the file was not touched.
 * - `refused`: the source is not an editable file, or its text is not a
 *   JSON object that could be edited without losing what is there.
 * - `failed`: the settings writer reported an error.
 */
type SettingsEditOutcome = 'written' | 'unchanged' | 'refused' | 'failed'

const EDITABLE_SOURCES: ReadonlySet<string> = new Set<EditableSettingSource>([
  'userSettings',
  'projectSettings',
  'localSettings',
])

export function isEditableSource(source: string): source is EditableSettingSource {
  return EDITABLE_SOURCES.has(source)
}

const RULE_LIST_KEYS: readonly PermissionBehavior[] = ['allow', 'deny', 'ask']

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** null when the file exists but cannot be edited safely. */
function readPermissionsAsWritten(path: string): PermissionsAsWritten | null {
  let text: string
  try {
    text = readFileSync(path)
  } catch (error) {
    if (isENOENT(error)) return {}
    logError(error)
    return null
  }
  if (text.trim() === '') return {}

  // Parsed here, not through the shared memoized parser: the settings reader
  // filters rule lists in place on that parser's cached objects, so a cached
  // parse no longer holds the file as written.
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBOM(text))
  } catch {
    return null
  }
  if (!isJsonObject(parsed)) return null
  const permissions = parsed.permissions
  if (permissions === undefined) return {}
  return isJsonObject(permissions) ? permissions : null
}

/** A list under `permissions` (a rule list, `additionalDirectories`), if it is one. */
export function listAsWritten(
  permissions: PermissionsAsWritten,
  key: string,
): readonly unknown[] | undefined {
  const list = permissions[key]
  return Array.isArray(list) ? list : undefined
}

/**
 * Reads the file, hands its `permissions` to `edit`, and writes the patch
 * `edit` returns. A null patch writes nothing.
 */
export function editPermissionSettings(
  source: EditableSettingSource,
  edit: (permissions: PermissionsAsWritten) => PermissionsPatch | null,
): SettingsEditOutcome {
  if (!isEditableSource(source)) return 'refused'
  const path = getSettingsFilePathForSource(source)
  if (!path) return 'refused'

  const permissions = readPermissionsAsWritten(path)
  if (permissions === null) return 'refused'
  const patch = edit(permissions)
  if (patch === null) return 'unchanged'

  // The writer starts from the validated read of the file and replaces
  // arrays whole. Passing every rule list as written keeps the entries
  // validation skipped, which would otherwise vanish on any edit.
  const rawLists: PermissionsPatch = {}
  for (const key of RULE_LIST_KEYS) {
    const list = listAsWritten(permissions, key)
    if (list) rawLists[key] = [...list]
  }
  // The rule lists may hold entries the settings type rejects; they are
  // written back exactly as they were found.
  const settings = { permissions: { ...rawLists, ...patch } } as SettingsJson
  const { error } = updateSettingsForSource(source, settings)
  if (error) {
    logError(error)
    return 'failed'
  }
  return 'written'
}
