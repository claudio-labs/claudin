import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Capture the real config module before any prior test's mock.module leak
// (in particular utils/providerProfiles.test.ts replaces ./config.js with a
// stub that has no TEST_GLOBAL_CONFIG_FOR_TESTING write-through). We re-pin
// it here so getGlobalConfig / saveGlobalConfig used by claudioMigration
// see a real config we own. Restore in afterAll keeps the next file clean.
// Spread into plain objects so we hold a SNAPSHOT (not a live ESM namespace).
// Bun's `await import(...)` returns a live module record whose bindings mutate
// when the module is re-mocked later — so `mock.module(spec, () => realX)`
// otherwise hands back the most recent mock factory's exports.
const realConfig = { ...(await import('./config.js')) }
// Same defensive capture for providerProfiles — ProviderManager.test.tsx
// installs its own mock factory whose default `addProviderProfile` is
// `() => null`, which leaks across files. We re-pin the real module so the
// migration's profile-bootstrap path sees the genuine implementation.
const realProviderProfiles = { ...(await import('./providerProfiles.js')) }

let testConfigState: Record<string, unknown> = {}

afterAll(() => {
  mock.module('./config.js', () => realConfig)
  mock.module('./providerProfiles.js', () => realProviderProfiles)
})

// Use dynamic imports inside beforeAll so we get fresh bindings after any
// mock.module() leak from earlier files (e.g. ProviderManager.test.tsx mocks
// this same module to suppress its banner).
let formatMigrationReport: typeof import('./claudioMigration.js')['formatMigrationReport']
let legacyClaudeDirExists: typeof import('./claudioMigration.js')['legacyClaudeDirExists']
let legacyGlobalConfigExists: typeof import('./claudioMigration.js')['legacyGlobalConfigExists']
let migrateLegacyClaudeDir: typeof import('./claudioMigration.js')['migrateLegacyClaudeDir']
let shouldShowMigrationBanner: typeof import('./claudioMigration.js')['shouldShowMigrationBanner']

beforeAll(async () => {
  // Install mocks here (not at module top-level) so they're applied AFTER
  // any earlier file's afterAll-style mock restores, AND after any per-test
  // mocks installed by earlier files (e.g. ProviderManager.test.tsx's
  // `mockProviderManagerDependencies` which stubs addProviderProfile to
  // `() => null`).
  mock.module('./config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => testConfigState,
    saveGlobalConfig: (
      updater: (prev: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      testConfigState = updater(testConfigState)
    },
  }))
  // Provide minimal stubs for the providerProfiles surface that
  // `ensureAnthropicProfileFromCredentials` consumes. We don't want to depend
  // on the real module's full implementation here because earlier test files
  // (ProviderManager.test.tsx, geminiAuth.test.ts, etc.) install partial
  // mocks of `./providerProfiles.js` that leak across files via Bun's
  // shape-locked `mock.module`.
  mock.module('./providerProfiles.js', () => ({
    ...realProviderProfiles,
    getProviderProfiles: () =>
      ((testConfigState.providerProfiles ?? []) as unknown[]),
    getProviderPresetDefaults: (preset: string) => {
      if (preset === 'anthropic') {
        return {
          provider: 'anthropic',
          name: 'Anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          apiKey: '',
          requiresApiKey: true,
        }
      }
      return (
        realProviderProfiles as {
          getProviderPresetDefaults: (p: string) => unknown
        }
      ).getProviderPresetDefaults(preset)
    },
    addProviderProfile: (
      input: {
        provider: string
        name: string
        baseUrl: string
        model: string
      },
      options?: { makeActive?: boolean },
    ) => {
      const id = `provider_test_${Math.random().toString(16).slice(2, 8)}`
      const profile = {
        id,
        provider: input.provider,
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
      }
      const profiles = (testConfigState.providerProfiles ?? []) as unknown[]
      testConfigState = {
        ...testConfigState,
        providerProfiles: [...profiles, profile],
        activeProviderProfileId:
          options?.makeActive || !testConfigState.activeProviderProfileId
            ? id
            : testConfigState.activeProviderProfileId,
      }
      return profile
    },
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const mod = (await import(
    `./claudioMigration.js?ts=${nonce}`
  )) as typeof import('./claudioMigration.js')
  formatMigrationReport = mod.formatMigrationReport
  legacyClaudeDirExists = mod.legacyClaudeDirExists
  legacyGlobalConfigExists = mod.legacyGlobalConfigExists
  migrateLegacyClaudeDir = mod.migrateLegacyClaudeDir
  shouldShowMigrationBanner = mod.shouldShowMigrationBanner
})

function makeTempHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), 'claudio-mig-'))
  return {
    home,
    legacy: join(home, '.claude'),
    next: join(home, '.claudio'),
  }
}

function resetMigrationConfig(): void {
  testConfigState = {}
}

describe('migrateLegacyClaudeDir', () => {
  let dirs: { home: string; legacy: string; next: string }

  beforeEach(() => {
    dirs = makeTempHome()
    resetMigrationConfig()
  })

  afterEach(() => {
    resetMigrationConfig()
    try {
      rmSync(dirs.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('copies tokens, settings, CLAUDE.md, plugins, keybindings into ~/.claudio/', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a', refresh: 'b' }),
    )
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        mcpServers: { x: { type: 'stdio' } },
        verbose: true,
        agentRouting: { foo: 'bar' },
        agentModels: { baz: 'qux' },
      }),
    )
    writeFileSync(join(dirs.legacy, 'CLAUDE.md'), '# user instructions')
    writeFileSync(join(dirs.legacy, 'keybindings.json'), '{}')
    mkdirSync(join(dirs.legacy, 'plugins', 'plugin-a'), { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'plugins', 'plugin-a', 'manifest.json'),
      '{}',
    )
    mkdirSync(join(dirs.legacy, 'plugins', 'plugin-b'), { recursive: true })

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.tokens).toBeGreaterThan(0)
    expect(report.settingsKeys).toBe(3) // theme, mcpServers, verbose
    expect(report.claudeMd).toBe(true)
    expect(report.keybindings).toBe(true)
    expect(report.plugins).toBe(2)

    expect(existsSync(join(dirs.next, '.credentials.json'))).toBe(true)
    const credStat = statSync(join(dirs.next, '.credentials.json'))
    expect(credStat.mode & 0o777).toBe(0o600)

    const settings = JSON.parse(
      readFileSync(join(dirs.next, 'settings.json'), 'utf8'),
    )
    expect(settings.theme).toBe('dark')
    expect(settings.verbose).toBe(true)
    expect(settings.mcpServers).toEqual({ x: { type: 'stdio' } })
    // The whitelist must drop agentRouting / agentModels.
    expect(settings.agentRouting).toBeUndefined()
    expect(settings.agentModels).toBeUndefined()

    expect(readFileSync(join(dirs.next, 'CLAUDE.md'), 'utf8')).toBe(
      '# user instructions',
    )
    expect(existsSync(join(dirs.next, 'plugins', 'plugin-a', 'manifest.json'))).toBe(
      true,
    )
  })

  test('records the new claudeToClaudioMigratedAt flag after migration', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a' }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(typeof testConfigState.claudeToClaudioMigratedAt).toBe('string')
  })

  test('is idempotent — running twice does not duplicate files or errors', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a' }),
    )
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
    )
    writeFileSync(join(dirs.legacy, 'CLAUDE.md'), '# x')
    writeFileSync(join(dirs.legacy, 'keybindings.json'), '{}')

    const first = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(first.errors).toEqual([])
    expect(first.alreadyMigrated).toBe(false)

    const second = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(second.alreadyMigrated).toBe(true)
    expect(second.errors).toEqual([])

    // Files at destination remain untouched (single copy).
    expect(
      JSON.parse(readFileSync(join(dirs.next, 'settings.json'), 'utf8')).theme,
    ).toBe('dark')
  })

  test('non-destructive merge into existing settings.json', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(dirs.next, { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ theme: 'dark', verbose: true }),
    )
    writeFileSync(
      join(dirs.next, 'settings.json'),
      JSON.stringify({ theme: 'light', editorMode: 'normal' }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    const settings = JSON.parse(
      readFileSync(join(dirs.next, 'settings.json'), 'utf8'),
    )
    // Existing keys win.
    expect(settings.theme).toBe('light')
    expect(settings.editorMode).toBe('normal')
    // Missing key gets carried over.
    expect(settings.verbose).toBe(true)
  })

  test('does not overwrite an existing .credentials.json with different contents', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(dirs.next, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ a: 1 }),
    )
    writeFileSync(
      join(dirs.next, '.credentials.json'),
      JSON.stringify({ b: 2 }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    const dest = JSON.parse(
      readFileSync(join(dirs.next, '.credentials.json'), 'utf8'),
    )
    expect(dest.b).toBe(2)
    expect(dest.a).toBeUndefined()
    expect(report.warnings.length).toBe(1)
    expect(report.warnings[0]).toContain('.credentials.json')
    expect(report.warnings[0]).toContain('kept new file untouched')
    expect(report.tokens).toBe(0)
  })

  test('round-trips every whitelisted settings key and drops non-whitelisted ones', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    const legacySettings = {
      theme: 'dark',
      model: 'claude-sonnet-4-6',
      customApiKeyResponses: { approved: ['sk-x'], rejected: [] },
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      verbose: true,
      editorMode: 'vim',
      mcpServers: { x: { type: 'stdio' as const } },
      providerProfiles: [
        {
          id: 'p1',
          name: 'OpenAI',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
        },
      ],
      activeProviderProfileId: 'p1',
      // Non-whitelisted: must NOT cross over.
      agentRouting: { foo: 'bar' },
      agentModels: { baz: 'qux' },
    }
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify(legacySettings),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    // 9 whitelisted keys cross over.
    expect(report.settingsKeys).toBe(9)

    const settings = JSON.parse(
      readFileSync(join(dirs.next, 'settings.json'), 'utf8'),
    )
    expect(settings.theme).toBe('dark')
    expect(settings.model).toBe('claude-sonnet-4-6')
    expect(settings.customApiKeyResponses).toEqual({
      approved: ['sk-x'],
      rejected: [],
    })
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [] })
    expect(settings.verbose).toBe(true)
    expect(settings.editorMode).toBe('vim')
    expect(settings.mcpServers).toEqual({ x: { type: 'stdio' } })
    expect(settings.providerProfiles).toEqual(legacySettings.providerProfiles)
    expect(settings.activeProviderProfileId).toBe('p1')

    // Non-whitelisted keys must not appear at the destination.
    expect(settings.agentRouting).toBeUndefined()
    expect(settings.agentModels).toBeUndefined()
  })

  test('returns unmodified report when ~/.claude/ is absent', async () => {
    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(report.tokens).toBe(0)
    expect(report.settingsKeys).toBe(0)
    expect(report.globalConfigKeys).toBe(0)
    expect(report.claudeMd).toBe(false)
    expect(report.plugins).toBe(0)
    expect(report.skills).toBe(0)
    expect(report.agents).toBe(0)
    expect(report.commands).toBe(0)
    expect(report.keybindings).toBe(false)
    expect(report.errors).toEqual([])
  })

  test('creates Anthropic profile when claudeAiOauth credentials are migrated', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fake-access',
          refreshToken: 'fake-refresh',
          expiresAt: Date.now() + 1_000_000,
          scopes: [],
          subscriptionType: 'pro',
        },
      }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.anthropicProfileCreated).toBe(true)

    const profiles = (testConfigState.providerProfiles ?? []) as Array<{
      id: string
      provider: string
      name: string
      baseUrl: string
      model: string
    }>
    const anthropicProfile = profiles.find(p => p.provider === 'anthropic')
    expect(anthropicProfile).toBeDefined()
    expect(anthropicProfile!.baseUrl).toBe('https://api.anthropic.com')
    expect(testConfigState.activeProviderProfileId).toBe(anthropicProfile!.id)
  })

  test('skips Anthropic profile creation when one already exists', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fake-access',
          refreshToken: 'fake-refresh',
          expiresAt: Date.now() + 1_000_000,
          scopes: [],
          subscriptionType: 'pro',
        },
      }),
    )

    const preExistingProfile = {
      id: 'existing_anthropic',
      provider: 'anthropic',
      name: 'My Anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
    }
    testConfigState = {
      providerProfiles: [preExistingProfile],
      activeProviderProfileId: preExistingProfile.id,
    }

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.anthropicProfileCreated).toBe(false)

    const profiles = (testConfigState.providerProfiles ?? []) as Array<{
      id: string
      provider: string
      model: string
    }>
    expect(profiles.length).toBe(1)
    expect(profiles[0].id).toBe('existing_anthropic')
    expect(profiles[0].model).toBe('claude-sonnet-4-5')
  })

  test('does nothing when credentials lack claudeAiOauth', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ someOtherKey: 'value' }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.anthropicProfileCreated).toBe(false)

    const profiles = (testConfigState.providerProfiles ?? []) as unknown[]
    expect(profiles.length).toBe(0)
  })

  test('migrates global config from ~/.claude.json to <configDir>/config.json', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    const legacyGlobal = {
      userID: 'abc-123',
      oauthAccount: { emailAddress: 'a@b.c' },
      providerProfiles: [
        { id: 'p1', provider: 'openai', name: 'O', baseUrl: 'u', model: 'm' },
      ],
      activeProviderProfileId: 'p1',
      projects: { '/tmp/x': { lastSessionId: 'sess' } },
    }
    writeFileSync(
      join(dirs.home, '.claude.json'),
      JSON.stringify(legacyGlobal),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.globalConfigKeys).toBe(5)

    const newPath = join(dirs.next, 'config.json')
    expect(existsSync(newPath)).toBe(true)
    const written = JSON.parse(readFileSync(newPath, 'utf8'))
    expect(written.userID).toBe('abc-123')
    expect(written.oauthAccount).toEqual({ emailAddress: 'a@b.c' })
    expect(written.providerProfiles).toEqual(legacyGlobal.providerProfiles)
    expect(written.activeProviderProfileId).toBe('p1')
    expect(written.projects).toEqual(legacyGlobal.projects)
  })

  test('merges global config non-destructively when <configDir>/config.json already exists', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(dirs.next, { recursive: true })
    writeFileSync(
      join(dirs.home, '.claude.json'),
      JSON.stringify({ key: 'old', other: 'legacy' }),
    )
    writeFileSync(
      join(dirs.next, 'config.json'),
      JSON.stringify({ key: 'new' }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.globalConfigKeys).toBe(1)

    const written = JSON.parse(
      readFileSync(join(dirs.next, 'config.json'), 'utf8'),
    )
    expect(written.key).toBe('new')
    expect(written.other).toBe('legacy')
  })

  test('runs even when only legacy ~/.claude.json exists (no ~/.claude/ dir)', async () => {
    writeFileSync(
      join(dirs.home, '.claude.json'),
      JSON.stringify({ userID: 'abc' }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.globalConfigKeys).toBe(1)
    expect(existsSync(join(dirs.next, 'config.json'))).toBe(true)
  })

  test('copies skills/, agents/, and commands/ directories', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(join(dirs.legacy, 'skills', 'alpha'), { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'skills', 'alpha', 'SKILL.md'),
      '# alpha skill',
    )
    mkdirSync(join(dirs.legacy, 'skills', 'beta'), { recursive: true })

    mkdirSync(join(dirs.legacy, 'agents'), { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'agents', 'reviewer.md'),
      '# reviewer agent',
    )
    writeFileSync(
      join(dirs.legacy, 'agents', 'planner.md'),
      '# planner agent',
    )
    writeFileSync(
      join(dirs.legacy, 'agents', 'tester.md'),
      '# tester agent',
    )

    mkdirSync(join(dirs.legacy, 'commands'), { recursive: true })
    writeFileSync(join(dirs.legacy, 'commands', 'deploy.md'), '# deploy')

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.skills).toBe(2)
    expect(report.agents).toBe(3)
    expect(report.commands).toBe(1)

    expect(
      readFileSync(join(dirs.next, 'skills', 'alpha', 'SKILL.md'), 'utf8'),
    ).toBe('# alpha skill')
    expect(existsSync(join(dirs.next, 'skills', 'beta'))).toBe(true)
    expect(
      readFileSync(join(dirs.next, 'agents', 'reviewer.md'), 'utf8'),
    ).toBe('# reviewer agent')
    expect(
      readFileSync(join(dirs.next, 'commands', 'deploy.md'), 'utf8'),
    ).toBe('# deploy')
  })
})

describe('shouldShowMigrationBanner', () => {
  let dirs: { home: string; legacy: string; next: string }

  beforeEach(() => {
    dirs = makeTempHome()
    resetMigrationConfig()
  })

  afterEach(() => {
    resetMigrationConfig()
    try {
      rmSync(dirs.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('still shows when ~/.claudio/ already exists but legacy is unmigrated', () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(dirs.next, { recursive: true })
    writeFileSync(join(dirs.next, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    expect(shouldShowMigrationBanner(dirs.home)).toBe(true)
  })

  test('hides when ~/.claude/ does not exist', () => {
    expect(shouldShowMigrationBanner(dirs.home)).toBe(false)
  })

  test('hides after the user marks the migration skipped', () => {
    mkdirSync(dirs.legacy, { recursive: true })
    testConfigState = { legacyMigrationSkipped: true }
    expect(shouldShowMigrationBanner(dirs.home)).toBe(false)
  })

  test('hides after a migration has been recorded', () => {
    mkdirSync(dirs.legacy, { recursive: true })
    testConfigState = { claudeToClaudioMigratedAt: new Date().toISOString() }
    expect(shouldShowMigrationBanner(dirs.home)).toBe(false)
  })

  test('shows when ~/.claude/ exists and no flags set', () => {
    mkdirSync(dirs.legacy, { recursive: true })
    expect(shouldShowMigrationBanner(dirs.home)).toBe(true)
  })

  test('shows when only legacy ~/.claude.json exists (no ~/.claude/ dir)', () => {
    writeFileSync(join(dirs.home, '.claude.json'), '{}')
    expect(shouldShowMigrationBanner(dirs.home)).toBe(true)
  })
})

describe('legacyClaudeDirExists', () => {
  let dirs: { home: string; legacy: string; next: string }

  beforeEach(() => {
    dirs = makeTempHome()
  })

  afterEach(() => {
    try {
      rmSync(dirs.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('returns true when ~/.claude/ exists', () => {
    mkdirSync(dirs.legacy, { recursive: true })
    expect(legacyClaudeDirExists(dirs.home)).toBe(true)
  })

  test('returns false when ~/.claude/ does not exist', () => {
    expect(legacyClaudeDirExists(dirs.home)).toBe(false)
  })
})

describe('legacyGlobalConfigExists', () => {
  let dirs: { home: string; legacy: string; next: string }

  beforeEach(() => {
    dirs = makeTempHome()
  })

  afterEach(() => {
    try {
      rmSync(dirs.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('returns true when ~/.claude.json exists', () => {
    writeFileSync(join(dirs.home, '.claude.json'), '{}')
    expect(legacyGlobalConfigExists(dirs.home)).toBe(true)
  })

  test('returns false when ~/.claude.json does not exist', () => {
    expect(legacyGlobalConfigExists(dirs.home)).toBe(false)
  })
})

describe('formatMigrationReport', () => {
  test('summarises a successful run', () => {
    const summary = formatMigrationReport({
      tokens: 2,
      settingsKeys: 3,
      globalConfigKeys: 7,
      claudeMd: true,
      plugins: 4,
      skills: 5,
      agents: 2,
      commands: 1,
      keybindings: true,
      anthropicProfileCreated: true,
      errors: [],
      warnings: [],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudio',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('2 tokens')
    expect(summary).toContain('3 settings keys')
    expect(summary).toContain('7 global config keys')
    expect(summary).toContain('1 CLAUDE.md')
    expect(summary).toContain('4 plugins')
    expect(summary).toContain('5 skills')
    expect(summary).toContain('2 agents')
    expect(summary).toContain('1 command')
    expect(summary).toContain('keybindings copied')
    expect(summary).toContain('anthropic profile created')
    expect(summary).toContain('/home/x/.claude kept untouched')
  })

  test('summarises an idempotent re-run', () => {
    const summary = formatMigrationReport({
      tokens: 0,
      settingsKeys: 0,
      globalConfigKeys: 0,
      claudeMd: false,
      plugins: 0,
      skills: 0,
      agents: 0,
      commands: 0,
      keybindings: false,
      anthropicProfileCreated: false,
      errors: [],
      warnings: [],
      alreadyMigrated: true,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudio',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('nothing to do')
    expect(summary).toContain('--force')
  })

  test('surfaces warnings alongside the summary', () => {
    const summary = formatMigrationReport({
      tokens: 0,
      settingsKeys: 1,
      globalConfigKeys: 0,
      claudeMd: false,
      plugins: 0,
      skills: 0,
      agents: 0,
      commands: 0,
      keybindings: false,
      anthropicProfileCreated: false,
      errors: [],
      warnings: ['/home/x/.claudio/.credentials.json already exists with different content — kept new file untouched'],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudio',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('Warnings:')
    expect(summary).toContain('kept new file untouched')
  })

  test('summarises when anthropic profile already existed', () => {
    const summary = formatMigrationReport({
      tokens: 1,
      settingsKeys: 0,
      globalConfigKeys: 0,
      claudeMd: false,
      plugins: 0,
      skills: 0,
      agents: 0,
      commands: 0,
      keybindings: false,
      anthropicProfileCreated: false,
      errors: [],
      warnings: [],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudio',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('anthropic profile already present')
  })
})
