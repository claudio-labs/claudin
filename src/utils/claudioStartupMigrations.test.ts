import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalConfig } from './config.js'
import type { ProfileFile } from './providerProfile.js'
import type { ProviderProfile } from './config.js'
import type { ProviderProfileInput } from './providerProfiles.js'

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
const realProviderProfile = await import('./providerProfile.js')
const realProviderProfiles = await import('./providerProfiles.js')

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

mock.module('./providerProfiles.js', () => ({
  getActiveProviderProfile: () => store.active,
  getProviderProfiles: () => store.profiles,
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

mock.module('./providerProfile.js', () => ({
  ...realProviderProfile,
  loadProfileFile: () => {
    if (legacyFileState.malformed) return null
    return legacyFileState.file
  },
  deleteProfileFile: () => {
    legacyFileState.deleted = true
    legacyFileState.file = null
    return '/tmp/.claudio-profile.json'
  },
}))

afterAll(() => {
  mock.module('./providerProfile.js', () => realProviderProfile)
  mock.module('./providerProfiles.js', () => realProviderProfiles)
  const restore = () => ({ ...realFs, default: realFs })
  mock.module('node:fs', restore)
  mock.module('fs', restore)
})

const { runClaudioStartupMigrations } = await import(
  './claudioStartupMigrations.js'
)

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
// touching the developer's real ~/.claudio.json. The home dir is plumbed
// into runClaudioStartupMigrations via the homeDir option.
let tmpHome = ''

function clearMigrationFlags(): void {
  const cfg = getGlobalConfig() as unknown as Record<string, unknown>
  delete cfg.claudeToClaudioMigratedAt
}

beforeEach(() => {
  store.profiles = []
  store.active = undefined
  legacyFileState.file = null
  legacyFileState.deleted = false
  legacyFileState.malformed = false
  tmpHome = mkdtempSync(join(tmpdir(), 'claudio-startupmig-'))
  clearMigrationFlags()
})

afterEach(() => {
  store.profiles = []
  store.active = undefined
  rmSync(tmpHome, { recursive: true, force: true })
  clearMigrationFlags()
})

function callRun(
  args: { processEnv: NodeJS.ProcessEnv; log?: (m: string) => void },
) {
  return runClaudioStartupMigrations({
    processEnv: args.processEnv,
    homeDir: tmpHome,
    log: args.log,
  })
}

describe('runClaudioStartupMigrations — legacy .claudio-profile.json', () => {
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

describe('runClaudioStartupMigrations — rescue CLAUDE_CODE_USE_* envs', () => {
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

describe('runClaudioStartupMigrations — full-run idempotency', () => {
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
