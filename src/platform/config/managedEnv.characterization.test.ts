/**
 * Pins what the two settings-to-environment entry points of managedEnv.ts do
 * to `process.env`, before the remote-managed-settings cut edits the file.
 *
 * Every source is a real file or a real setter: a temp CLAUDIN_CONFIG_DIR
 * holds the user settings.json, a temp project dir holds .claudin/settings.json,
 * the inline --settings value goes through setFlagSettingsInline, and the
 * global config is the test singleton. Nothing here is mocked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import axios from 'axios'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from 'src/platform/config/managedEnv.js'
import { saveGlobalConfig } from 'src/platform/config/config.js'
import {
  getAllowedSettingSources,
  getOriginalCwd,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

type EnvMap = Record<string, string>

const envBefore = { ...process.env }
const cwdBefore = getOriginalCwd()
const sourcesBefore = [...getAllowedSettingSources()]
const dispatcherBefore = getGlobalDispatcher()
let scratch = ''

function putEnvBack(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envBefore)) {
    process.env[key] = value
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

/** Lays out the user and project settings files, then drops every cache. */
function layout(sources: { user?: EnvMap; project?: EnvMap; local?: EnvMap; global?: EnvMap; flag?: EnvMap }): void {
  const userDir = join(scratch, 'config')
  const projectDir = join(scratch, 'project')
  mkdirSync(join(projectDir, '.claudin'), { recursive: true })
  mkdirSync(userDir, { recursive: true })
  writeJson(join(userDir, 'settings.json'), { env: sources.user ?? {} })
  writeJson(join(projectDir, '.claudin', 'settings.json'), { env: sources.project ?? {} })
  writeJson(join(projectDir, '.claudin', 'settings.local.json'), { env: sources.local ?? {} })
  process.env.CLAUDIN_CONFIG_DIR = userDir
  setOriginalCwd(projectDir)
  saveGlobalConfig(current => ({ ...current, env: sources.global ?? {} }))
  setFlagSettingsInline(sources.flag ? { env: sources.flag } : null)
  resetSettingsCache()
}

function readEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]))
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'managed-env-char-'))
  setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
})

afterEach(() => {
  putEnvBack()
  setOriginalCwd(cwdBefore)
  setAllowedSettingSources(sourcesBefore)
  setFlagSettingsInline(null)
  saveGlobalConfig(current => ({ ...current, env: {} }))
  resetSettingsCache()
  rmSync(scratch, { recursive: true, force: true })
})

afterAll(() => {
  setGlobalDispatcher(dispatcherBefore)
})

describe('applySafeConfigEnvironmentVariables', () => {
  test('trusted sources land whole, project sources only through the allowlist', () => {
    layout({
      global: { CHAR_ME_FROM_GLOBAL: 'g' },
      user: { CHAR_ME_FROM_USER: 'u', BASH_MAX_OUTPUT_LENGTH: '111' },
      flag: { CHAR_ME_FROM_FLAG: 'f' },
      project: { CHAR_ME_FROM_PROJECT: 'p', CLAUDIN_DISABLE_TERMINAL_TITLE: '1' },
      local: { CHAR_ME_FROM_LOCAL: 'l', BASH_MAX_OUTPUT_LENGTH: '333' },
    })

    applySafeConfigEnvironmentVariables()

    expect(
      readEnv([
        'CHAR_ME_FROM_GLOBAL',
        'CHAR_ME_FROM_USER',
        'CHAR_ME_FROM_FLAG',
        'CHAR_ME_FROM_PROJECT',
        'CHAR_ME_FROM_LOCAL',
        'CLAUDIN_DISABLE_TERMINAL_TITLE',
        'BASH_MAX_OUTPUT_LENGTH',
      ]),
    ).toEqual({
      CHAR_ME_FROM_GLOBAL: 'g',
      CHAR_ME_FROM_USER: 'u',
      CHAR_ME_FROM_FLAG: 'f',
      // A repository could commit these, so only allowlisted names apply
      // before trust.
      CHAR_ME_FROM_PROJECT: undefined,
      CHAR_ME_FROM_LOCAL: undefined,
      CLAUDIN_DISABLE_TERMINAL_TITLE: '1',
      // The merged value wins for an allowlisted name: local over user.
      BASH_MAX_OUTPUT_LENGTH: '333',
    })
  })

  test('user settings win over the global config for the same name', () => {
    layout({
      global: { CHAR_ME_SHARED: 'from-global' },
      user: { CHAR_ME_SHARED: 'from-user' },
    })
    applySafeConfigEnvironmentVariables()
    expect(process.env.CHAR_ME_SHARED).toBe('from-user')
  })

  test('user settings are skipped once the session disallows that source', () => {
    layout({
      user: { CHAR_ME_FROM_USER: 'u' },
      flag: { CHAR_ME_FROM_FLAG: 'f' },
    })
    setAllowedSettingSources([])
    resetSettingsCache()

    applySafeConfigEnvironmentVariables()

    expect(readEnv(['CHAR_ME_FROM_USER', 'CHAR_ME_FROM_FLAG'])).toEqual({
      CHAR_ME_FROM_USER: undefined,
      CHAR_ME_FROM_FLAG: 'f',
    })
  })

  const hostCases: { name: string; hostEnv: EnvMap; settings: EnvMap; expected: Record<string, string | undefined> }[] = [
    {
      name: 'a host that owns routing keeps provider variables out of settings',
      hostEnv: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' },
      settings: {
        ANTHROPIC_BASE_URL: 'http://settings.invalid',
        ANTHROPIC_MODEL: 'settings-model',
        VERTEX_REGION_CLAUDE_CHAR_ME: 'eu',
        CHAR_ME_UNRELATED: 'kept',
      },
      expected: {
        ANTHROPIC_BASE_URL: undefined,
        ANTHROPIC_MODEL: undefined,
        VERTEX_REGION_CLAUDE_CHAR_ME: undefined,
        CHAR_ME_UNRELATED: 'kept',
      },
    },
    {
      name: 'a host flag that is not truthy filters nothing',
      hostEnv: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0' },
      settings: { ANTHROPIC_BASE_URL: 'http://settings.invalid' },
      expected: { ANTHROPIC_BASE_URL: 'http://settings.invalid' },
    },
    {
      name: 'an ssh tunnel socket keeps the placeholder auth variables',
      hostEnv: { ANTHROPIC_UNIX_SOCKET: join(tmpdir(), 'char-me.sock') },
      settings: {
        ANTHROPIC_BASE_URL: 'http://settings.invalid',
        ANTHROPIC_API_KEY: 'settings-key',
        ANTHROPIC_AUTH_TOKEN: 'settings-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'settings-oauth',
        CHAR_ME_UNRELATED: 'kept',
      },
      expected: {
        ANTHROPIC_BASE_URL: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CHAR_ME_UNRELATED: 'kept',
      },
    },
  ]

  for (const { name, hostEnv, settings, expected } of hostCases) {
    test(name, () => {
      for (const key of Object.keys(expected)) delete process.env[key]
      Object.assign(process.env, hostEnv)
      layout({ user: settings, global: settings })
      applySafeConfigEnvironmentVariables()
      expect(readEnv(Object.keys(expected))).toEqual(expected)
    })
  }

  // The spawn snapshot is taken on the first call in a process, so each case
  // runs in a process of its own.
  const entrypointCases = [
    { entrypoint: 'claude-desktop', spawned: 'host-value' },
    { entrypoint: 'cli', spawned: 'settings-value' },
  ]
  for (const { entrypoint, spawned } of entrypointCases) {
    test(`entrypoint ${entrypoint}: a key set at spawn ends as ${spawned}`, () => {
      layout({
        user: { CHAR_ME_SPAWNED: 'settings-value', CHAR_ME_LATER: 'settings-value' },
      })
      const managedEnvPath = JSON.stringify(join(import.meta.dir, 'managedEnv.ts'))
      const cachePath = JSON.stringify(join(import.meta.dir, '../settings/settingsCache.ts'))
      const edited = JSON.stringify({ env: { CHAR_ME_LATER: 'edited', CHAR_ME_SPAWNED: 'edited' } })
      const script = `
        const m = await import(${managedEnvPath});
        const cache = await import(${cachePath});
        m.applySafeConfigEnvironmentVariables();
        const first = { spawned: process.env.CHAR_ME_SPAWNED, later: process.env.CHAR_ME_LATER };
        await Bun.write(process.env.CHAR_ME_SETTINGS, ${JSON.stringify(edited)});
        cache.resetSettingsCache();
        m.applyConfigEnvironmentVariables();
        console.log(JSON.stringify({ first, later: process.env.CHAR_ME_LATER, spawned: process.env.CHAR_ME_SPAWNED }));
      `
      const run = Bun.spawnSync(['bun', '-e', script], {
        cwd: join(scratch, 'project'),
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          NODE_ENV: 'test',
          CLAUDIN_CONFIG_DIR: join(scratch, 'config'),
          CHAR_ME_SETTINGS: join(scratch, 'config', 'settings.json'),
          CLAUDE_CODE_ENTRYPOINT: entrypoint,
          CHAR_ME_SPAWNED: 'host-value',
        },
      })
      // An exit 0 with nothing on stdout did not run the script; say so.
      expect({ exit: run.exitCode, stderr: run.exitCode === 0 ? '' : run.stderr.toString() }).toEqual({ exit: 0, stderr: '' })
      const lastLine = run.stdout.toString().trim().split('\n').at(-1) ?? ''
      expect(JSON.parse(lastLine)).toEqual({
        first: { spawned, later: 'settings-value' },
        // A key the settings added after the snapshot can still change.
        later: 'edited',
        spawned: spawned === 'host-value' ? 'host-value' : 'edited',
      })
    })
  }
})

describe('applyConfigEnvironmentVariables', () => {
  test('after trust, every source applies, project-scoped names included', () => {
    layout({
      global: { CHAR_ME_FROM_GLOBAL: 'g' },
      user: { CHAR_ME_FROM_USER: 'u' },
      project: { CHAR_ME_FROM_PROJECT: 'p' },
      local: { CHAR_ME_FROM_LOCAL: 'l', CHAR_ME_FROM_USER: 'local-wins' },
    })

    applyConfigEnvironmentVariables()

    expect(
      readEnv(['CHAR_ME_FROM_GLOBAL', 'CHAR_ME_FROM_USER', 'CHAR_ME_FROM_PROJECT', 'CHAR_ME_FROM_LOCAL']),
    ).toEqual({
      CHAR_ME_FROM_GLOBAL: 'g',
      CHAR_ME_FROM_USER: 'local-wins',
      CHAR_ME_FROM_PROJECT: 'p',
      CHAR_ME_FROM_LOCAL: 'l',
    })
  })

  test('the host-routing filter holds after trust too', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = 'true'
    delete process.env.ANTHROPIC_BASE_URL
    layout({ project: { ANTHROPIC_BASE_URL: 'http://project.invalid', CHAR_ME_KEPT: 'k' } })
    applyConfigEnvironmentVariables()
    expect(readEnv(['ANTHROPIC_BASE_URL', 'CHAR_ME_KEPT'])).toEqual({
      ANTHROPIC_BASE_URL: undefined,
      CHAR_ME_KEPT: 'k',
    })
  })

  test('a proxy named in settings reconfigures outgoing HTTP, and leaving it reverts', () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      delete process.env[key]
    }
    layout({ project: { HTTPS_PROXY: 'http://127.0.0.1:9' } })
    applyConfigEnvironmentVariables()
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    expect(axios.defaults.proxy).toBe(false)

    delete process.env.HTTPS_PROXY
    layout({})
    applyConfigEnvironmentVariables()
    expect(axios.defaults.proxy).toBeUndefined()
  })
})
