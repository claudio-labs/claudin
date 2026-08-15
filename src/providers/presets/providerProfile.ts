/**
 * Legacy `.claudin-profile.json` sidecar shim.
 *
 * The active provider config lives in `providerProfiles[]` inside settings,
 * but older single-profile installs may still have a `.claudin-profile.json`
 * file on disk. This module exposes the load/delete helpers that
 * `claudinStartupMigrations` uses to convert that sidecar into the new
 * schema and remove it, plus the `ProviderProfile` enum / default URLs that
 * the migration code path consumes.
 *
 * Also re-exports secret-display helpers from providerSecrets so existing
 * import sites keep compiling while callers move off them.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

export {
  maskSecretForDisplay,
  redactSecretValueForDisplay,
  sanitizeApiKey,
  sanitizeProviderConfigValue,
} from 'src/providers/presets/providerSecrets.js'

const PROFILE_FILE_NAME = '.claudin-profile.json'

export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai'
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
export const DEFAULT_MISTRAL_MODEL = 'devstral-latest'

export type ProviderProfile =
  | 'openai'
  | 'ollama'
  | 'codex'
  | 'gemini'
  | 'atomic-chat'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'

export type ProfileEnv = {
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_API_KEY?: string
  CODEX_API_KEY?: string
  CODEX_CREDENTIAL_SOURCE?: 'oauth' | 'existing'
  CHATGPT_ACCOUNT_ID?: string
  CODEX_ACCOUNT_ID?: string
  GEMINI_API_KEY?: string
  GEMINI_AUTH_MODE?: string
  GEMINI_ACCESS_TOKEN?: string
  GEMINI_MODEL?: string
  GEMINI_BASE_URL?: string
  GOOGLE_API_KEY?: string
  NVIDIA_NIM?: string
  NVIDIA_API_KEY?: string
  NVIDIA_MODEL?: string
  MINIMAX_API_KEY?: string
  MINIMAX_BASE_URL?: string
  MINIMAX_MODEL?: string
  MISTRAL_BASE_URL?: string
  MISTRAL_API_KEY?: string
  MISTRAL_MODEL?: string
  BANKR_BASE_URL?: string
  BNKR_API_KEY?: string
  BANKR_MODEL?: string
}

export type ProfileFile = {
  profile: ProviderProfile
  env: ProfileEnv
  createdAt: string
}

type ProfileFileLocation = {
  cwd?: string
  filePath?: string
}

function resolveProfileFilePath(options?: ProfileFileLocation): string {
  if (options?.filePath) {
    return options.filePath
  }
  return resolve(options?.cwd ?? process.cwd(), PROFILE_FILE_NAME)
}

function isProviderProfile(value: unknown): value is ProviderProfile {
  return (
    value === 'openai' ||
    value === 'ollama' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'atomic-chat' ||
    value === 'nvidia-nim' ||
    value === 'minimax' ||
    value === 'mistral'
  )
}

export function loadProfileFile(options?: ProfileFileLocation): ProfileFile | null {
  const filePath = resolveProfileFilePath(options)
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ProfileFile>
    if (!isProviderProfile(parsed.profile) || !parsed.env || typeof parsed.env !== 'object') {
      return null
    }

    return {
      profile: parsed.profile,
      env: parsed.env,
      createdAt:
        typeof parsed.createdAt === 'string'
          ? parsed.createdAt
          : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function deleteProfileFile(options?: ProfileFileLocation): string {
  const filePath = resolveProfileFilePath(options)
  rmSync(filePath, { force: true })
  return filePath
}
