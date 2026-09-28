import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { resolveRecordedPath } from 'src/vcs/git/repository/githubClones.js'
import {
  type CloneRecorderDeps,
  pathsUnder,
  recordCurrentClone,
  type RepoPaths,
  withoutPath,
  withPathFirst,
} from 'src/vcs/git/repository/knownClones.js'

describe('the mapping', () => {
  test('pathsUnder reads the lower-cased key and hands back a copy', () => {
    const mapping: RepoPaths = { 'acme/widgets': ['/a'] }
    pathsUnder(mapping, 'Acme/Widgets').push('/b')
    expect(pathsUnder(mapping, 'ACME/WIDGETS')).toEqual(['/a'])
    expect(pathsUnder(undefined, 'acme/widgets')).toEqual([])
  })

  test('withPathFirst moves a path to the front once, and changes nothing when it is first', () => {
    const mapping: RepoPaths = { 'acme/widgets': ['/a', '/b', '/c'], 'o/r': ['/o'] }
    expect(withPathFirst(mapping, 'Acme/Widgets', '/b')).toEqual({
      'acme/widgets': ['/b', '/a', '/c'],
      'o/r': ['/o'],
    })
    expect(withPathFirst(mapping, 'acme/widgets', '/a')).toBeNull()
    expect(withPathFirst(undefined, 'Acme/Widgets', '/new')).toEqual({ 'acme/widgets': ['/new'] })
    expect(mapping['acme/widgets']).toEqual(['/a', '/b', '/c'])
  })

  test('withoutPath drops every copy and the emptied entry, and changes nothing otherwise', () => {
    const mapping: RepoPaths = { 'acme/widgets': ['/a', '/b', '/a'], 'o/r': ['/o'] }
    expect(withoutPath(mapping, 'ACME/widgets', '/a')).toEqual({ 'acme/widgets': ['/b'], 'o/r': ['/o'] })
    expect(withoutPath(mapping, 'o/r', '/o')).toEqual({ 'acme/widgets': ['/a', '/b', '/a'] })
    expect(withoutPath(mapping, 'acme/widgets', '/missing')).toBeNull()
    expect(withoutPath(mapping, 'unknown/repo', '/a')).toBeNull()
    expect(mapping).toEqual({ 'acme/widgets': ['/a', '/b', '/a'], 'o/r': ['/o'] })
  })
})

function recorder(overrides: Partial<CloneRecorderDeps> = {}, stored?: RepoPaths) {
  const writes: RepoPaths[] = []
  const logged: string[] = []
  let current = stored
  const deps: CloneRecorderDeps = {
    detectRepository: async () => 'Acme/Widgets',
    launchDirectory: () => '/launch/pkg',
    repositoryRootOf: path => (path.startsWith('/launch') ? '/launch' : null),
    resolvePath: async path => `/real${path}`,
    store: {
      read: () => current,
      write: next => {
        writes.push(next)
        current = next
      },
    },
    log: message => logged.push(message),
    ...overrides,
  }
  return { deps, writes, logged }
}

describe('recordCurrentClone', () => {
  test('records the resolved root of the repository around the launch directory', async () => {
    const { deps, writes } = recorder()
    await recordCurrentClone(deps)
    expect(writes).toEqual([{ 'acme/widgets': ['/real/launch'] }])
  })

  test('outside any repository, the launch directory itself', async () => {
    const { deps, writes } = recorder({ repositoryRootOf: () => null })
    await recordCurrentClone(deps)
    expect(writes).toEqual([{ 'acme/widgets': ['/real/launch/pkg'] }])
  })

  test('nothing is written off GitHub, or when the path is first already', async () => {
    const offGitHub = recorder({ detectRepository: async () => null })
    await recordCurrentClone(offGitHub.deps)
    const alreadyFirst = recorder({}, { 'acme/widgets': ['/real/launch', '/older'] })
    await recordCurrentClone(alreadyFirst.deps)
    expect([offGitHub.writes, alreadyFirst.writes]).toEqual([[], []])
  })

  test('a failure is logged and never escapes', async () => {
    const { deps, writes, logged } = recorder({
      resolvePath: async () => {
        throw new Error('disk went away')
      },
    })
    await expect(recordCurrentClone(deps)).resolves.toBeUndefined()
    expect(writes).toEqual([])
    expect(logged.some(line => line.includes('disk went away'))).toBe(true)
  })
})

describe('resolveRecordedPath', () => {
  const scratch = new ScratchGit()
  afterAll(() => scratch.cleanup())

  test('resolves symlinks and comes back NFC; a path that does not resolve comes back as given', async () => {
    const base = scratch.tempDir('recorded')
    mkdirSync(join(base, 'cafe\u0301'))
    symlinkSync(join(base, 'cafe\u0301'), join(base, 'alias'))
    expect(await resolveRecordedPath(join(base, 'alias'))).toBe(join(base, 'caf\u00e9'))
    expect(await resolveRecordedPath(join(base, 'never-made'))).toBe(join(base, 'never-made'))
  })
})
