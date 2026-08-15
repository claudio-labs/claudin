import { afterEach, describe, expect, mock, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]

async function importFreshEnvUtils() {
  return import(`src/shared/envUtils.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
})

describe('Claudin paths', () => {
  test('defaults user config home to ~/.claudin', async () => {
    delete process.env.CLAUDIN_CONFIG_DIR
    const { resolveClaudinConfigHomeDir } = await importFreshEnvUtils()

    expect(
      resolveClaudinConfigHomeDir({ homeDir: homedir() }),
    ).toBe(join(homedir(), '.claudin'))
  })

  test('uses CLAUDIN_CONFIG_DIR override when provided', async () => {
    process.env.CLAUDIN_CONFIG_DIR = '/tmp/custom-claudin'
    const { getClaudinConfigHomeDir, resolveClaudinConfigHomeDir } =
      await importFreshEnvUtils()

    expect(getClaudinConfigHomeDir()).toBe('/tmp/custom-claudin')
    expect(
      resolveClaudinConfigHomeDir({
        configDirEnv: '/tmp/custom-claudin',
      }),
    ).toBe('/tmp/custom-claudin')
  })

  test('memoize re-resolves when CLAUDIN_CONFIG_DIR changes at runtime', async () => {
    delete process.env.CLAUDIN_CONFIG_DIR
    const { getClaudinConfigHomeDir } = await importFreshEnvUtils()

    expect(getClaudinConfigHomeDir()).toBe(join(homedir(), '.claudin'))

    process.env.CLAUDIN_CONFIG_DIR = '/tmp/runtime-changed'
    expect(getClaudinConfigHomeDir()).toBe('/tmp/runtime-changed')

    delete process.env.CLAUDIN_CONFIG_DIR
    expect(getClaudinConfigHomeDir()).toBe(join(homedir(), '.claudin'))
  })

})
