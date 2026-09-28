import * as nodePath from 'path'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { sanitizePath } from 'src/sessions/sessionStoragePortable.js'
import {
  stripTrailingSeparators,
  validateMemoryDirOverride,
} from 'src/memory/memdir/location/overrideValidation.js'

declare const endsWithSeparator: unique symbol

/** A directory path ending in exactly one separator, NFC-normalized. */
type MemoryDirPath = string & { readonly [endsWithSeparator]: true }

function toMemoryDirPath(path: string): MemoryDirPath {
  const bare = stripTrailingSeparators(path, nodePath)
  // Branding is the one place a plain string becomes a MemoryDirPath.
  return `${bare}${nodePath.sep}`.normalize('NFC') as MemoryDirPath
}

/**
 * The settings layers that may place memory, highest first. The project's
 * checked-in settings are left out on purpose: the memory directory is
 * auto-approved for writes, so a cloned repository must not choose it.
 */
const TRUSTED_LOCATION_SOURCES = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'userSettings',
] as const satisfies readonly SettingSource[]

export type TrustedLocationSource = (typeof TRUSTED_LOCATION_SOURCES)[number]

export type LocationSettings = {
  readonly autoMemoryDirectory?: unknown
  readonly autoMemoryProjectLocal?: unknown
}

export type MemoryLocationInputs = {
  readonly envOverride: string | undefined
  readonly readLayer: (
    source: TrustedLocationSource,
  ) => LocationSettings | null | undefined
  readonly homeDir: string
  readonly projectRoot: string
  /** The canonical repository root of the project, or null outside one. */
  readonly repoRoot: string | null
  readonly memoryBase: string
}

export type MemoryLocation =
  | { readonly kind: 'env-override'; readonly dir: MemoryDirPath }
  | { readonly kind: 'setting'; readonly dir: MemoryDirPath }
  | {
      readonly kind: 'project-local'
      readonly dir: MemoryDirPath
      readonly repoRoot: string
      /** Where memory goes if the project-local directory cannot be trusted. */
      readonly legacyDir: MemoryDirPath
    }
  | { readonly kind: 'legacy'; readonly dir: MemoryDirPath }

type LayerLookup =
  | { readonly defined: false }
  | { readonly defined: true; readonly value: unknown }

/** Decides where auto memory lives, without touching the filesystem. */
export function resolveMemoryLocation(
  inputs: MemoryLocationInputs,
): MemoryLocation {
  const fromEnv = validateMemoryDirOverride(inputs.envOverride, {
    expandHome: false,
    homeDir: inputs.homeDir,
  })
  if (fromEnv.ok) {
    return { kind: 'env-override', dir: toMemoryDirPath(fromEnv.dir) }
  }

  // The first layer that defines the key decides, even with a value that
  // fails validation: an empty string in local settings is how a project
  // opts out of a user-wide directory.
  const directorySetting = firstLayerDefining(inputs, 'autoMemoryDirectory')
  if (directorySetting.defined) {
    const fromSetting = validateMemoryDirOverride(directorySetting.value, {
      expandHome: true,
      homeDir: inputs.homeDir,
    })
    if (fromSetting.ok) {
      return { kind: 'setting', dir: toMemoryDirPath(fromSetting.dir) }
    }
  }

  const legacyDir = legacyMemoryDir(
    inputs.memoryBase,
    inputs.repoRoot ?? inputs.projectRoot,
  )
  const projectLocal = firstLayerDefining(inputs, 'autoMemoryProjectLocal')
  const projectLocalOff = projectLocal.defined && projectLocal.value === false
  if (inputs.repoRoot === null || projectLocalOff) {
    return { kind: 'legacy', dir: legacyDir }
  }
  return {
    kind: 'project-local',
    dir: toMemoryDirPath(nodePath.join(inputs.repoRoot, '.claudin', 'memory')),
    repoRoot: inputs.repoRoot,
    legacyDir,
  }
}

/** Shares its slug with the session transcripts directory of the same root. */
function legacyMemoryDir(memoryBase: string, root: string): MemoryDirPath {
  return toMemoryDirPath(
    nodePath.join(memoryBase, 'projects', sanitizePath(root), 'memory'),
  )
}

function firstLayerDefining(
  inputs: MemoryLocationInputs,
  key: keyof LocationSettings,
): LayerLookup {
  for (const source of TRUSTED_LOCATION_SOURCES) {
    const value = inputs.readLayer(source)?.[key]
    if (value !== undefined) return { defined: true, value }
  }
  return { defined: false }
}
