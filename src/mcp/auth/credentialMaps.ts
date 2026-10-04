/**
 * Typed access to the two maps of the secure store this slice owns, so no
 * other module reads or writes the store's shape by hand. Every write is a
 * read-modify-write of the whole store that leaves every other key alone, and
 * a removal of something absent writes nothing.
 */

import {
  getSecureStorage,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'

type OAuthMap = NonNullable<SecureStorageData['mcpOAuth']>
type ClientConfigMap = NonNullable<SecureStorageData['mcpOAuthClientConfig']>

export type StoredMcpOAuthEntry = OAuthMap[string]

function withoutKey<T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> {
  const rest = { ...map }
  delete rest[key]
  return rest
}

function writeStore(next: SecureStorageData): void {
  getSecureStorage().update(next)
}

export function getOAuthEntry(key: string): StoredMcpOAuthEntry | undefined {
  return getSecureStorage().read()?.mcpOAuth?.[key]
}

export function putOAuthEntry(key: string, entry: StoredMcpOAuthEntry): void {
  const store = getSecureStorage().read() ?? {}
  const map: OAuthMap = { ...store.mcpOAuth, [key]: entry }
  writeStore({ ...store, mcpOAuth: map })
}

export function removeOAuthEntry(key: string): void {
  const store = getSecureStorage().read()
  const map = store?.mcpOAuth
  if (!store || !map || !Object.hasOwn(map, key)) return
  writeStore({ ...store, mcpOAuth: withoutKey(map, key) })
}

export function putClientSecret(key: string, clientSecret: string): void {
  const store = getSecureStorage().read() ?? {}
  const map: ClientConfigMap = {
    ...store.mcpOAuthClientConfig,
    [key]: { clientSecret },
  }
  writeStore({ ...store, mcpOAuthClientConfig: map })
}

export function removeClientSecret(key: string): void {
  const store = getSecureStorage().read()
  const map = store?.mcpOAuthClientConfig
  if (!store || !map || !Object.hasOwn(map, key)) return
  writeStore({ ...store, mcpOAuthClientConfig: withoutKey(map, key) })
}
