import { afterEach, describe, expect, mock, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

async function importFreshEnvUtils() {
  return import(`./envUtils.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  mock.restore()
})

describe('Claudio paths', () => {
  test('defaults user config home to ~/.claudio', async () => {
    delete process.env.CLAUDIO_CONFIG_DIR
    const { resolveClaudioConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudioConfigHomeDir({ homeDir: homedir() }),
    ).toBe(join(homedir(), '.claudio'))
  })

  test('uses CLAUDIO_CONFIG_DIR override when provided', async () => {
    process.env.CLAUDIO_CONFIG_DIR = '/tmp/custom-claudio'
    const { getClaudioConfigHomeDir, resolveClaudioConfigHomeDir } =
      await importFreshEnvUtils()

    expect(getClaudioConfigHomeDir()).toBe('/tmp/custom-claudio')
    expect(
      resolveClaudioConfigHomeDir({
        configDirEnv: '/tmp/custom-claudio',
      }),
    ).toBe('/tmp/custom-claudio')
  })

  test('memoize re-resolves when CLAUDIO_CONFIG_DIR changes at runtime', async () => {
    delete process.env.CLAUDIO_CONFIG_DIR
    const { getClaudioConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudioConfigHomeDir()).toBe(join(homedir(), '.claudio'))

    process.env.CLAUDIO_CONFIG_DIR = '/tmp/runtime-changed'
    expect(getClaudioConfigHomeDir()).toBe('/tmp/runtime-changed')

    delete process.env.CLAUDIO_CONFIG_DIR
    expect(getClaudioConfigHomeDir()).toBe(join(homedir(), '.claudio'))
  })

  test('legacy OPENCLAUDE_CONFIG_DIR has no effect', async () => {
    delete process.env.CLAUDIO_CONFIG_DIR
    process.env.OPENCLAUDE_CONFIG_DIR = '/tmp/should-be-ignored'
    const { getClaudioConfigHomeDir, readConfigDirEnv } =
      await importFreshEnvUtils()

    expect(readConfigDirEnv()).toBeUndefined()
    expect(getClaudioConfigHomeDir()).toBe(join(homedir(), '.claudio'))
  })
})
