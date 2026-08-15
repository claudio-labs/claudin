import { afterEach, beforeEach, expect, test } from 'bun:test'
import { arch, hostname, release, type } from 'os'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildKimiDeviceHeaders,
  getKimiDeviceHeaders,
  getOrCreateKimiDeviceId,
} from 'src/services/api/kimiDeviceHeaders.js'
import { getKimiCliVersion } from 'src/services/api/kimiOAuthShared.js'

const originalConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeEach(() => {
  process.env.CLAUDIN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'kimi-dev-'))
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = originalConfigDir
})

test('buildKimiDeviceHeaders emits the X-Msh-* set with the CLI-shaped values', () => {
  const headers = buildKimiDeviceHeaders('device-uuid-123')
  expect(headers['X-Msh-Platform']).toBe('kimi_code_cli')
  expect(headers['X-Msh-Device-Id']).toBe('device-uuid-123')
  expect(headers['X-Msh-Version']).toBe(getKimiCliVersion())
  expect(headers['X-Msh-Device-Name']).toBe(hostname())
  expect(headers['X-Msh-Device-Model']).toBe(`${type()} ${release()} ${arch()}`)
  expect(headers['X-Msh-Os-Version']).toBe(release())
  // Device-Model is the compound descriptor, not bare release() — guards a swap
  // between the two headers that both otherwise contain release().
  expect(headers['X-Msh-Device-Model']).not.toBe(headers['X-Msh-Os-Version'])
})

test('getKimiDeviceHeaders resolves a device id into the header set', async () => {
  const headers = await getKimiDeviceHeaders()
  expect(headers['X-Msh-Device-Id']).toBeTruthy()
  expect(headers['X-Msh-Platform']).toBe('kimi_code_cli')
})

test('getOrCreateKimiDeviceId is stable across calls', async () => {
  const first = await getOrCreateKimiDeviceId()
  const second = await getOrCreateKimiDeviceId()
  expect(first).toBe(second)
  expect(first.length).toBeGreaterThan(0)
})
