import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { isBareMode } from 'src/utils/envUtils.js'
import { getGeminiAuthMode } from 'src/services/api/geminiAuth.js'
import { getSecureStorage } from 'src/services/secureStorage/index.js'

export const GEMINI_TOKEN_STORAGE_KEY = 'gemini' as const

export type GeminiCredentialBlob = {
  accessToken: string
}

export function readGeminiAccessToken(): string | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as
      | ({ gemini?: GeminiCredentialBlob } & Record<string, unknown>)
      | null
    const token = data?.gemini?.accessToken?.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export function hydrateGeminiAccessTokenFromSecureStorage(): void {
  if (tryGetActiveProvider()?.transport !== 'gemini') {
    return
  }
  const authMode = getGeminiAuthMode(process.env)
  if (authMode && authMode !== 'access-token') {
    return
  }
  if (isBareMode()) {
    return
  }
  // resolveGeminiCredential reads the secure storage directly now; this hook
  // remains so callers can warm caches / surface errors at startup.
  readGeminiAccessToken()
}

export function saveGeminiAccessToken(token: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }
  const secureStorage = getSecureStorage()
  const previous = secureStorage.read() || {}
  const next = {
    ...(previous as Record<string, unknown>),
    [GEMINI_TOKEN_STORAGE_KEY]: { accessToken: trimmed },
  }
  return secureStorage.update(next as typeof previous)
}

export function clearGeminiAccessToken(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }
  const secureStorage = getSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[GEMINI_TOKEN_STORAGE_KEY]
  return secureStorage.update(next as typeof previous)
}
