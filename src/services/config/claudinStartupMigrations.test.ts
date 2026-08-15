import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileFile } from 'src/services/api/providerProfile.js'
import type { ProviderProfile } from 'src/services/config/config.js'
import type { ProviderProfileInput } from 'src/services/api/providerProfiles.js'

const _require = createRequire(import.meta.url)
const realFs = _require('fs') as typeof import('fs')
const { mkdtempSync, rmSync } = realFs

// Capture real modules first so mock factories can spread them. Following
// CLAUDE.md mock.module rules — never narrow the namespace shape, always
// restore at teardown.
//
// Note: by the time this file's top level runs, earlier test files (notably
// context.test.ts) may already have replaced `getActiveProviderProfile` in
// the global mock cache. Bun's `mock.module` shares one process-wide cache
// for the resolved specifier, so `await import(...)` here returns the leaked
// version. We work around this by driving our own in-memory profile store
// for the migration's read/write surface — the same pattern used by
// activeProvider.test.ts.
const realProviderProfile = await import('src/services/api/providerProfile.js')
const realProviderProfiles = await import('src/services/api/providerProfiles.js')
const realConfig = await import('src/services/config/config.js')

// In-memory config singleton backing './config.js' for this file. Several
// other test files mock './config.js' too, and bun's process-wide module
// cache means whichever factory ran LAST is the one already-imported code
// reads — so the heal under test and these assertions could otherwise end up
// on different singletons depending on file order. Mocking config.js here
// (and importing the module under test with a cache-busting nonce below)
// pins both sides to this state object.
type TestProjectConfig = {
  activeProviderProfileId?: string | null
  activeModelForProject?: string | null
  hasTrustDialogAccepted?: boolean
}
type MockGlobalConfigState = {
  projects?: Record<string, TestProjectConfig>
  activeProviderProfileId?: string
  providerProfiles?: Array<{ id: string; name: string; [key: string]: unknown }>
  openaiAdditionalModelOptionsCacheByProfile?: Record<string, unknown[]>
  openaiAdditionalModelOptionsCache?: unknown[]
  [key: string]: unknown
}
let mockConfigState: MockGlobalConfigState = {}

mock.module('./config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => mockConfigState,
  saveGlobalConfig: (
    updater: (current: MockGlobalConfigState) => MockGlobalConfigState,
  ) => {
    mockConfigState = updater(mockConfigState)
  },
}))

const exdevTrigger: { legacy: string | null; dst: string | null } = {
  legacy: null,
  dst: null,
}

const fsFactory = () => ({
  ...realFs,
  default: realFs,
  renameSync: (src: string, dst: string) => {
    if (
      exdevTrigger.legacy &&
      exdevTrigger.dst &&
      src === exdevTrigger.legacy &&
      dst === exdevTrigger.dst
    ) {
      const err: NodeJS.ErrnoException = new Error('EXDEV cross-device link')
      err.code = 'EXDEV'
      throw err
    }
    return realFs.renameSync(src, dst)
  },
})
mock.module('node:fs', fsFactory)
mock.module('fs', fsFactory)

type ProfileStore = {
  profiles: ProviderProfile[]
  active?: ProviderProfile
}

const store: ProfileStore = { profiles: [] }

let nextId = 0
function createProfile(
  input: ProviderProfileInput,
): ProviderProfile {
  nextId += 1
  const provider = input.provider ?? 'openai'
  const profile: ProviderProfile = {
    id: `test_profile_${nextId}`,
    name: input.name,
    provider,
    baseUrl: input.baseUrl,
    model: input.model,
  }
  if (input.apiKey) profile.apiKey = input.apiKey
  if (input.extras) profile.extras = input.extras
  return profile
}

mock.module('src/services/api/providerProfiles.js', () => ({
  getActiveProviderProfile: () => store.active,
  // The heal path calls this both bare and with an explicit config snapshot;
  // the in-memory store is the single source of truth in both cases.
  getProviderProfiles: (_config?: unknown) => store.profiles,
  // Pure function — pass the real implementation through so the heal tests
  // exercise the same strip logic production uses.
  stripProjectProviderPointers: realProviderProfiles.stripProjectProviderPointers,
  addProviderProfile: (
    input: ProviderProfileInput,
    options?: { makeActive?: boolean },
  ): ProviderProfile | null => {
    const profile = createProfile(input)
    store.profiles = [...store.profiles, profile]
    if (options?.makeActive ?? true) {
      store.active = profile
    } else if (!store.active) {
      store.active = profile
    }
    return profile
  },
}))

// Stub the legacy single-profile file loader/deleter. The real impl reads
// from process.cwd() and rmSyncs files — neither is acceptable in unit tests.
type LegacyFileState = {
  file: ProfileFile | null
  deleted: boolean
  malformed: boolean
}

const legacyFileState: LegacyFileState = {
  file: null,
  deleted: false,
  malformed: false,
}

mock.module('src/services/api/providerProfile.js', () => ({
  ...realProviderProfile,
  loadProfileFile: () => {
    if (legacyFileState.malformed) return null
    return legacyFileState.file
  },
  deleteProfileFile: () => {
    legacyFileState.deleted = true
    legacyFileState.file = null
    return '/tmp/.claudin-profile.json'
  },
}))

afterAll(() => {
  mock.module('src/services/api/providerProfile.js', () => realProviderProfile)
  mock.module('src/services/api/providerProfiles.js', () => realProviderProfiles)
  mock.module('./config.js', () => realConfig)
  const restore = () => ({ ...realFs, default: realFs })
  mock.module('node:fs', restore)
  mock.module('fs', restore)
})

// Cache-busting nonce import: if some earlier test file already imported
// claudinStartupMigrations.js, that cached instance is bound to whatever
// './config.js' looked like at THAT moment. The nonce forces a fresh
// instance bound to the mocks installed above.
const { runClaudinStartupMigrations } = (await import(
  `./claudinStartupMigrations.js?ts=${Date.now()}-${Math.random()}`
)) as typeof import('src/services/config/claudinStartupMigrations.js')

function legacy(profile: ProfileFile['profile'], env: ProfileFile['env']): ProfileFile {
  return {
    profile,
    env,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

function silentLog(_message: string): void {
  // discard
}

function presetActive(profile: ProviderProfile): void {
  store.profiles = [profile]
  store.active = profile
}

// Each test gets an isolated tmp home so migrations can run without
// touching the developer's real ~/.claudin.json. The home dir is plumbed
// into runClaudinStartupMigrations via the homeDir option.
let tmpHome = ''

beforeEach(() => {
  store.profiles = []
  store.active = undefined
  legacyFileState.file = null
  legacyFileState.deleted = false
  legacyFileState.malformed = false
  tmpHome = mkdtempSync(join(tmpdir(), 'claudin-startupmig-'))
  mockConfigState = {}
})

afterEach(() => {
  store.profiles = []
  store.active = undefined
  rmSync(tmpHome, { recursive: true, force: true })
  mockConfigState = {}
})

function callRun(
  args: { processEnv: NodeJS.ProcessEnv; log?: (m: string) => void },
) {
  return runClaudinStartupMigrations({
    processEnv: args.processEnv,
    homeDir: tmpHome,
    log: args.log,
  })
}

describe('runClaudinStartupMigrations — legacy .claudin-profile.json', () => {
  test('migrates openai-shaped legacy file into providerProfiles[]', () => {
    legacyFileState.file = legacy('openai', {
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test',
    })

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(true)
    expect(legacyFileState.deleted).toBe(true)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('openai')
    expect(store.profiles[0].name).toBe('OpenAI (legacy)')
    expect(store.profiles[0].baseUrl).toBe('https://api.example.com/v1')
    expect(store.profiles[0].model).toBe('gpt-4o')
    expect(store.profiles[0].apiKey).toBe('sk-test')
  })

  test('migrates gemini legacy file with default base URL when not set', () => {
    legacyFileState.file = legacy('gemini', {
      GEMINI_API_KEY: 'aistudio-xxx',
    })

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(true)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('gemini')
    expect(store.profiles[0].name).toBe('Google Gemini (legacy)')
    expect(store.profiles[0].apiKey).toBe('aistudio-xxx')
  })

  test('migrates mistral legacy file', () => {
    legacyFileState.file = legacy('mistral', {
      MISTRAL_API_KEY: 'mistral-xxx',
    })

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(true)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('mistral')
    expect(store.profiles[0].name).toBe('Mistral (legacy)')
    expect(store.profiles[0].apiKey).toBe('mistral-xxx')
  })

  test('migrates atomic-chat legacy file (openai shape with custom name)', () => {
    legacyFileState.file = legacy('atomic-chat', {
      OPENAI_BASE_URL: 'http://127.0.0.1:1337/v1',
      OPENAI_MODEL: 'local-model',
    })

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(true)
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('openai')
    expect(store.profiles[0].name).toBe('Atomic Chat (legacy)')
    expect(store.profiles[0].baseUrl).toBe('http://127.0.0.1:1337/v1')
  })

  test('deletes legacy file even when input cannot be derived', () => {
    // openai-shaped legacy without baseUrl/model → profileFromLegacyFile
    // returns null, but the file still gets deleted to prevent re-attempts.
    legacyFileState.file = legacy('openai', { OPENAI_API_KEY: 'sk-test' })

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(false)
    expect(legacyFileState.deleted).toBe(true)
    expect(store.profiles).toHaveLength(0)
  })

  test('returns cleanly when no legacy file exists', () => {
    legacyFileState.file = null

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(false)
    expect(legacyFileState.deleted).toBe(false)
    expect(store.profiles).toHaveLength(0)
  })

  test('treats malformed (unparseable) legacy file as absent — no crash', () => {
    legacyFileState.malformed = true

    expect(() =>
      callRun({ processEnv: {}, log: silentLog }),
    ).not.toThrow()

    expect(store.profiles).toHaveLength(0)
  })

  test('legacy file with unsupported provider value still gets deleted but does not migrate', () => {
    legacyFileState.file = legacy(
      'definitely-not-a-real-provider' as ProfileFile['profile'],
      { OPENAI_BASE_URL: 'https://api.example.com/v1', OPENAI_MODEL: 'gpt-4o' },
    )

    const result = callRun({
      processEnv: {},
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(false)
    expect(legacyFileState.deleted).toBe(true)
    expect(store.profiles).toHaveLength(0)
  })

  test('idempotent within one process — second call is a noop after file deletion', () => {
    legacyFileState.file = legacy('openai', {
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    })

    callRun({ processEnv: {}, log: silentLog })
    expect(store.profiles).toHaveLength(1)

    // Second run: legacy file is gone (deleted), envs absent → no-op.
    const second = callRun({
      processEnv: {},
      log: silentLog,
    })
    expect(second.legacyProfileMigrated).toBe(false)
    expect(store.profiles).toHaveLength(1)
  })
})

describe('runClaudinStartupMigrations — rescue CLAUDE_CODE_USE_* envs', () => {
  test('CLAUDE_CODE_USE_OPENAI → creates openai profile from envs', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEY: 'sk-test',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('openai')
    expect(store.profiles[0].name).toBe('OpenAI (env)')
    expect(store.profiles[0].baseUrl).toBe('https://api.openai.com/v1')
    expect(store.profiles[0].model).toBe('gpt-4o')
    expect(store.profiles[0].apiKey).toBe('sk-test')
  })

  test('CLAUDE_CODE_USE_OPENAI without base/model → no profile (rescue requires data)', () => {
    callRun({
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(0)
  })

  test('CLAUDE_CODE_USE_GEMINI → creates gemini profile with defaults', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_GEMINI: '1',
        GEMINI_API_KEY: 'aistudio-xxx',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('gemini')
    expect(store.profiles[0].name).toBe('Google Gemini (env)')
    expect(store.profiles[0].apiKey).toBe('aistudio-xxx')
  })

  test('CLAUDE_CODE_USE_MISTRAL → creates mistral profile', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_MISTRAL: '1',
        MISTRAL_API_KEY: 'mistral-xxx',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('mistral')
    expect(store.profiles[0].name).toBe('Mistral (env)')
    expect(store.profiles[0].apiKey).toBe('mistral-xxx')
  })

  test('CLAUDE_CODE_USE_GITHUB → creates openai profile with extras.githubToken from GITHUB_TOKEN', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_GITHUB: '1',
        GITHUB_TOKEN: 'ghp_test123',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('openai')
    expect(store.profiles[0].name).toBe('GitHub Copilot (legacy env)')
    expect(store.profiles[0].baseUrl).toBe('https://models.github.ai/inference')
    expect(store.profiles[0].model).toBe('github:copilot')
    expect(store.profiles[0].extras?.githubToken).toBe('ghp_test123')
  })

  test('CLAUDE_CODE_USE_GITHUB → falls back to GH_TOKEN when GITHUB_TOKEN absent', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_GITHUB: '1',
        GH_TOKEN: 'gho_alt456',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].extras?.githubToken).toBe('gho_alt456')
  })

  test('CLAUDE_CODE_USE_BEDROCK → creates bedrock profile with awsRegion from AWS_REGION', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('bedrock')
    expect(store.profiles[0].name).toBe('AWS Bedrock (legacy env)')
    expect(store.profiles[0].baseUrl).toBe('https://bedrock-runtime.us-west-2.amazonaws.com')
    expect(store.profiles[0].model).toBe('claude-sonnet-4-6')
    expect(store.profiles[0].extras?.awsRegion).toBe('us-west-2')
  })

  test('CLAUDE_CODE_USE_BEDROCK falls back to AWS_DEFAULT_REGION when AWS_REGION missing', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_DEFAULT_REGION: 'eu-west-1',
      },
      log: silentLog,
    })

    expect(store.profiles[0].extras?.awsRegion).toBe('eu-west-1')
  })

  test('CLAUDE_CODE_USE_BEDROCK with no region env → defaults to us-east-1', () => {
    callRun({
      processEnv: { CLAUDE_CODE_USE_BEDROCK: '1' },
      log: silentLog,
    })

    expect(store.profiles[0].extras?.awsRegion).toBe('us-east-1')
  })

  test('CLAUDE_CODE_USE_VERTEX → creates vertex profile with gcpProject + default gcpRegion', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_VERTEX: '1',
        GCLOUD_PROJECT: 'my-proj',
      },
      log: silentLog,
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('vertex')
    expect(store.profiles[0].name).toBe('Google Vertex AI (legacy env)')
    expect(store.profiles[0].extras?.gcpProject).toBe('my-proj')
    expect(store.profiles[0].extras?.gcpRegion).toBe('us-east5')
    expect(store.profiles[0].baseUrl).toBe('https://us-east5-aiplatform.googleapis.com')
  })

  test('CLAUDE_CODE_USE_VERTEX picks up CLOUD_ML_REGION + ANTHROPIC_VERTEX_PROJECT_ID', () => {
    callRun({
      processEnv: {
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'anthropic-proj',
        CLOUD_ML_REGION: 'us-central1',
      },
      log: silentLog,
    })

    const profile = store.profiles[0]
    expect(profile.extras?.gcpProject).toBe('anthropic-proj')
    expect(profile.extras?.gcpRegion).toBe('us-central1')
    expect(profile.baseUrl).toBe('https://us-central1-aiplatform.googleapis.com')
  })

  test('CLAUDE_CODE_USE_VERTEX without any project env → still creates profile (no gcpProject extra)', () => {
    callRun({
      processEnv: { CLAUDE_CODE_USE_VERTEX: '1' },
      log: silentLog,
    })

    const profile = store.profiles[0]
    expect(profile.provider).toBe('vertex')
    expect(profile.extras?.gcpProject).toBeUndefined()
    expect(profile.extras?.gcpRegion).toBe('us-east5')
  })

  test('CLAUDE_CODE_USE_FOUNDRY → creates foundry profile with placeholder + warning', () => {
    const notices: string[] = []
    callRun({
      processEnv: { CLAUDE_CODE_USE_FOUNDRY: '1' },
      log: msg => notices.push(msg),
    })

    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].provider).toBe('foundry')
    expect(store.profiles[0].name).toBe('Azure AI Foundry (legacy env)')
    expect(store.profiles[0].baseUrl).toBe('https://YOUR-RESOURCE-NAME.services.ai.azure.com')
    expect(store.profiles[0].model).toBe('claude-sonnet-4-6')
    expect(store.profiles[0].extras?.azureResource).toBeUndefined()
    expect(notices.some(m => m.includes('azureResource missing'))).toBe(true)
  })

  test('rescue is skipped when an active profile already exists — envs ignored', () => {
    presetActive({
      id: 'existing_profile',
      name: 'Existing',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    })

    const notices: string[] = []
    const result = callRun({
      processEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
      },
      log: msg => notices.push(msg),
    })

    expect(result.envsIgnored).toContain('CLAUDE_CODE_USE_BEDROCK')
    expect(store.profiles).toHaveLength(1)
    expect(store.active?.id).toBe('existing_profile')
    expect(
      notices.some(m => m.includes('ignoring') && m.includes('CLAUDE_CODE_USE_BEDROCK')),
    ).toBe(true)
  })
})

describe('runClaudinStartupMigrations — full-run idempotency', () => {
  test('running twice with the same envs does not duplicate profiles', () => {
    const env = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test',
    }

    callRun({ processEnv: env, log: silentLog })
    expect(store.profiles).toHaveLength(1)

    // Second run: envs still present, but a profile is now active → rescue
    // path should detect the existing profile and only emit the "ignoring"
    // warning.
    const second = callRun({
      processEnv: env,
      log: silentLog,
    })

    expect(second.envsIgnored).toContain('CLAUDE_CODE_USE_OPENAI')
    expect(store.profiles).toHaveLength(1)
  })

  test('rescue + legacy file in the same run: legacy wins, envs ignored', () => {
    legacyFileState.file = legacy('openai', {
      OPENAI_BASE_URL: 'https://api.legacy.example/v1',
      OPENAI_MODEL: 'gpt-3.5-turbo',
    })

    const result = callRun({
      processEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
      },
      log: silentLog,
    })

    expect(result.legacyProfileMigrated).toBe(true)
    expect(result.envsIgnored).toContain('CLAUDE_CODE_USE_BEDROCK')
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].name).toBe('OpenAI (legacy)')
    expect(legacyFileState.deleted).toBe(true)
  })
})

describe('runClaudinStartupMigrations — dangling provider pointer heal', () => {
  // The heal reads/writes through the './config.js' mock installed at the
  // top of this file, i.e. `mockConfigState` (reset in the global
  // beforeEach/afterEach). Dangling-ness is decided against the RAW
  // `providerProfiles` field; the mocked getProviderProfiles
  // (store.profiles) stands in for the sanitized view used for re-election.
  const cfg = () => mockConfigState

  // A profile that is both on disk (raw) and visible to this build
  // (sanitized view = mocked store.profiles).
  function presetValidProfile(id: string, name: string): void {
    presetActive({
      id,
      name,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    })
    cfg().providerProfiles = [
      ...(cfg().providerProfiles ?? []),
      { id, name },
    ]
  }

  test('strips dangling override + paired model, preserves valid ones and sibling keys', () => {
    presetValidProfile('existing_profile', 'Existing')
    cfg().projects = {
      '/proj/dangling': {
        activeProviderProfileId: 'provider_deleted_long_ago',
        activeModelForProject: 'stale-pinned-model',
        hasTrustDialogAccepted: true,
      },
      '/proj/valid': {
        activeProviderProfileId: 'existing_profile',
        activeModelForProject: 'kept-model',
      },
    }

    const result = callRun({ processEnv: {}, log: silentLog })

    const projects = cfg().projects ?? {}
    expect(projects['/proj/dangling']?.activeProviderProfileId).toBeUndefined()
    expect(projects['/proj/dangling']?.activeModelForProject).toBeUndefined()
    // Sibling project keys survive the strip
    expect(projects['/proj/dangling']?.hasTrustDialogAccepted).toBe(true)
    // Valid override untouched
    expect(projects['/proj/valid']?.activeProviderProfileId).toBe(
      'existing_profile',
    )
    expect(projects['/proj/valid']?.activeModelForProject).toBe('kept-model')
    // Notice names the path, the dropped id, and the pinned model — the only
    // remaining record of the user's choice.
    expect(
      result.notices.some(
        n =>
          n.includes('/proj/dangling') &&
          n.includes('provider_deleted_long_ago') &&
          n.includes('stale-pinned-model'),
      ),
    ).toBe(true)
    expect(result.notices.some(n => n.includes('/proj/valid'))).toBe(false)
  })

  test('raw-but-sanitize-invisible profile is NOT treated as dangling', () => {
    // Profile exists on disk but this build's sanitize rejects it (raw entry
    // present, absent from the mocked sanitized view) — e.g. created by a
    // newer/branch build. Its pointers must survive untouched.
    cfg().providerProfiles = [{ id: 'branch_build_profile', name: 'Future' }]
    cfg().projects = {
      '/proj/future': {
        activeProviderProfileId: 'branch_build_profile',
        activeModelForProject: 'future-model',
      },
    }
    cfg().activeProviderProfileId = 'branch_build_profile'

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().projects?.['/proj/future']?.activeProviderProfileId).toBe(
      'branch_build_profile',
    )
    expect(cfg().projects?.['/proj/future']?.activeModelForProject).toBe(
      'future-model',
    )
    expect(cfg().activeProviderProfileId).toBe('branch_build_profile')
    expect(
      result.notices.some(
        n => n.includes('stale project provider override') || n.includes('global provider default'),
      ),
    ).toBe(false)
  })

  test('null or unset override ids are not treated as dangling', () => {
    cfg().projects = {
      '/proj/null-id': {
        activeProviderProfileId: null,
        activeModelForProject: null,
      },
      '/proj/no-id': {
        activeModelForProject: 'orphan-model',
      },
    }

    const result = callRun({ processEnv: {}, log: silentLog })

    const projects = cfg().projects ?? {}
    expect(projects['/proj/null-id']?.activeProviderProfileId).toBeNull()
    expect(projects['/proj/no-id']?.activeModelForProject).toBe('orphan-model')
    expect(
      result.notices.some(n => n.includes('stale project provider override')),
    ).toBe(false)
  })

  test('second run is a no-op after healing', () => {
    cfg().projects = {
      '/proj/dangling': {
        activeProviderProfileId: 'provider_deleted_long_ago',
        activeModelForProject: 'stale-pinned-model',
      },
    }

    const first = callRun({ processEnv: {}, log: silentLog })
    expect(
      first.notices.some(n => n.includes('stale project provider override')),
    ).toBe(true)

    const second = callRun({ processEnv: {}, log: silentLog })
    expect(
      second.notices.some(n => n.includes('stale project provider override')),
    ).toBe(false)
  })

  test('dangling global default is re-pointed to the first sanitized profile, with cache swap', () => {
    presetValidProfile('surviving_profile', 'Surviving')
    cfg().activeProviderProfileId = 'provider_deleted_long_ago'
    cfg().openaiAdditionalModelOptionsCacheByProfile = {
      provider_deleted_long_ago: ['dead-model-1', 'dead-model-2'],
      surviving_profile: ['live-model'],
    }
    cfg().openaiAdditionalModelOptionsCache = ['dead-model-1', 'dead-model-2']

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().activeProviderProfileId).toBe('surviving_profile')
    // Mirrors deleteProviderProfile: dangling id's cache pruned, flat cache
    // swapped to the new active profile's entries.
    expect(
      cfg().openaiAdditionalModelOptionsCacheByProfile?.provider_deleted_long_ago,
    ).toBeUndefined()
    expect(cfg().openaiAdditionalModelOptionsCache).toEqual(['live-model'])
    expect(
      result.notices.some(
        n =>
          n.includes('global provider default') &&
          n.includes('provider_deleted_long_ago') &&
          n.includes('Surviving'),
      ),
    ).toBe(true)
  })

  test('dangling global default is cleared when no profiles remain at all', () => {
    cfg().activeProviderProfileId = 'provider_deleted_long_ago'

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().activeProviderProfileId).toBeUndefined()
    expect(
      result.notices.some(n =>
        n.includes('cleared global provider default'),
      ),
    ).toBe(true)
  })

  test('dangling global default is left alone when only sanitize-invisible profiles exist', () => {
    // Raw profiles exist but none survive this build's sanitize pass
    // (store.profiles empty): electing nothing would destroy state another
    // build still uses.
    cfg().providerProfiles = [{ id: 'invisible_profile', name: 'Future' }]
    cfg().activeProviderProfileId = 'provider_deleted_long_ago'

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().activeProviderProfileId).toBe('provider_deleted_long_ago')
    expect(
      result.notices.some(n => n.includes('global provider default')),
    ).toBe(false)
  })

  test('valid global default is left untouched', () => {
    presetValidProfile('existing_profile', 'Existing')
    cfg().activeProviderProfileId = 'existing_profile'

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().activeProviderProfileId).toBe('existing_profile')
    expect(
      result.notices.some(n => n.includes('global provider default')),
    ).toBe(false)
  })
})

describe('runClaudinStartupMigrations — Kimi Code model list heal', () => {
  const cfg = () => mockConfigState

  function presetKimi(
    model: string,
    opts?: { apiKey?: string; baseUrl?: string },
  ): void {
    const profile = {
      id: 'kimi_profile',
      name: 'Moonshot AI',
      provider: 'openai' as const,
      baseUrl: opts?.baseUrl ?? 'https://api.kimi.com/coding/v1',
      model,
      ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
    }
    // store.profiles = sanitized view (getProviderProfiles); cfg().providerProfiles
    // = raw array the heal rewrites.
    store.profiles = [profile]
    store.active = profile
    cfg().providerProfiles = [{ ...profile }]
    cfg().activeProviderProfileId = 'kimi_profile'
  }

  test('upgrades a k3-only Kimi profile and refreshes the model-options cache', () => {
    presetKimi('k3')
    cfg().openaiAdditionalModelOptionsCache = ['k3'] // stale flat cache

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().providerProfiles?.[0].model).toBe(
      'k3, kimi-for-coding, kimi-for-coding-highspeed',
    )
    // Per-profile cache is repopulated with every coding model (the picker reads
    // this, not profile.model, for the active openai profile).
    const perProfile = cfg().openaiAdditionalModelOptionsCacheByProfile
      ?.kimi_profile as Array<{ value: string }> | undefined
    expect(perProfile?.map(o => o.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    // Flat cache is refreshed too because the healed profile is the active one.
    const flat = cfg().openaiAdditionalModelOptionsCache as Array<{
      value: string
    }>
    expect(flat.map(o => o.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(true)
  })

  test('populates a missing cache even when profile.model is already canonical', () => {
    // The real-world stale state: an earlier heal fixed profile.model to the full
    // list but the derived model-options cache was never (re)built, so /model
    // kept showing the old single model.
    presetKimi('k3, kimi-for-coding, kimi-for-coding-highspeed')
    // No openaiAdditionalModelOptionsCacheByProfile entry for the Kimi profile.

    const result = callRun({ processEnv: {}, log: silentLog })

    const perProfile = cfg().openaiAdditionalModelOptionsCacheByProfile
      ?.kimi_profile as Array<{ value: string }> | undefined
    expect(perProfile?.map(o => o.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(true)
  })

  test('is a no-op once model AND cache both match the canonical set', () => {
    presetKimi('k3, kimi-for-coding, kimi-for-coding-highspeed')
    cfg().openaiAdditionalModelOptionsCacheByProfile = {
      kimi_profile: [
        { value: 'k3' },
        { value: 'kimi-for-coding' },
        { value: 'kimi-for-coding-highspeed' },
      ],
    }

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().providerProfiles?.[0].model).toBe(
      'k3, kimi-for-coding, kimi-for-coding-highspeed',
    )
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(false)
  })

  test('leaves a static-key Kimi profile untouched', () => {
    presetKimi('k3', { apiKey: 'sk-static' })

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().providerProfiles?.[0].model).toBe('k3')
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(false)
  })

  test('leaves a profile carrying a non-canonical model untouched', () => {
    presetKimi('k3, my-custom-model')

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().providerProfiles?.[0].model).toBe('k3, my-custom-model')
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(false)
  })

  test('ignores a Kimi host on a non-coding path (bare /v1)', () => {
    presetKimi('k3', { baseUrl: 'https://api.kimi.com/v1' })

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(cfg().providerProfiles?.[0].model).toBe('k3')
    expect(
      result.notices.some(n => n.includes('Kimi Code model list')),
    ).toBe(false)
  })
})

describe('runClaudinStartupMigrations — orphaned model-options cache GC', () => {
  const cfg = () => mockConfigState

  function presetOpenAIProfile(id: string): void {
    const profile = {
      id,
      name: 'Live',
      provider: 'openai' as const,
      baseUrl: 'https://api.example.com/v1',
      model: 'x',
    }
    store.profiles = [profile]
    store.active = profile
    cfg().providerProfiles = [{ ...profile }]
    cfg().activeProviderProfileId = id
  }

  test('prunes cache entries whose profile no longer exists', () => {
    presetOpenAIProfile('live')
    cfg().openaiAdditionalModelOptionsCacheByProfile = {
      live: [{ value: 'x' }],
      ghost_deleted: [{ value: 'dead-1' }],
      other_ghost: [{ value: 'dead-2' }],
    }

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(
      Object.keys(cfg().openaiAdditionalModelOptionsCacheByProfile ?? {}),
    ).toEqual(['live'])
    expect(
      result.notices.some(n => n.includes('orphaned model-options cache')),
    ).toBe(true)
  })

  test('is a no-op when every cache entry maps to a live profile', () => {
    presetOpenAIProfile('live')
    cfg().openaiAdditionalModelOptionsCacheByProfile = {
      live: [{ value: 'x' }],
    }

    const result = callRun({ processEnv: {}, log: silentLog })

    expect(
      Object.keys(cfg().openaiAdditionalModelOptionsCacheByProfile ?? {}),
    ).toEqual(['live'])
    expect(
      result.notices.some(n => n.includes('orphaned model-options cache')),
    ).toBe(false)
  })
})
