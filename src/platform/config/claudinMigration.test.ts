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
// it here so getGlobalConfig / saveGlobalConfig used by claudinMigration
// see a real config we own. Restore in afterAll keeps the next file clean.
// Spread into plain objects so we hold a SNAPSHOT (not a live ESM namespace).
// Bun's `await import(...)` returns a live module record whose bindings mutate
// when the module is re-mocked later — so `mock.module(spec, () => realX)`
// otherwise hands back the most recent mock factory's exports.
const realConfig = { ...(await import('src/platform/config/config.js')) }
// Same defensive capture for providerProfiles — ProviderManager.test.tsx
// installs its own mock factory whose default `addProviderProfile` is
// `() => null`, which leaks across files. We re-pin the real module so the
// migration's profile-bootstrap path sees the genuine implementation.
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }

let testConfigState: Record<string, unknown> = {}

afterAll(() => {
  mock.module('./config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
  realConfig.resetGlobalConfigForTests?.()
})

// Use dynamic imports inside beforeAll so we get fresh bindings after any
// mock.module() leak from earlier files (e.g. ProviderManager.test.tsx mocks
// this same module to suppress its banner).
let formatMigrationReport: typeof import('src/platform/config/claudinMigration.js')['formatMigrationReport']
let legacyClaudeDirExists: typeof import('src/platform/config/claudinMigration.js')['legacyClaudeDirExists']
let legacyGlobalConfigExists: typeof import('src/platform/config/claudinMigration.js')['legacyGlobalConfigExists']
let migrateLegacyClaudeDir: typeof import('src/platform/config/claudinMigration.js')['migrateLegacyClaudeDir']
let shouldShowMigrationBanner: typeof import('src/platform/config/claudinMigration.js')['shouldShowMigrationBanner']

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
  mock.module('src/providers/presets/providerProfiles.js', () => ({
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
    `./claudinMigration.js?ts=${nonce}`
  )) as typeof import('src/platform/config/claudinMigration.js')
  formatMigrationReport = mod.formatMigrationReport
  legacyClaudeDirExists = mod.legacyClaudeDirExists
  legacyGlobalConfigExists = mod.legacyGlobalConfigExists
  migrateLegacyClaudeDir = mod.migrateLegacyClaudeDir
  shouldShowMigrationBanner = mod.shouldShowMigrationBanner
})

function makeTempHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), 'claudin-mig-'))
  return {
    home,
    legacy: join(home, '.claude'),
    next: join(home, '.claudin'),
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

  test('copies the sign-in — tokens and provider profiles — into ~/.claudin/', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a', refresh: 'b' }),
    )
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({
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
        agentRouting: { foo: 'bar' },
        agentModels: { baz: 'qux' },
      }),
    )

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    expect(report.tokens).toBeGreaterThan(0)
    expect(report.settingsKeys).toBe(2) // providerProfiles, activeProviderProfileId

    expect(existsSync(join(dirs.next, '.credentials.json'))).toBe(true)
    const credStat = statSync(join(dirs.next, '.credentials.json'))
    expect(credStat.mode & 0o777).toBe(0o600)

    const settings = JSON.parse(
      readFileSync(join(dirs.next, 'settings.json'), 'utf8'),
    )
    expect(settings.activeProviderProfileId).toBe('p1')
    expect(settings.providerProfiles).toHaveLength(1)
    // The whitelist must drop agentRouting / agentModels.
    expect(settings.agentRouting).toBeUndefined()
    expect(settings.agentModels).toBeUndefined()
  })

  // The migration is sign-in only since /import took over config transfer.
  // Content that ~/.claude/ carries must be left where it is, so that /import
  // is the single thing deciding what lands in ~/.claudin/ and what conflicts.
  test('leaves CLAUDE.md, skills, agents, commands, plugins and keybindings to /import', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a' }),
    )
    writeFileSync(join(dirs.legacy, 'CLAUDE.md'), '# user instructions')
    writeFileSync(join(dirs.legacy, 'keybindings.json'), '{}')
    mkdirSync(join(dirs.legacy, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(dirs.legacy, 'skills', 'alpha', 'SKILL.md'), '# alpha')
    mkdirSync(join(dirs.legacy, 'agents'), { recursive: true })
    writeFileSync(join(dirs.legacy, 'agents', 'reviewer.md'), '# reviewer')
    mkdirSync(join(dirs.legacy, 'commands'), { recursive: true })
    writeFileSync(join(dirs.legacy, 'commands', 'deploy.md'), '# deploy')
    mkdirSync(join(dirs.legacy, 'plugins', 'plugin-a'), { recursive: true })
    writeFileSync(join(dirs.legacy, 'plugins', 'plugin-a', 'manifest.json'), '{}')

    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })

    expect(report.errors).toEqual([])
    // The sign-in still crosses over, so this is not a no-op run.
    expect(report.tokens).toBeGreaterThan(0)

    for (const left of [
      'CLAUDE.md',
      'keybindings.json',
      'skills',
      'agents',
      'commands',
      'plugins',
    ]) {
      expect(existsSync(join(dirs.next, left))).toBe(false)
      // …and the source is untouched, ready for /import to read.
      expect(existsSync(join(dirs.legacy, left))).toBe(true)
    }
  })

  test('records the new claudeToClaudinMigratedAt flag after migration', async () => {
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
    expect(typeof testConfigState.claudeToClaudinMigratedAt).toBe('string')
  })

  test('is idempotent — running twice does not duplicate files or errors', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, '.credentials.json'),
      JSON.stringify({ access: 'a' }),
    )
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ activeProviderProfileId: 'p1' }),
    )

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
      JSON.parse(readFileSync(join(dirs.next, 'settings.json'), 'utf8'))
        .activeProviderProfileId,
    ).toBe('p1')
  })

  test('non-destructive merge into existing settings.json', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    mkdirSync(dirs.next, { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({
        activeProviderProfileId: 'legacy',
        customApiKeyResponses: { approved: ['sk-x'], rejected: [] },
      }),
    )
    writeFileSync(
      join(dirs.next, 'settings.json'),
      JSON.stringify({ activeProviderProfileId: 'mine', editorMode: 'normal' }),
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
    expect(settings.activeProviderProfileId).toBe('mine')
    expect(settings.editorMode).toBe('normal')
    // Missing key gets carried over.
    expect(settings.customApiKeyResponses).toEqual({
      approved: ['sk-x'],
      rejected: [],
    })
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

  test('forwards only the provider sign-in keys out of settings.json', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    const legacySettings = {
      customApiKeyResponses: { approved: ['sk-x'], rejected: [] },
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
      // Preferences and content: /import's job, must NOT cross over here.
      theme: 'dark',
      model: 'claude-sonnet-4-6',
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      verbose: true,
      editorMode: 'vim',
      mcpServers: { x: { type: 'stdio' as const } },
      // Legacy routing system: never forwarded.
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
    // Exactly the three sign-in keys cross over.
    expect(report.settingsKeys).toBe(3)

    const settings = JSON.parse(
      readFileSync(join(dirs.next, 'settings.json'), 'utf8'),
    )
    expect(settings.customApiKeyResponses).toEqual({
      approved: ['sk-x'],
      rejected: [],
    })
    expect(settings.providerProfiles).toEqual(legacySettings.providerProfiles)
    expect(settings.activeProviderProfileId).toBe('p1')

    for (const notMine of [
      'theme',
      'model',
      'permissions',
      'verbose',
      'editorMode',
      'mcpServers',
      'agentRouting',
      'agentModels',
    ]) {
      expect(settings[notMine]).toBeUndefined()
    }
  })

  test('returns unmodified report when ~/.claude/ is absent', async () => {
    const report = await migrateLegacyClaudeDir({
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(report.tokens).toBe(0)
    expect(report.settingsKeys).toBe(0)
    expect(report.globalConfigKeys).toBe(0)
    expect(report.anthropicProfileCreated).toBe(false)
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

  test('still shows when ~/.claudin/ already exists but legacy is unmigrated', () => {
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
    testConfigState = { claudeToClaudinMigratedAt: new Date().toISOString() }
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
      anthropicProfileCreated: true,
      errors: [],
      warnings: [],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudin',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('2 tokens')
    expect(summary).toContain('3 settings keys')
    expect(summary).toContain('7 global config keys')
    expect(summary).toContain('anthropic profile created')
    expect(summary).toContain('/home/x/.claude kept untouched')
    // The summary is the only place a user is told where the rest went.
    expect(summary).toContain(
      'Run /import to bring skills, MCP servers, agents and commands.',
    )
  })

  test('does not claim to have copied content', () => {
    const summary = formatMigrationReport({
      tokens: 1,
      settingsKeys: 3,
      globalConfigKeys: 0,
      anthropicProfileCreated: true,
      errors: [],
      warnings: [],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudin',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    for (const gone of ['CLAUDE.md', 'plugin', 'skill', 'agent', 'keybinding']) {
      expect(summary.split('Run /import')[0]).not.toContain(gone)
    }
  })

  test('summarises an idempotent re-run', () => {
    const summary = formatMigrationReport({
      tokens: 0,
      settingsKeys: 0,
      globalConfigKeys: 0,
      anthropicProfileCreated: false,
      errors: [],
      warnings: [],
      alreadyMigrated: true,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudin',
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
      anthropicProfileCreated: false,
      errors: [],
      warnings: ['/home/x/.claudin/.credentials.json already exists with different content — kept new file untouched'],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudin',
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
      anthropicProfileCreated: false,
      errors: [],
      warnings: [],
      alreadyMigrated: false,
      legacyDir: '/home/x/.claude',
      newDir: '/home/x/.claudin',
      migratedAt: '2026-04-28T00:00:00Z',
    })
    expect(summary).toContain('anthropic profile already present')
  })
})
