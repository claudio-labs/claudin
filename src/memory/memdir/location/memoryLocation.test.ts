import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'
import {
  type LocationSettings,
  type MemoryLocationInputs,
  resolveMemoryLocation,
  type TrustedLocationSource,
} from 'src/memory/memdir/location/memoryLocation.js'

function inputs(
  layers: Partial<Record<string, LocationSettings>>,
  overrides: Partial<MemoryLocationInputs> = {},
): { inputs: MemoryLocationInputs; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    inputs: {
      envOverride: undefined,
      readLayer: (source: TrustedLocationSource) => {
        asked.push(source)
        return layers[source]
      },
      homeDir: '/home/ann',
      projectRoot: '/work/app/packages/web',
      repoRoot: '/work/app',
      memoryBase: '/home/ann/.claudin',
      ...overrides,
    },
  }
}

/** The location with its branded directories read as plain strings. */
function plain(
  location: ReturnType<typeof resolveMemoryLocation>,
): Record<string, string> {
  return { ...location }
}

describe('resolveMemoryLocation', () => {
  test('the checked-in project settings are never consulted', () => {
    const { inputs: all, asked } = inputs({
      projectSettings: { autoMemoryDirectory: '/planted', autoMemoryProjectLocal: false },
    })
    expect(resolveMemoryLocation(all).kind).toBe('project-local')
    expect(asked).not.toContain('projectSettings')
    expect(new Set(asked)).toEqual(
      new Set(['policySettings', 'flagSettings', 'localSettings', 'userSettings']),
    )
  })

  test('a valid environment override is taken without reading any setting', () => {
    const { inputs: env, asked } = inputs({}, { envOverride: '/mnt/memory//' })
    expect(plain(resolveMemoryLocation(env))).toEqual({ kind: 'env-override', dir: `/mnt/memory${sep}` })
    expect(asked).toEqual([])
  })

  test('project-local carries the legacy fallback of the repository root', () => {
    const { inputs: repo } = inputs({})
    expect(plain(resolveMemoryLocation(repo))).toEqual({
      kind: 'project-local',
      dir: join('/work/app', '.claudin', 'memory') + sep,
      repoRoot: '/work/app',
      legacyDir: join('/home/ann/.claudin', 'projects', '-work-app', 'memory') + sep,
    })
  })

  test('outside a repository the legacy slug is the project root', () => {
    const { inputs: outside } = inputs({}, { repoRoot: null })
    expect(plain(resolveMemoryLocation(outside))).toEqual({
      kind: 'legacy',
      dir: join('/home/ann/.claudin', 'projects', '-work-app-packages-web', 'memory') + sep,
    })
  })
})
