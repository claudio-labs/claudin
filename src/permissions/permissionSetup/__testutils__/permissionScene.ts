/**
 * A throwaway machine for the permission-setup suites.
 *
 * Every test gets a fresh temp tree holding each place a setting can come
 * from: the user's config home (CLAUDIN_CONFIG_DIR), a checkout with its own
 * `.claudin/` directory (the session's original directory), a `--settings`
 * file, and the administrator's managed directory. The managed directory is
 * normally a system path, so its memo is seeded with the temp one instead.
 * MDM and registry policy are fed in empty.
 *
 * The model is chosen the way `--model` chooses it, and the provider the way
 * `/provider` saves it: in the global config, which `bun test` keeps in
 * memory. Classifier probe results land in the config home, where the probe
 * itself would write them.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  getFlagSettingsPath,
  getMainLoopModelOverride,
  getOriginalCwd,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setHasExitedPlanMode,
  setMainLoopModelOverride,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { getHkcuSettings, getMdmSettings, setMdmSettingsCache } from 'src/platform/settings/mdm/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { _resetForTesting as clearAutoModeFlags } from 'src/permissions/autoModeState.js'
import { resetAutoModeGateCheck } from 'src/permissions/bypassPermissionsKillswitch.js'
import { getClassifierProbeKey } from 'src/permissions/classifierProbe.js'
import { writeClassifierProbe } from 'src/permissions/classifierProbeStore.js'

/** Where a settings file can live, from least to most authoritative. */
export type Layer = 'user' | 'project' | 'local' | 'flag' | 'managed'

export type Endpoint = { baseUrl: string; model: string }

export type PermissionScene = {
  /** The checkout the session starts in. */
  readonly checkout: string
  /** The temp root; anything a test needs beyond the layers goes under it. */
  readonly scratch: string
  /** Writes `json` as the settings file of `layer`, replacing any earlier one. */
  write(layer: Layer, json: Record<string, unknown>): void
  /** The model the session runs, as `--model` would set it. */
  useModel(model: string): void
  /** An OpenAI-compatible provider profile, made active; null removes all. */
  useProvider(endpoint: Endpoint | null): void
  /** Records a finished capability probe for `model` on the active endpoint. */
  recordProbe(endpoint: Endpoint, ok: boolean): void
}

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'PWD'] as const
const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]
const EMPTY_POLICY = { settings: {}, errors: [] }

export function usePermissionScene(): PermissionScene {
  let root = ''
  let paths: Record<Layer, string> = {} as Record<Layer, string>
  const saved = {
    env: {} as Record<string, string | undefined>,
    cwd: '',
    sources: [] as SettingSource[],
    flagPath: undefined as string | undefined,
    model: undefined as ReturnType<typeof getMainLoopModelOverride>,
    profiles: undefined as ReturnType<typeof getGlobalConfig>['providerProfiles'],
    activeProfile: undefined as string | undefined,
    mdm: getMdmSettings(),
    hkcu: getHkcuSettings(),
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) saved.env[key] = process.env[key]
    saved.cwd = getOriginalCwd()
    saved.sources = [...getAllowedSettingSources()]
    saved.flagPath = getFlagSettingsPath()
    saved.model = getMainLoopModelOverride()
    const config = getGlobalConfig()
    saved.profiles = config.providerProfiles
    saved.activeProfile = config.activeProviderProfileId
    saved.mdm = getMdmSettings()
    saved.hkcu = getHkcuSettings()
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved.env[key] === undefined) delete process.env[key]
      else process.env[key] = saved.env[key]
    }
    setOriginalCwd(saved.cwd)
    setAllowedSettingSources(saved.sources)
    setFlagSettingsPath(saved.flagPath)
    setMainLoopModelOverride(saved.model)
    saveGlobalConfig(c => ({ ...c, providerProfiles: saved.profiles, activeProviderProfileId: saved.activeProfile }))
    setMdmSettingsCache(saved.mdm, saved.hkcu)
    getManagedFilePath.cache.clear?.()
    getManagedSettingsDropInDir.cache.clear?.()
    resetSettingsCache()
  })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'perm-setup-')))
    const home = join(root, 'home')
    const checkout = join(root, 'checkout')
    const admin = join(root, 'admin')
    for (const dir of [home, join(checkout, '.claudin'), admin, join(root, 'cli')]) {
      mkdirSync(dir, { recursive: true })
    }
    paths = {
      user: join(home, 'settings.json'),
      project: join(checkout, '.claudin', 'settings.json'),
      local: join(checkout, '.claudin', 'settings.local.json'),
      flag: join(root, 'cli', 'settings.json'),
      managed: join(admin, 'managed-settings.json'),
    }
    process.env.CLAUDIN_CONFIG_DIR = home
    delete process.env.CLAUDE_CODE_REMOTE
    process.env.PWD = checkout
    setOriginalCwd(checkout)
    setAllowedSettingSources([...ALL_SOURCES])
    setFlagSettingsPath(undefined)
    setFlagSettingsInline(null)
    setMdmSettingsCache(EMPTY_POLICY, EMPTY_POLICY)
    getManagedFilePath.cache.set(undefined, admin)
    getManagedSettingsDropInDir.cache.set(undefined, join(admin, 'managed-settings.d'))
    setMainLoopModelOverride('claude-sonnet-4-6')
    saveGlobalConfig(c => ({ ...c, providerProfiles: [], activeProviderProfileId: undefined }))
    // The session-wide notices and flags a mode change raises start lowered.
    for (const lower of [setHasExitedPlanMode, setNeedsPlanModeExitAttachment, setNeedsAutoModeExitAttachment]) lower(false)
    clearAutoModeFlags()
    resetAutoModeGateCheck()
    resetSettingsCache()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  return {
    get checkout() {
      return getOriginalCwd()
    },
    get scratch() {
      return root
    },
    write(layer, json) {
      writeFileSync(paths[layer], JSON.stringify(json, null, 2))
      if (layer === 'flag') setFlagSettingsPath(paths.flag)
      resetSettingsCache()
    },
    useModel(model) {
      setMainLoopModelOverride(model)
    },
    useProvider(endpoint) {
      saveGlobalConfig(c => ({
        ...c,
        providerProfiles: endpoint
          ? [{ id: 'scene', name: 'Scene endpoint', provider: 'openai', baseUrl: endpoint.baseUrl, model: endpoint.model, apiKey: 'sk-scene' }]
          : [],
        activeProviderProfileId: endpoint ? 'scene' : undefined,
      }))
    },
    recordProbe(endpoint, ok) {
      const key = getClassifierProbeKey({ provider: 'openai_compat', ...endpoint })
      writeClassifierProbe(key, ok ? { ok, at: 'scene' } : { ok, at: 'scene', detail: 'no tool call' })
    },
  }
}
