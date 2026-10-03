/**
 * mcp/core, part 4: the helpers in src/mcp/utils.ts that read settings and
 * session state.
 *
 * `getProjectMcpServerStatus` decides whether a server from the project's
 * `.mcp.json` may start without asking (approved), must not start (rejected),
 * or waits for the approval dialog (pending). That is a decision about what a
 * checked-out repository gets to run, so every layer that can answer it is
 * driven here through a real settings file, and so is the layer that must not.
 *
 * `describeMcpConfigFilePath` names the file behind each config scope.
 *
 * Each test owns a temp tree: the user layer under CLAUDIN_CONFIG_DIR, the
 * project and local layers under the session's directory, a --settings file,
 * and the admin directory (its memo is seeded, because /etc is not ours).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { describeMcpConfigFilePath, getProjectMcpServerStatus } from 'src/mcp/utils.js'
import type { ConfigScope } from 'src/mcp/types.js'
import {
  getAllowedSettingSources,
  getCwdState,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getIsInteractive,
  getOriginalCwd,
  setAllowedSettingSources,
  setCwdState,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { getHkcuSettings, getMdmSettings, setMdmSettingsCache } from 'src/platform/settings/mdm/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'

type Layer = 'user' | 'project' | 'local' | 'flag' | 'policy'
type Status = ReturnType<typeof getProjectMcpServerStatus>

const ALL_SOURCES: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
const EMPTY_MDM = { settings: {}, errors: [] }

let tree: { root: string; config: string; project: string; admin: string; flag: string }

const saved = {
  configDir: process.env.CLAUDIN_CONFIG_DIR,
  originalCwd: '',
  cwd: '',
  sources: [] as SettingSource[],
  flagPath: undefined as string | undefined,
  flagInline: null as Record<string, unknown> | null,
  interactive: false,
  mdm: getMdmSettings(),
  hkcu: getHkcuSettings(),
}

function forgetGlobalFile(): void {
  getGlobalClaudeFile.cache.clear?.()
}

beforeAll(() => {
  saved.originalCwd = getOriginalCwd()
  saved.cwd = getCwdState()
  saved.sources = [...getAllowedSettingSources()]
  saved.flagPath = getFlagSettingsPath()
  saved.flagInline = getFlagSettingsInline()
  saved.interactive = getIsInteractive()
})

afterAll(() => {
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  setOriginalCwd(saved.originalCwd)
  setCwdState(saved.cwd)
  setAllowedSettingSources(saved.sources)
  setFlagSettingsPath(saved.flagPath)
  setFlagSettingsInline(saved.flagInline)
  setIsInteractive(saved.interactive)
  setMdmSettingsCache(saved.mdm, saved.hkcu)
  forgetGlobalFile()
  resetSettingsCache()
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-core-approval-')))
  tree = {
    root,
    config: join(root, 'home', '.claudin'),
    project: join(root, 'repo'),
    admin: join(root, 'etc'),
    flag: join(root, 'flags', 'session.json'),
  }
  for (const dir of [tree.config, tree.project, tree.admin]) mkdirSync(dir, { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = tree.config
  setOriginalCwd(tree.project)
  setCwdState(tree.project)
  setAllowedSettingSources([...ALL_SOURCES])
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  setIsInteractive(true)
  setMdmSettingsCache(EMPTY_MDM, EMPTY_MDM)
  getManagedFilePath.cache.set(undefined, tree.admin)
  getManagedSettingsDropInDir.cache.set(undefined, join(tree.admin, 'managed-settings.d'))
  forgetGlobalFile()
  resetSettingsCache()
})

afterEach(() => {
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  setOriginalCwd(saved.originalCwd)
  setCwdState(saved.cwd)
  resetSettingsCache()
  rmSync(tree.root, { recursive: true, force: true })
})

function settingsFile(layer: Layer): string {
  switch (layer) {
    case 'user':
      return join(tree.config, 'settings.json')
    case 'project':
      return join(tree.project, '.claudin', 'settings.json')
    case 'local':
      return join(tree.project, '.claudin', 'settings.local.json')
    case 'flag':
      return tree.flag
    case 'policy':
      return join(tree.admin, 'managed-settings.json')
  }
}

function write(layers: Partial<Record<Layer, Record<string, unknown>>>): void {
  for (const [layer, content] of Object.entries(layers) as Array<[Layer, Record<string, unknown>]>) {
    const file = settingsFile(layer)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(content))
    if (layer === 'flag') setFlagSettingsPath(file)
  }
  resetSettingsCache()
}

type Session = { interactive?: boolean; sources?: SettingSource[] }
const WITHOUT_PROJECT: SettingSource[] = ['userSettings', 'localSettings']

describe('getProjectMcpServerStatus', () => {
  const cases: Array<[label: string, layers: Partial<Record<Layer, Record<string, unknown>>>, session: Session, server: string, out: Status]> = [
    ['no settings at all', {}, {}, 'github', 'pending'],
    ['listed as enabled in local settings', { local: { enabledMcpjsonServers: ['github'] } }, {}, 'github', 'approved'],
    ['another server is enabled', { local: { enabledMcpjsonServers: ['github'] } }, {}, 'sentry', 'pending'],
    ['listed as enabled in user settings', { user: { enabledMcpjsonServers: ['github'] } }, {}, 'github', 'approved'],
    ['enabled under a name that folds to the same', { local: { enabledMcpjsonServers: ['my.server'] } }, {}, 'my server', 'approved'],
    ['enabled list entries are compared folded on both sides', { local: { enabledMcpjsonServers: ['my_server'] } }, {}, 'my/server', 'approved'],
    ['enabling is case sensitive', { local: { enabledMcpjsonServers: ['GitHub'] } }, {}, 'github', 'pending'],
    ['every project server enabled', { local: { enableAllProjectMcpServers: true } }, {}, 'anything', 'approved'],
    ['enable-all explicitly off', { local: { enableAllProjectMcpServers: false } }, {}, 'anything', 'pending'],
    ['listed as disabled', { local: { disabledMcpjsonServers: ['github'] } }, {}, 'github', 'rejected'],
    ['disabled under a name that folds to the same', { local: { disabledMcpjsonServers: ['my.server'] } }, {}, 'my_server', 'rejected'],
    ['disabled beats enabled', { local: { enabledMcpjsonServers: ['github'], disabledMcpjsonServers: ['github'] } }, {}, 'github', 'rejected'],
    ['disabled beats enable-all', { local: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['github'] } }, {}, 'github', 'rejected'],
    ['disabled in one layer beats enabled in another', { user: { enabledMcpjsonServers: ['github'] }, local: { disabledMcpjsonServers: ['github'] } }, {}, 'github', 'rejected'],
    ['disabled beats bypass mode', { user: { skipDangerousModePermissionPrompt: true }, local: { disabledMcpjsonServers: ['github'] } }, {}, 'github', 'rejected'],
    ['disabled beats a non-interactive session', { local: { disabledMcpjsonServers: ['github'] } }, { interactive: false }, 'github', 'rejected'],
    ['bypass prompt accepted in user settings', { user: { skipDangerousModePermissionPrompt: true } }, {}, 'github', 'approved'],
    ['bypass prompt accepted in local settings', { local: { skipDangerousModePermissionPrompt: true } }, {}, 'github', 'approved'],
    ['bypass prompt accepted in a --settings file', { flag: { skipDangerousModePermissionPrompt: true } }, {}, 'github', 'approved'],
    ['bypass prompt accepted in managed settings', { policy: { skipDangerousModePermissionPrompt: true } }, {}, 'github', 'approved'],
    ['bypass prompt accepted by the repository itself does not count', { project: { skipDangerousModePermissionPrompt: true } }, {}, 'github', 'pending'],
    ['bypass prompt accepted, but project settings are not loaded', { user: { skipDangerousModePermissionPrompt: true } }, { sources: WITHOUT_PROJECT }, 'github', 'pending'],
    ['a non-interactive session', {}, { interactive: false }, 'github', 'approved'],
    ['a non-interactive session that does not load project settings', {}, { interactive: false, sources: WITHOUT_PROJECT }, 'github', 'pending'],
    ['enabled in local settings, project settings not loaded', { local: { enabledMcpjsonServers: ['github'] } }, { sources: WITHOUT_PROJECT }, 'github', 'approved'],
    // Kept for parity (see the spec's findings): the repository's own
    // settings file can list or enable-all its own .mcp.json servers.
    ['enabled by the repository\'s own settings file', { project: { enabledMcpjsonServers: ['github'] } }, {}, 'github', 'approved'],
    ['enable-all by the repository\'s own settings file', { project: { enableAllProjectMcpServers: true } }, {}, 'github', 'approved'],
    ['disabled by the repository\'s own settings file', { project: { disabledMcpjsonServers: ['github'] } }, { interactive: false }, 'github', 'rejected'],
  ]

  test.each(cases)('%s → %p', (_label, layers, session, server, out) => {
    write(layers)
    if (session.interactive !== undefined) setIsInteractive(session.interactive)
    if (session.sources) setAllowedSettingSources(session.sources)
    resetSettingsCache()
    expect(getProjectMcpServerStatus(server)).toBe(out)
  })

  test('a malformed settings file counts as no answer', () => {
    mkdirSync(join(tree.project, '.claudin'), { recursive: true })
    writeFileSync(settingsFile('local'), '{ "enabledMcpjsonServers": [')
    resetSettingsCache()
    expect(getProjectMcpServerStatus('github')).toBe('pending')
  })
})

describe('describeMcpConfigFilePath', () => {
  test('user scope is the global config file under the config directory', () => {
    expect(describeMcpConfigFilePath('user')).toBe(join(tree.config, 'config.json'))
    expect(describeMcpConfigFilePath('user')).toBe(getGlobalClaudeFile())
  })

  test('project scope is .mcp.json in the current directory, which may differ from where the session started', () => {
    const sub = join(tree.project, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    setCwdState(sub)
    expect(describeMcpConfigFilePath('project')).toBe(join(sub, '.mcp.json'))
  })

  test('local scope is the global config file, tagged with the current directory', () => {
    expect(describeMcpConfigFilePath('local')).toBe(`${join(tree.config, 'config.json')} [project: ${tree.project}]`)
  })

  test('enterprise scope is managed-mcp.json in the managed settings directory', () => {
    expect(describeMcpConfigFilePath('enterprise')).toBe(join(tree.admin, 'managed-mcp.json'))
  })

  const fixed: Array<[scope: ConfigScope, out: string]> = [
    ['dynamic', 'Dynamically configured'],
    ['claudeai', 'claude.ai'],
    ['managed', 'managed'],
  ]
  test.each(fixed)('%p scope reads %p', (scope, out) => {
    expect(describeMcpConfigFilePath(scope)).toBe(out)
  })
})
