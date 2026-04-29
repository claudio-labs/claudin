/**
 * Startup-time legacy migrations applied before the REPL mounts.
 *
 * - `migrateLegacyHomePaths`: relocates `~/.openclaude.json` and
 *   `~/.openclaude-model-cache/` into the new in-dir layout
 *   (`<configDir>/config.json` and `<configDir>/model-cache/`).
 * - `migrateLegacyOpenclaudeProfile`: copies `~/.openclaude-profile.json`
 *   (single-profile legacy file) into `providerProfiles[]` and deletes it.
 * - `rescueProviderEnvVars`: when no profile exists but the user still has
 *   `CLAUDE_CODE_USE_*` exports in their shell, derive a profile so they get
 *   a `/provider` entry instead of silently breaking. When a profile already
 *   exists, just log a warning that the envs are now ignored.
 *
 * All three run idempotently and are intentionally side-effect-bounded.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import {
  _setGlobalConfigCacheForTesting,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
  deleteProfileFile,
  loadProfileFile,
  type ProfileFile,
  type ProviderProfile as LegacyProviderProfile,
} from './providerProfile.js'
import {
  addProviderProfile,
  getActiveProviderProfile,
  type ProviderProfileInput,
} from './providerProfiles.js'

const GITHUB_COPILOT_DEFAULT_BASE_URL = 'https://models.github.ai/inference'
const GITHUB_COPILOT_DEFAULT_MODEL = 'github:copilot'
const DEFAULT_AWS_REGION = 'us-east-1'
const DEFAULT_VERTEX_REGION = 'us-east5'
const DEFAULT_CLAUDE_CLOUD_MODEL = 'claude-sonnet-4-6'
const FOUNDRY_PLACEHOLDER_BASE_URL =
  'https://YOUR-RESOURCE-NAME.services.ai.azure.com'

export type StartupMigrationsResult = {
  legacyProfileMigrated: boolean
  rescueEnvAdoptedAs?: string
  envsIgnored: string[]
  notices: string[]
  homePathsMoved: string[]
}

const LEGACY_MODEL_CACHE_DIR_NAME = '.openclaude-model-cache'
const NEW_MODEL_CACHE_DIR_NAME = 'model-cache'

type HomePathsContext = {
  configDir: string
  legacyHome: string
}

function resolveHomePathsContext(
  env: NodeJS.ProcessEnv,
  homeDirOverride?: string,
): HomePathsContext {
  const home = homeDirOverride ?? homedir()
  const envOverride = env.CLAUDIO_CONFIG_DIR
  return {
    configDir: envOverride ?? join(home, '.openclaude'),
    legacyHome: envOverride ?? home,
  }
}

function moveInPlace(src: string, dst: string, configDir: string): boolean {
  if (!existsSync(src)) return false
  // dst-wins is intentional: if the new in-dir file already exists, the user
  // (or a prior partial migration) populated it — keeping it untouched is the
  // safe default. The shim in env.ts:getGlobalClaudeFile still falls back to
  // the legacy sibling path when the new file is empty/absent, so a no-op
  // here doesn't strand the user.
  if (existsSync(dst)) return false
  mkdirSync(configDir, { recursive: true })
  try {
    renameSync(src, dst)
    return true
  } catch {
    // EXDEV (cross-device) — fall back to copy + unlink. Only the global
    // config file is small enough for a simple copy; for the cache dir we
    // leave it alone (rare enough to ignore; user can clear it manually).
    try {
      copyFileSync(src, dst)
      unlinkSync(src)
      return true
    } catch {
      return false
    }
  }
}

export function migrateLegacyHomePaths(options?: {
  processEnv?: NodeJS.ProcessEnv
  homeDir?: string
  log?: (message: string) => void
}): string[] {
  const env = options?.processEnv ?? process.env
  const log = options?.log ?? defaultLog
  const ctx = resolveHomePathsContext(env, options?.homeDir)
  const moved: string[] = []

  const suffix = fileSuffixForOauthConfig()
  const oldConfig = join(ctx.legacyHome, `.openclaude${suffix}.json`)
  const newConfig = join(ctx.configDir, `config${suffix}.json`)
  if (oldConfig !== newConfig && moveInPlace(oldConfig, newConfig, ctx.configDir)) {
    moved.push(`${oldConfig} → ${newConfig}`)
    log(`moved legacy global config: ${oldConfig} → ${newConfig}`)
  }

  const oldCache = join(options?.homeDir ?? homedir(), LEGACY_MODEL_CACHE_DIR_NAME)
  const newCache = join(ctx.configDir, NEW_MODEL_CACHE_DIR_NAME)
  if (
    oldCache !== newCache &&
    existsSync(oldCache) &&
    !existsSync(newCache)
  ) {
    mkdirSync(ctx.configDir, { recursive: true })
    try {
      renameSync(oldCache, newCache)
      moved.push(`${oldCache} → ${newCache}`)
      log(`moved model cache: ${oldCache} → ${newCache}`)
    } catch (e: unknown) {
      // Cross-device dir rename — leave it; cache is regenerable. We don't
      // copy it (potentially large, no value lost). Surface a debug log so
      // users who care can clean it up manually with `rm -rf <oldCache>`.
      void import('./debug.js').then(({ logForDebugging }) => {
        logForDebugging(
          `model cache rename ${oldCache} → ${newCache} failed (${e instanceof Error ? e.message : String(e)}); leaving legacy dir in place — safe to remove with: rm -rf ${oldCache}`,
        )
      })
    }
  }

  return moved
}

const LEGACY_OPENCLAUDE_DIR_NAME = '.openclaude'
const CLAUDIO_DIR_NAME = '.claudio'

export function migrateOpenclaudeToClaudio(options?: {
  homeDir?: string
  log?: (message: string) => void
}): boolean {
  const log = options?.log ?? defaultLog
  const config = getGlobalConfig()
  if (
    typeof config.openclaudeToClaudioMigratedAt === 'string' &&
    config.openclaudeToClaudioMigratedAt.length > 0
  ) {
    return false
  }

  const home = options?.homeDir ?? homedir()
  const legacyDir = join(home, LEGACY_OPENCLAUDE_DIR_NAME)
  const newDir = join(home, CLAUDIO_DIR_NAME)

  if (!existsSync(legacyDir)) {
    markOpenclaudeToClaudioMigrated()
    return false
  }

  if (existsSync(newDir)) {
    log(
      `kept ${newDir} (canonical), legacy ${legacyDir} retained — remove manually if confirmed migrated`,
    )
    markOpenclaudeToClaudioMigrated()
    return false
  }

  try {
    renameSync(legacyDir, newDir)
    log(`moved legacy config dir: ${legacyDir} → ${newDir}`)
    // Invalidate the in-memory globalConfig cache so the next read picks up
    // the freshly relocated config.json instead of the empty defaults the
    // earlier `getGlobalConfig()` call cached when the new dir didn't exist.
    _setGlobalConfigCacheForTesting(null)
    markOpenclaudeToClaudioMigrated()
    return true
  } catch (e: unknown) {
    try {
      cpSync(legacyDir, newDir, { recursive: true })
      log(
        `copied legacy config dir: ${legacyDir} → ${newDir} (${e instanceof Error ? e.message : String(e)}); safe to remove with: rm -rf ${legacyDir}`,
      )
      _setGlobalConfigCacheForTesting(null)
      markOpenclaudeToClaudioMigrated()
      return true
    } catch (copyErr: unknown) {
      log(
        `failed to migrate ${legacyDir} → ${newDir}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      )
      return false
    }
  }
}

function markOpenclaudeToClaudioMigrated(): void {
  const at = new Date().toISOString()
  saveGlobalConfig(prev => ({ ...prev, openclaudeToClaudioMigratedAt: at }))
}

const PROVIDER_USE_ENVS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

function listPresentProviderEnvs(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_USE_ENVS.filter(key => env[key])
}

function profileFromLegacyFile(
  file: ProfileFile,
): ProviderProfileInput | null {
  const legacyProfile: LegacyProviderProfile = file.profile
  switch (legacyProfile) {
    case 'gemini': {
      const baseUrl = file.env.GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL
      const model = file.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
      return {
        provider: 'gemini',
        name: 'Google Gemini (legacy)',
        baseUrl,
        model,
        apiKey: file.env.GEMINI_API_KEY ?? file.env.GOOGLE_API_KEY ?? '',
      }
    }
    case 'mistral': {
      return {
        provider: 'mistral',
        name: 'Mistral (legacy)',
        baseUrl: file.env.MISTRAL_BASE_URL ?? DEFAULT_MISTRAL_BASE_URL,
        model: file.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL,
        apiKey: file.env.MISTRAL_API_KEY ?? '',
      }
    }
    case 'codex':
    case 'openai':
    case 'ollama':
    case 'atomic-chat':
    case 'nvidia-nim':
    case 'minimax': {
      const baseUrl = file.env.OPENAI_BASE_URL?.trim()
      const model = file.env.OPENAI_MODEL?.trim()
      if (!baseUrl || !model) return null
      return {
        provider: 'openai',
        name: legacyLabel(legacyProfile),
        baseUrl,
        model,
        apiKey: file.env.OPENAI_API_KEY ?? '',
      }
    }
    default:
      return null
  }
}

function legacyLabel(profile: LegacyProviderProfile): string {
  switch (profile) {
    case 'codex':
      return 'Codex (legacy)'
    case 'openai':
      return 'OpenAI (legacy)'
    case 'ollama':
      return 'Ollama (legacy)'
    case 'atomic-chat':
      return 'Atomic Chat (legacy)'
    case 'nvidia-nim':
      return 'NVIDIA NIM (legacy)'
    case 'minimax':
      return 'MiniMax (legacy)'
    case 'gemini':
      return 'Google Gemini (legacy)'
    case 'mistral':
      return 'Mistral (legacy)'
  }
}

type RescueProfile = {
  input: ProviderProfileInput
  warning?: string
}

function profileFromProviderEnvs(
  env: NodeJS.ProcessEnv,
): RescueProfile | null {
  if (env.CLAUDE_CODE_USE_OPENAI) {
    const baseUrl = env.OPENAI_BASE_URL?.trim() ?? env.OPENAI_API_BASE?.trim()
    const model = env.OPENAI_MODEL?.trim()
    if (!baseUrl || !model) return null
    return {
      input: {
        provider: 'openai',
        name: 'OpenAI (env)',
        baseUrl,
        model,
        apiKey: env.OPENAI_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_GEMINI) {
    return {
      input: {
        provider: 'gemini',
        name: 'Google Gemini (env)',
        baseUrl: env.GEMINI_BASE_URL?.trim() ?? DEFAULT_GEMINI_BASE_URL,
        model: env.GEMINI_MODEL?.trim() ?? DEFAULT_GEMINI_MODEL,
        apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_MISTRAL) {
    return {
      input: {
        provider: 'mistral',
        name: 'Mistral (env)',
        baseUrl: env.MISTRAL_BASE_URL?.trim() ?? DEFAULT_MISTRAL_BASE_URL,
        model: env.MISTRAL_MODEL?.trim() ?? DEFAULT_MISTRAL_MODEL,
        apiKey: env.MISTRAL_API_KEY ?? '',
      },
    }
  }
  if (env.CLAUDE_CODE_USE_GITHUB) {
    const githubToken = env.GITHUB_TOKEN?.trim() ?? env.GH_TOKEN?.trim() ?? ''
    return {
      input: {
        provider: 'openai',
        name: 'GitHub Copilot (legacy env)',
        baseUrl: GITHUB_COPILOT_DEFAULT_BASE_URL,
        model: GITHUB_COPILOT_DEFAULT_MODEL,
        apiKey: '',
        extras: githubToken ? { githubToken } : undefined,
      },
    }
  }
  if (env.CLAUDE_CODE_USE_BEDROCK) {
    const awsRegion =
      env.AWS_REGION?.trim() ??
      env.AWS_DEFAULT_REGION?.trim() ??
      DEFAULT_AWS_REGION
    return {
      input: {
        provider: 'bedrock',
        name: 'AWS Bedrock (legacy env)',
        baseUrl: `https://bedrock-runtime.${awsRegion}.amazonaws.com`,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
        extras: { awsRegion },
      },
    }
  }
  if (env.CLAUDE_CODE_USE_VERTEX) {
    const gcpProject =
      env.GCLOUD_PROJECT?.trim() ??
      env.GOOGLE_CLOUD_PROJECT?.trim() ??
      env.ANTHROPIC_VERTEX_PROJECT_ID?.trim()
    const gcpRegion = env.CLOUD_ML_REGION?.trim() ?? DEFAULT_VERTEX_REGION
    const extras: NonNullable<ProviderProfileInput['extras']> = { gcpRegion }
    if (gcpProject) extras.gcpProject = gcpProject
    return {
      input: {
        provider: 'vertex',
        name: 'Google Vertex AI (legacy env)',
        baseUrl: `https://${gcpRegion}-aiplatform.googleapis.com`,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
        extras,
      },
    }
  }
  if (env.CLAUDE_CODE_USE_FOUNDRY) {
    return {
      input: {
        provider: 'foundry',
        name: 'Azure AI Foundry (legacy env)',
        baseUrl: FOUNDRY_PLACEHOLDER_BASE_URL,
        model: DEFAULT_CLAUDE_CLOUD_MODEL,
      },
      warning:
        'Profile created from CLAUDE_CODE_USE_FOUNDRY but azureResource missing — open /provider to complete',
    }
  }
  return null
}

export function runClaudioStartupMigrations(options?: {
  processEnv?: NodeJS.ProcessEnv
  homeDir?: string
  log?: (message: string) => void
}): StartupMigrationsResult {
  const env = options?.processEnv ?? process.env
  const log = options?.log ?? defaultLog
  const result: StartupMigrationsResult = {
    legacyProfileMigrated: false,
    envsIgnored: [],
    notices: [],
    homePathsMoved: [],
  }

  // 1.2 — rebrand: relocate the entire ~/.openclaude/ dir to ~/.claudio/.
  // Runs before everything else so subsequent reads (global config, legacy
  // profile loader) hit the new dir.
  migrateOpenclaudeToClaudio({
    homeDir: options?.homeDir,
    log,
  })

  // 1.3 — relocate ~/.openclaude.json + ~/.openclaude-model-cache/ into
  // the new in-dir layout. Must run before any consumer reads the global
  // config (e.g. getActiveProviderProfile() below) — those calls will hit
  // the new path and silently see a missing file otherwise.
  result.homePathsMoved = migrateLegacyHomePaths({
    processEnv: env,
    homeDir: options?.homeDir,
    log,
  })

  // 1.4 — legacy ~/.openclaude-profile.json -> providerProfiles[]
  const legacy = loadProfileFile()
  if (legacy) {
    const input = profileFromLegacyFile(legacy)
    if (input && !getActiveProviderProfile()) {
      const saved = addProviderProfile(input, { makeActive: true })
      if (saved) {
        result.legacyProfileMigrated = true
        const notice =
          'migrated legacy ~/.openclaude-profile.json to providerProfiles[]'
        result.notices.push(notice)
        log(notice)
      }
    }
    // Whether or not the input could be derived, drop the file: keeping it
    // around makes startup re-attempt the same migration each run.
    deleteProfileFile()
  }

  // 1.5 — rescue CLAUDE_CODE_USE_* envs
  const presentEnvs = listPresentProviderEnvs(env)
  if (presentEnvs.length > 0) {
    const active = getActiveProviderProfile()
    if (!active) {
      const rescue = profileFromProviderEnvs(env)
      if (rescue) {
        const saved = addProviderProfile(rescue.input, { makeActive: true })
        if (saved) {
          result.rescueEnvAdoptedAs = saved.name
          const notice = `migrated env-based config to /provider as "${saved.name}"`
          result.notices.push(notice)
          log(notice)
          if (rescue.warning) {
            result.notices.push(rescue.warning)
            log(rescue.warning)
          }
        }
      }
    } else {
      result.envsIgnored = presentEnvs
      const notice = `ignoring ${presentEnvs.join(', ')} — managed by /provider`
      result.notices.push(notice)
      log(notice)
    }
  }

  return result
}

function defaultLog(message: string): void {
  // Yellow channel — matches existing managedEnv warning style without
  // pulling chalk into hot startup imports.
  process.stderr.write(`[33m${message}[0m\n`)
}
