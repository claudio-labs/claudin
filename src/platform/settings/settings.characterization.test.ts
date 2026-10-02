/**
 * Characterization of src/platform/settings/settings.ts, pinned before the
 * levers cut removes the remote-managed and policy-limits layers from it.
 *
 * What a caller sees: which settings.json files are read for each layer, how
 * the layers stack (scalars: the later layer wins; arrays: concatenated, each
 * value once), which layer the managed "policy" slot is taken from, what a
 * write does to the file on disk, and which layers a security-sensitive
 * question may consult.
 *
 * Every test gets its own temp tree: the user layer under CLAUDIN_CONFIG_DIR,
 * the project and local layers under the session's original directory, a
 * --settings file, and the admin directory (its memo is seeded, because
 * /etc/claude-code is not ours to write). The MDM/registry layer is fed
 * through setMdmSettingsCache, the same door the change detector's poll uses.
 * The remote-managed layer is never populated: it is being cut.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
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
import {
  AUTO_MODE_REPO_CONTROLLED_SOURCES,
  AUTO_MODE_TRUSTED_SOURCES,
  collectAutoModeConfig,
  getAutoModeConfig,
  getAutoModeConfigWithNotes,
  getInitialSettings,
  getManagedFileSettingsPresence,
  getManagedSettingsKeysForLogging,
  getPolicySettingsOrigin,
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
  getSettingsForSource,
  getSettingsRootPathForSource,
  getSettingsWithErrors,
  getSettingsWithSources,
  getUseAutoModeDuringPlan,
  hasAllowBypassPermissionsMode,
  hasAutoModeOptIn,
  hasSkipDangerousModePermissionPrompt,
  loadManagedFileSettings,
  parseSettingsFile,
  rawSettingsContainsKey,
  settingsMergeCustomizer,
  updateSettingsForSource,
} from 'src/platform/settings/settings.js'
import {
  clearPluginSettingsBase,
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from 'src/platform/settings/settingsCache.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

type Json = Record<string, unknown>
type Layer = 'user' | 'project' | 'local' | 'flag' | 'admin'

const TOUCHED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDE_CODE_USE_COWORK_PLUGINS'] as const
const NO_POLICY = { settings: {}, errors: [] }

let home: { root: string; config: string; project: string; admin: string; flagFile: string }

const before = {
  env: {} as Record<string, string | undefined>,
  cwd: '',
  allowed: [] as SettingSource[],
  flagPath: undefined as string | undefined,
  flagInline: null as Json | null,
  cowork: false,
  mdm: getMdmSettings(),
  hkcu: getHkcuSettings(),
  plugin: undefined as Json | undefined,
}

beforeAll(() => {
  for (const key of TOUCHED_ENV) before.env[key] = process.env[key]
  before.cwd = getOriginalCwd()
  before.allowed = [...getAllowedSettingSources()]
  before.flagPath = getFlagSettingsPath()
  before.flagInline = getFlagSettingsInline()
  before.cowork = getUseCoworkPlugins()
  before.mdm = getMdmSettings()
  before.hkcu = getHkcuSettings()
  before.plugin = getPluginSettingsBase()
})

afterAll(() => {
  for (const key of TOUCHED_ENV) {
    if (before.env[key] === undefined) delete process.env[key]
    else process.env[key] = before.env[key]
  }
  setOriginalCwd(before.cwd)
  setAllowedSettingSources(before.allowed)
  setFlagSettingsPath(before.flagPath)
  setFlagSettingsInline(before.flagInline)
  setUseCoworkPlugins(before.cowork)
  setMdmSettingsCache(before.mdm, before.hkcu)
  if (before.plugin) setPluginSettingsBase(before.plugin)
  else clearPluginSettingsBase()
  resetSettingsCache()
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'settings-layers-')))
  home = {
    root,
    config: join(root, 'config-home'),
    project: join(root, 'workspace'),
    admin: join(root, 'admin'),
    flagFile: join(root, 'cli', 'extra.json'),
  }
  for (const dir of [home.config, home.project, home.admin]) mkdirSync(dir, { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = home.config
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  setOriginalCwd(home.project)
  setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  setUseCoworkPlugins(false)
  setMdmSettingsCache(NO_POLICY, NO_POLICY)
  clearPluginSettingsBase()
  getManagedFilePath.cache.set(undefined, home.admin)
  getManagedSettingsDropInDir.cache.set(undefined, join(home.admin, 'managed-settings.d'))
  resetSettingsCache()
})

afterEach(() => {
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  setOriginalCwd(before.cwd)
  resetSettingsCache()
  rmSync(home.root, { recursive: true, force: true })
})

function fileOf(layer: Layer): string {
  switch (layer) {
    case 'user':
      return join(home.config, 'settings.json')
    case 'project':
      return join(home.project, '.claudin', 'settings.json')
    case 'local':
      return join(home.project, '.claudin', 'settings.local.json')
    case 'flag':
      return home.flagFile
    case 'admin':
      return join(home.admin, 'managed-settings.json')
  }
}

/** Writes raw text at `path`, creating its directory, and drops every cached read. */
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  resetSettingsCache()
}

function place(layer: Layer, content: Json): void {
  if (layer === 'flag') setFlagSettingsPath(home.flagFile)
  put(fileOf(layer), JSON.stringify(content))
}

function dropIn(name: string, content: Json | string): void {
  put(join(home.admin, 'managed-settings.d', name), typeof content === 'string' ? content : JSON.stringify(content))
}

function onDisk(layer: Layer): Json {
  return JSON.parse(readFileSync(fileOf(layer), 'utf8'))
}

function fromRegistry(mdm: Json, hkcu: Json = {}, mdmErrors: unknown[] = []): void {
  setMdmSettingsCache(
    { settings: mdm as SettingsJson, errors: mdmErrors as never[] },
    { settings: hkcu as SettingsJson, errors: [] },
  )
  resetSettingsCache()
}

describe('where each layer lives', () => {
  test('each source maps to a root directory and a file under it', () => {
    setFlagSettingsPath(home.flagFile)
    const expected: Array<[SettingSource, string, string | undefined]> = [
      ['userSettings', home.config, join(home.config, 'settings.json')],
      ['projectSettings', home.project, join(home.project, '.claudin/settings.json')],
      ['localSettings', home.project, join(home.project, '.claudin/settings.local.json')],
      ['policySettings', home.project, join(home.admin, 'managed-settings.json')],
      ['flagSettings', dirname(home.flagFile), home.flagFile],
    ]
    const located = (source: SettingSource) => [source, getSettingsRootPathForSource(source), getSettingsFilePathForSource(source)]
    expect(expected.map(([source]) => located(source))).toEqual(expected)
  })

  test('with no --settings file, the flag layer is rooted at the session directory and has no file', () => {
    expect([getSettingsRootPathForSource('flagSettings'), getSettingsFilePathForSource('flagSettings')]).toEqual([
      home.project,
      undefined,
    ])
  })

  test('the repository-relative names of the project and local files', () => {
    const names = (['projectSettings', 'localSettings'] as const).map(getRelativeSettingsFilePathForSource)
    expect(names).toEqual(['.claudin/settings.json', '.claudin/settings.local.json'])
  })

  test('cowork mode, by session flag or by environment, swaps the user file name', () => {
    const userFile = () => getSettingsFilePathForSource('userSettings')
    const seen: string[] = []
    seen.push(userFile()!)
    setUseCoworkPlugins(true)
    seen.push(userFile()!)
    setUseCoworkPlugins(false)
    process.env.CLAUDE_CODE_USE_COWORK_PLUGINS = '1'
    seen.push(userFile()!)
    expect(seen.map(path => path.slice(home.config.length + 1))).toEqual([
      'settings.json',
      'cowork_settings.json',
      'cowork_settings.json',
    ])
  })
})

describe('reading one file', () => {
  const cases: Array<{ name: string; text: string | null; settings: Json | null; errorPaths: string[] }> = [
    { name: 'a valid file', text: '{"model":"opus","cleanupPeriodDays":3}', settings: { model: 'opus', cleanupPeriodDays: 3 }, errorPaths: [] },
    { name: 'a blank file is an empty object', text: '  \n', settings: {}, errorPaths: [] },
    { name: 'a missing file', text: null, settings: null, errorPaths: [] },
    { name: 'a value of the wrong type rejects the whole file', text: '{"model":"x","cleanupPeriodDays":-4}', settings: null, errorPaths: ['cleanupPeriodDays'] },
    {
      name: 'a malformed permission rule is dropped, the rest kept',
      text: JSON.stringify({ model: 'kept', permissions: { allow: ['Bash(ls:*)', 42, 'Read'] } }),
      settings: { model: 'kept', permissions: { allow: ['Bash(ls:*)', 'Read'] } },
      errorPaths: ['permissions.allow'],
    },
  ]

  for (const { name, text, settings, errorPaths } of cases) {
    test(name, () => {
      const path = join(home.root, 'one', 'settings.json')
      if (text !== null) put(path, text)
      const result = parseSettingsFile(path)
      expect(result.settings).toEqual(settings)
      expect(result.errors.map(e => e.path)).toEqual(errorPaths)
      for (const error of result.errors) expect(error.file).toBe(path)
    })
  }

  test('a path that is a directory reads as nothing, without errors', () => {
    const path = join(home.root, 'is-a-dir')
    mkdirSync(path)
    expect(parseSettingsFile(path)).toEqual({ settings: null, errors: [] })
  })

  test('each read hands out its own copy, and the file is read once until the cache is reset', () => {
    const path = join(home.root, 'shared.json')
    put(path, JSON.stringify({ permissions: { allow: ['Read'] } }))
    const first = parseSettingsFile(path).settings!
    first.permissions!.allow!.push('Write')
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Edit'] } }))
    expect(parseSettingsFile(path).settings).toEqual({ permissions: { allow: ['Read'] } })
    resetSettingsCache()
    expect(parseSettingsFile(path).settings).toEqual({ permissions: { allow: ['Edit'] } })
  })
})

describe('stacking the layers', () => {
  test('a scalar comes from the highest layer that sets it, an array collects every layer once', () => {
    setPluginSettingsBase({ model: 'from-plugin', agent: 'plugin-agent' })
    place('user', { model: 'from-user', permissions: { allow: ['Read', 'Glob'] }, env: { A: 'user' } })
    place('project', { model: 'from-project', permissions: { allow: ['Glob', 'Grep'] }, env: { B: 'project' } })
    place('local', { model: 'from-local', permissions: { deny: ['Write'] } })
    place('flag', { model: 'from-flag', env: { A: 'flag' } })
    place('admin', { model: 'from-admin', permissions: { allow: ['Read', 'WebFetch'] } })

    const merged = getInitialSettings()
    expect(merged.model).toBe('from-admin')
    expect((merged as Json).agent).toBe('plugin-agent')
    expect(merged.permissions?.allow).toEqual(['Read', 'Glob', 'Grep', 'WebFetch'])
    expect(merged.permissions?.deny).toEqual(['Write'])
    expect(merged.env).toEqual({ A: 'flag', B: 'project' })
  })

  const ladder: Array<[Layer[], string | undefined]> = [
    [[], undefined],
    [['user'], 'user'],
    [['user', 'project'], 'project'],
    [['user', 'project', 'local'], 'local'],
    [['project', 'flag'], 'flag'],
    [['local', 'flag', 'admin'], 'admin'],
  ]
  for (const [layers, winner] of ladder) {
    test(`model set in [${layers.join(', ')}] resolves to ${winner ?? 'nothing'}`, () => {
      for (const layer of layers) place(layer, { model: layer })
      expect(getInitialSettings().model).toBe(winner)
    })
  }

  test('a layer that is not enabled for this session is skipped', () => {
    place('user', { model: 'user' })
    place('project', { model: 'project' })
    place('local', { model: 'local' })
    setAllowedSettingSources(['userSettings'])
    resetSettingsCache()
    expect(getInitialSettings().model).toBe('user')
  })

  test('inline --settings JSON lands on top of the --settings file; invalid inline JSON is ignored', () => {
    place('user', { model: 'user', permissions: { allow: ['Read'] } })
    place('flag', { model: 'flag-file', permissions: { allow: ['Grep'] } })
    setFlagSettingsInline({ model: 'flag-inline', permissions: { allow: ['Read', 'Edit'] } })
    resetSettingsCache()
    const merged = getInitialSettings()
    expect(merged.model).toBe('flag-inline')
    expect(merged.permissions?.allow).toEqual(['Read', 'Grep', 'Edit'])
    expect(getSettingsForSource('flagSettings')).toEqual({ model: 'flag-inline', permissions: { allow: ['Grep', 'Read', 'Edit'] } })

    setFlagSettingsInline({ cleanupPeriodDays: 'soon' })
    resetSettingsCache()
    expect(getInitialSettings().model).toBe('flag-file')
    expect(getSettingsForSource('flagSettings')).toEqual({ model: 'flag-file', permissions: { allow: ['Grep'] } })
  })

  test('inline --settings JSON without a --settings file is the whole flag layer', () => {
    setFlagSettingsInline({ model: 'only-inline' })
    resetSettingsCache()
    expect(getSettingsForSource('flagSettings')).toEqual({ model: 'only-inline' })
    expect(getInitialSettings().model).toBe('only-inline')
  })

  test('validation errors are gathered from every layer, and a file named twice is read once', () => {
    put(fileOf('user'), '{"cleanupPeriodDays":"weekly"}')
    put(fileOf('project'), JSON.stringify({ permissions: { deny: [false] } }))
    setFlagSettingsPath(fileOf('project'))
    resetSettingsCache()
    const { settings, errors } = getSettingsWithErrors()
    expect(settings).toEqual({ permissions: { deny: [] } })
    expect(errors.map(e => [e.file, e.path])).toEqual([
      [fileOf('user'), 'cleanupPeriodDays'],
      [fileOf('project'), 'permissions.deny'],
    ])
  })

  test('the merged result is kept for the session until the cache is reset', () => {
    place('user', { model: 'first' })
    expect(getInitialSettings().model).toBe('first')
    writeFileSync(fileOf('user'), JSON.stringify({ model: 'second' }))
    expect(getInitialSettings().model).toBe('first')
    resetSettingsCache()
    expect(getInitialSettings().model).toBe('second')
  })

  test('with sources: every non-empty layer in merge order, read fresh from disk', () => {
    place('user', { model: 'u' })
    put(fileOf('project'), '')
    place('local', { model: 'l', spinnerTipsEnabled: false })
    expect(getInitialSettings().model).toBe('l')
    writeFileSync(fileOf('local'), JSON.stringify({ spinnerTipsEnabled: true }))

    const view = getSettingsWithSources()
    expect(view.sources).toEqual([
      { source: 'userSettings', settings: { model: 'u' } },
      { source: 'localSettings', settings: { spinnerTipsEnabled: true } },
    ])
    expect(view.effective).toEqual({ model: 'u', spinnerTipsEnabled: true })
  })
})

describe('the managed (policy) slot', () => {
  test('the admin file is the base and drop-ins apply on top in name order', () => {
    place('admin', { model: 'base', permissions: { allow: ['Read'] }, cleanupPeriodDays: 1 })
    // Created out of name order, the highest name in the middle, so neither
    // the creation order nor its reverse matches the order that must win.
    dropIn('10-first.json', { model: 'first', permissions: { allow: ['Glob', 'Read'] }, cleanupPeriodDays: 9 })
    dropIn('30-last.json', { model: 'last', permissions: { allow: ['Grep'] } })
    dropIn('20-middle.json', { model: 'middle', permissions: { allow: ['Edit'] }, cleanupPeriodDays: 20 })
    dropIn('.hidden.json', { model: 'hidden' })
    dropIn('notes.txt', { model: 'text' })
    mkdirSync(join(home.admin, 'managed-settings.d', 'folder.json'))

    const { settings, errors } = loadManagedFileSettings()
    expect(errors).toEqual([])
    expect(settings).toEqual({ model: 'last', permissions: { allow: ['Read', 'Glob', 'Edit', 'Grep'] }, cleanupPeriodDays: 20 })
    expect(getSettingsForSource('policySettings')).toEqual(settings)
  })

  const presence: Array<{ name: string; base: Json | null; dropIns: Record<string, Json | string>; expected: { hasBase: boolean; hasDropIns: boolean }; settings: Json | null }> = [
    { name: 'nothing installed', base: null, dropIns: {}, expected: { hasBase: false, hasDropIns: false }, settings: null },
    { name: 'an empty base file', base: {}, dropIns: {}, expected: { hasBase: false, hasDropIns: false }, settings: null },
    { name: 'base only', base: { model: 'b' }, dropIns: {}, expected: { hasBase: true, hasDropIns: false }, settings: { model: 'b' } },
    { name: 'drop-ins only', base: null, dropIns: { 'a.json': { model: 'd' } }, expected: { hasBase: false, hasDropIns: true }, settings: { model: 'd' } },
    { name: 'a dotfile is not a drop-in', base: null, dropIns: { '.a.json': { model: 'd' } }, expected: { hasBase: false, hasDropIns: false }, settings: null },
    { name: 'both', base: { model: 'b' }, dropIns: { 'z.json': { spinnerTipsEnabled: false } }, expected: { hasBase: true, hasDropIns: true }, settings: { model: 'b', spinnerTipsEnabled: false } },
  ]
  for (const row of presence) {
    test(`presence and contents: ${row.name}`, () => {
      if (row.base) place('admin', row.base)
      for (const [name, content] of Object.entries(row.dropIns)) dropIn(name, content)
      expect(getManagedFileSettingsPresence()).toEqual(row.expected)
      expect(loadManagedFileSettings().settings).toEqual(row.settings)
    })
  }

  test('a broken drop-in reports its errors and does not block the others', () => {
    dropIn('10-bad.json', { cleanupPeriodDays: -1 })
    dropIn('20-good.json', { model: 'good' })
    const { settings, errors } = loadManagedFileSettings()
    expect(settings).toEqual({ model: 'good' })
    expect(errors.map(e => [e.file, e.path])).toEqual([[join(home.admin, 'managed-settings.d', '10-bad.json'), 'cleanupPeriodDays']])
    expect(getSettingsWithErrors().errors.map(e => e.path)).toEqual(['cleanupPeriodDays'])
  })

  test('when the drop-in path is not a directory, only the base counts', () => {
    place('admin', { model: 'base' })
    put(join(home.admin, 'managed-settings.d'), 'not a directory')
    expect(loadManagedFileSettings()).toEqual({ settings: { model: 'base' }, errors: [] })
    expect(getManagedFileSettingsPresence()).toEqual({ hasBase: true, hasDropIns: false })
  })

  const firstWins: Array<{ name: string; mdm: Json; file: Json | null; hkcu: Json; origin: string | null; model: string | undefined }> = [
    { name: 'no source at all', mdm: {}, file: null, hkcu: {}, origin: null, model: undefined },
    { name: 'MDM beats the admin file and HKCU', mdm: { model: 'mdm' }, file: { model: 'file' }, hkcu: { model: 'hkcu' }, origin: 'hklm', model: 'mdm' },
    { name: 'the admin file beats HKCU', mdm: {}, file: { model: 'file' }, hkcu: { model: 'hkcu' }, origin: 'file', model: 'file' },
    { name: 'HKCU only when nothing else is there', mdm: {}, file: null, hkcu: { model: 'hkcu' }, origin: 'hkcu', model: 'hkcu' },
  ]
  for (const row of firstWins) {
    test(`first source wins: ${row.name}`, () => {
      place('user', { model: 'user', permissions: { allow: ['Read'] } })
      if (row.file) place('admin', { ...row.file, permissions: { allow: ['Grep'] } })
      fromRegistry(row.mdm, row.hkcu)
      expect(getPolicySettingsOrigin()).toBe(row.origin as never)
      expect(getSettingsForSource('policySettings')?.model).toBe(row.model)
      const merged = getInitialSettings()
      expect(merged.model).toBe(row.model ?? 'user')
      // Only the winning source contributes: its siblings' arrays never leak in.
      expect(merged.permissions?.allow).toEqual(row.origin === 'file' ? ['Read', 'Grep'] : ['Read'])
    })
  }

  test('errors reported by the MDM reader surface with the rest', () => {
    const problem = { file: 'registry', path: 'model', message: 'not a string' }
    fromRegistry({ spinnerTipsEnabled: false }, {}, [problem])
    const { settings, errors } = getSettingsWithErrors()
    expect(settings.spinnerTipsEnabled).toBe(false)
    expect(errors).toEqual([problem as never])
  })
})

describe('writing a layer', () => {
  test('creates the directory and file, then merges later writes into what is there', () => {
    expect(updateSettingsForSource('projectSettings', { model: 'one', permissions: { allow: ['Read'] } })).toEqual({ error: null })
    expect(onDisk('project')).toEqual({ model: 'one', permissions: { allow: ['Read'] } })
    expect(readFileSync(fileOf('project'), 'utf8').endsWith('}\n')).toBe(true)
    expect(readFileSync(fileOf('project'), 'utf8')).toContain('\n  "model": "one"')

    updateSettingsForSource('projectSettings', { spinnerTipsEnabled: false, permissions: { deny: ['Write'] } })
    expect(onDisk('project')).toEqual({ model: 'one', spinnerTipsEnabled: false, permissions: { allow: ['Read'], deny: ['Write'] } })
  })

  test('an array given replaces the stored one; undefined deletes the key, even nested', () => {
    place('user', { model: 'm', env: { KEEP: '1', DROP: '2' }, permissions: { allow: ['Read', 'Grep'], defaultMode: 'plan' } })
    updateSettingsForSource('userSettings', {
      model: undefined,
      env: { DROP: undefined } as never,
      permissions: { allow: ['Edit'], defaultMode: undefined },
    })
    expect(onDisk('user')).toEqual({ env: { KEEP: '1' }, permissions: { allow: ['Edit'] } })
  })

  test('the next read sees the write without a manual reset', () => {
    place('local', { model: 'before' })
    expect(getInitialSettings().model).toBe('before')
    expect(getSettingsForSource('localSettings')?.model).toBe('before')
    updateSettingsForSource('localSettings', { model: 'after' })
    expect(getInitialSettings().model).toBe('after')
    expect(getSettingsForSource('localSettings')?.model).toBe('after')
  })

  test('a file that fails validation is merged into as raw JSON rather than replaced', () => {
    put(fileOf('user'), JSON.stringify({ cleanupPeriodDays: 'never', unknownKey: { a: 1 } }))
    expect(updateSettingsForSource('userSettings', { model: 'm' })).toEqual({ error: null })
    expect(onDisk('user')).toEqual({ cleanupPeriodDays: 'never', unknownKey: { a: 1 }, model: 'm' })
  })

  test('a file with broken JSON is left alone and the write reports why', () => {
    put(fileOf('user'), '{"model": "half')
    const { error } = updateSettingsForSource('userSettings', { model: 'm' })
    expect(error?.message).toBe(`Invalid JSON syntax in settings file at ${fileOf('user')}`)
    expect(readFileSync(fileOf('user'), 'utf8')).toBe('{"model": "half')
  })

  test('a JSON value that is not an object is overwritten', () => {
    put(fileOf('user'), '7')
    expect(updateSettingsForSource('userSettings', { model: 'm' })).toEqual({ error: null })
    expect(onDisk('user')).toEqual({ model: 'm' })
  })

  test('a file that cannot be read becomes an error naming the path', () => {
    mkdirSync(fileOf('user'))
    const { error } = updateSettingsForSource('userSettings', { model: 'm' })
    expect(error?.message.startsWith(`Failed to read raw settings from ${fileOf('user')}: `)).toBe(true)
  })

  test('the read-only layers ignore writes', () => {
    setFlagSettingsPath(home.flagFile)
    for (const source of ['policySettings', 'flagSettings'] as const) {
      expect(updateSettingsForSource(source as never, { model: 'm' })).toEqual({ error: null })
    }
    expect([existsSync(fileOf('admin')), existsSync(home.flagFile)]).toEqual([false, false])
  })
})

describe('questions only trusted layers may answer', () => {
  const sources: Array<[Layer, boolean]> = [
    ['user', true],
    ['project', false],
    ['local', true],
    ['flag', true],
    ['admin', true],
  ]
  for (const [layer, trusted] of sources) {
    test(`the ${layer} layer ${trusted ? 'can' : 'cannot'} skip the bypass prompt or allow bypass mode`, () => {
      expect([hasSkipDangerousModePermissionPrompt(), hasAllowBypassPermissionsMode()]).toEqual([false, false])
      place(layer, { skipDangerousModePermissionPrompt: true, permissions: { allowBypassPermissionsMode: true } })
      expect([hasSkipDangerousModePermissionPrompt(), hasAllowBypassPermissionsMode()]).toEqual([trusted, trusted])
    })
  }

  test('the auto mode answers stay at their defaults in a build without the classifier', () => {
    for (const layer of ['user', 'flag', 'admin'] as const) {
      place(layer, { skipAutoPermissionPrompt: true, useAutoModeDuringPlan: false, autoMode: { allow: ['run tests'] } })
    }
    expect([hasAutoModeOptIn(), getUseAutoModeDuringPlan(), getAutoModeConfig()]).toEqual([false, true, undefined])
    expect(getAutoModeConfigWithNotes()).toEqual({ config: undefined, dropped: [], ignoredSources: [] })
  })

  test('the auto mode collector reads the trusted layers and names the repository ones it ignores', () => {
    const fixtures: Partial<Record<SettingSource, Json>> = {
      userSettings: { autoMode: { allow: ['run the linter'], environment: ['ci box'] } },
      flagSettings: { autoMode: { soft_deny: ['push to main'], allow: ['run the linter'] } },
      policySettings: { autoMode: { allow: 'not a list' } },
      projectSettings: { autoMode: { allow: ['anything at all'] } },
      localSettings: { model: 'no auto mode here' },
    }
    const notes = collectAutoModeConfig(source => (fixtures[source] as SettingsJson | undefined) ?? null)
    expect(notes.config).toEqual({
      allow: ['run the linter', 'run the linter'],
      soft_deny: ['push to main'],
      environment: ['ci box'],
    })
    expect(notes.ignoredSources).toEqual(['projectSettings'])
    expect([...AUTO_MODE_TRUSTED_SOURCES, ...AUTO_MODE_REPO_CONTROLLED_SOURCES].sort()).toEqual(
      ['flagSettings', 'localSettings', 'policySettings', 'projectSettings', 'userSettings'],
    )
    expect(collectAutoModeConfig(() => null)).toEqual({ config: undefined, dropped: [], ignoredSources: [] })
  })
})

describe('helpers callers use directly', () => {
  test('the merge customizer joins arrays without repeats and defers on anything else', () => {
    const rows: Array<[unknown, unknown, unknown]> = [
      [['a', 'b'], ['b', 'c'], ['a', 'b', 'c']],
      [['a'], 'b', undefined],
      ['a', ['b'], undefined],
      [{ x: 1 }, { y: 2 }, undefined],
    ]
    expect(rows.map(([target, source]) => settingsMergeCustomizer(target, source))).toEqual(rows.map(row => row[2]))
  })

  test('logging keys: one level deep for permissions, sandbox and hooks, top level otherwise, sorted', () => {
    const keys = getManagedSettingsKeysForLogging({
      model: 'x',
      permissions: { deny: ['Write'], allow: ['Read'], madeUp: true },
      sandbox: { enabled: true, network: {} },
      hooks: { Stop: [], PreToolUse: [] },
      cleanupPeriodDays: 4,
      notASetting: 1,
    } as never)
    expect(keys).toEqual([
      'cleanupPeriodDays',
      'hooks.PreToolUse',
      'hooks.Stop',
      'model',
      'permissions.allow',
      'permissions.deny',
      'sandbox.enabled',
      'sandbox.network',
    ])
  })

  test('a raw key check sees invalid files but not the managed one', () => {
    put(fileOf('local'), '{"cleanupPeriodDays":"bad"}')
    put(fileOf('project'), '   ')
    place('admin', { model: 'managed' })
    setFlagSettingsPath(join(home.root, 'absent.json'))
    const asked = ['cleanupPeriodDays', 'model', 'spinnerTipsEnabled']
    expect(asked.map(rawSettingsContainsKey)).toEqual([true, false, false])
  })

  test('a raw key check survives an unreadable layer', () => {
    mkdirSync(fileOf('user'))
    place('local', { model: 'm' })
    expect(rawSettingsContainsKey('model')).toBe(true)
  })
})
