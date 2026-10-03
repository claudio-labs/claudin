/**
 * A disposable settings world for the permissions rule-model suites.
 *
 * Each test gets a fresh temp root holding every layer the rule loader can
 * read: the user layer (CLAUDIN_CONFIG_DIR), the project and local layers
 * (the session's original directory), a --settings file, and the managed
 * directory. The registry layers (MDM and HKCU) are fed through their cache.
 * Git is cut off from the user's configuration, and HOME points into the
 * root, because a write to the local layer may ask git about ignores.
 *
 * Everything the world touches is put back after the file's last test.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setOriginalCwd,
  setUseCoworkPlugins,
} from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { getHkcuSettings, getMdmSettings, setMdmSettingsCache } from 'src/platform/settings/mdm/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

export type Layer = 'user' | 'project' | 'local' | 'flag' | 'managed'

export const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
] as const

const EMPTY_REGISTRY = { settings: {}, errors: [] }

export interface RuleModelWorld {
  /** The temp root of the current test. */
  root(): string
  /** The directory the project and local layers live under. */
  projectDir(): string
  /** Where a layer's settings file sits. */
  pathOf(layer: Layer): string
  /** Writes a layer: an object is written as JSON, a string as raw text. */
  put(layer: Layer, body: object | string): void
  /** Writes a drop-in file next to the managed settings file. */
  putDropIn(name: string, body: object): void
  /** The raw text of a layer, or null when the file does not exist. */
  text(layer: Layer): string | null
  /** The parsed JSON of a layer. */
  json(layer: Layer): Record<string, any>
  /** Feeds the admin registry layer (MDM) and the user registry layer (HKCU). */
  registry(mdm: object, hkcu?: object): void
  /** Restricts the setting sources, as --setting-sources does. */
  onlySources(sources: SettingSource[]): void
  /** Inline settings handed over by an SDK host. */
  inlineFlags(settings: object | null): void
}

export function useRuleModelWorld(label: string): RuleModelWorld {
  let root = ''
  const saved = {
    env: new Map<string, string | undefined>(),
    cwd: '',
    sources: [] as SettingSource[],
    flagPath: undefined as string | undefined,
    flagInline: null as Record<string, unknown> | null,
    cowork: false,
    mdm: getMdmSettings(),
    hkcu: getHkcuSettings(),
  }

  const dirs = () => ({
    config: join(root, 'home', '.claudin'),
    project: join(root, 'repo'),
    admin: join(root, 'admin'),
  })

  const pathOf = (layer: Layer): string => {
    const d = dirs()
    if (layer === 'user') return join(d.config, 'settings.json')
    if (layer === 'project') return join(d.project, '.claudin', 'settings.json')
    if (layer === 'local') return join(d.project, '.claudin', 'settings.local.json')
    if (layer === 'flag') return join(root, 'flags', 'session.json')
    return join(d.admin, 'managed-settings.json')
  }

  const write = (path: string, body: object | string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    resetSettingsCache()
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) saved.env.set(key, process.env[key])
    saved.cwd = getOriginalCwd()
    saved.sources = [...getAllowedSettingSources()]
    saved.flagPath = getFlagSettingsPath()
    saved.flagInline = getFlagSettingsInline()
    saved.cowork = getUseCoworkPlugins()
    saved.mdm = getMdmSettings()
    saved.hkcu = getHkcuSettings()
  })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)))
    const d = dirs()
    for (const dir of [d.config, d.project, d.admin]) mkdirSync(dir, { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = d.config
    process.env.HOME = join(root, 'home')
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
    setOriginalCwd(d.project)
    setAllowedSettingSources([...ALL_SOURCES])
    setFlagSettingsPath(undefined)
    setFlagSettingsInline(null)
    setUseCoworkPlugins(false)
    setMdmSettingsCache(EMPTY_REGISTRY, EMPTY_REGISTRY)
    getManagedFilePath.cache.set(undefined, d.admin)
    getManagedSettingsDropInDir.cache.set(undefined, join(d.admin, 'managed-settings.d'))
    resetSettingsCache()
  })

  afterEach(() => {
    getManagedFilePath.cache.delete(undefined)
    getManagedSettingsDropInDir.cache.delete(undefined)
    resetSettingsCache()
    rmSync(root, { recursive: true, force: true })
  })

  afterAll(() => {
    for (const [key, value] of saved.env) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setOriginalCwd(saved.cwd)
    setAllowedSettingSources(saved.sources)
    setFlagSettingsPath(saved.flagPath)
    setFlagSettingsInline(saved.flagInline)
    setUseCoworkPlugins(saved.cowork)
    setMdmSettingsCache(saved.mdm, saved.hkcu)
    resetSettingsCache()
  })

  return {
    root: () => root,
    projectDir: () => dirs().project,
    pathOf,
    put(layer, body) {
      if (layer === 'flag') setFlagSettingsPath(pathOf('flag'))
      write(pathOf(layer), body)
    },
    putDropIn(name, body) {
      write(join(dirs().admin, 'managed-settings.d', name), body)
    },
    text(layer) {
      const path = pathOf(layer)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    json(layer) {
      return JSON.parse(readFileSync(pathOf(layer), 'utf8'))
    },
    registry(mdm, hkcu = {}) {
      setMdmSettingsCache(
        { settings: mdm as SettingsJson, errors: [] },
        { settings: hkcu as SettingsJson, errors: [] },
      )
      resetSettingsCache()
    },
    onlySources(sources) {
      setAllowedSettingSources(sources)
      resetSettingsCache()
    },
    inlineFlags(settings) {
      setFlagSettingsInline(settings as Record<string, unknown> | null)
      resetSettingsCache()
    },
  }
}
