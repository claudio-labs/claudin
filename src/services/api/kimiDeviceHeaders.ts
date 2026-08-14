/**
 * Kimi Code device-fingerprint headers (`X-Msh-*`) + a stable device id.
 *
 * The Kimi Code backend requires these headers on both the OAuth (`auth.kimi.com`)
 * and coding (`api.kimi.com/coding`) hosts, or it returns 401/403. Values mirror
 * the official CLI — see `docs/tech/kimi-code/wire-format.md`. The device id is
 * generated once per install and persisted (secure storage) so the backend sees
 * a consistent device across sessions and logins.
 */

import { arch, hostname, release, type } from 'os'
import { randomUUID } from 'crypto'
import { isBareMode } from 'src/utils/envUtils.js'
import { isENOENT } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { getSecureStorage } from 'src/services/secureStorage/index.js'
import {
  asTrimmedString,
  getKimiCliVersion,
  KIMI_MSH_PLATFORM,
} from 'src/services/api/kimiOAuthShared.js'

const KIMI_DEVICE_ID_KEY = 'kimiDeviceId' as const

let inMemoryDeviceId: string | undefined

function getKimiSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: true })
}

/**
 * Read the persisted device id, generating + persisting one on first use.
 * Falls back to an in-memory id when secure storage is unavailable (bare mode)
 * so requests still carry a stable-per-process value.
 */
export async function getOrCreateKimiDeviceId(): Promise<string> {
  if (inMemoryDeviceId) return inMemoryDeviceId

  if (isBareMode()) {
    inMemoryDeviceId = randomUUID()
    return inMemoryDeviceId
  }

  const storage = getKimiSecureStorage()
  try {
    const existing = asTrimmedString((await storage.readAsync())?.[KIMI_DEVICE_ID_KEY])
    if (existing) {
      inMemoryDeviceId = existing
      return existing
    }
  } catch (e) {
    if (!isENOENT(e)) logError(e)
  }

  const generated = randomUUID()
  try {
    const previous = storage.read() || {}
    storage.update({ ...previous, [KIMI_DEVICE_ID_KEY]: generated })
  } catch (e) {
    logError(e)
  }
  inMemoryDeviceId = generated
  return generated
}

/** Build the `X-Msh-*` header set for a given device id. */
export function buildKimiDeviceHeaders(deviceId: string): Record<string, string> {
  return {
    'X-Msh-Platform': KIMI_MSH_PLATFORM,
    'X-Msh-Version': getKimiCliVersion(),
    'X-Msh-Device-Name': hostname(),
    'X-Msh-Device-Model': `${type()} ${release()} ${arch()}`,
    'X-Msh-Os-Version': release(),
    'X-Msh-Device-Id': deviceId,
  }
}

/** Convenience: resolve the device id and build the full `X-Msh-*` header set. */
export async function getKimiDeviceHeaders(): Promise<Record<string, string>> {
  return buildKimiDeviceHeaders(await getOrCreateKimiDeviceId())
}
