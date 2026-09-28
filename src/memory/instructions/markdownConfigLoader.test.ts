/**
 * The loader's fixes, through its public entry points. The characterization
 * suite beside this file pins everything that did not change.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative } from 'path'

import {
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
} from 'src/memory/instructions/markdownConfigLoader.js'
import {
  getAllowedSettingSources,
  getProjectRoot,
  setAllowedSettingSources,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const ALL_SOURCES: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']

let root: string
let repo: string
const before = { configDir: undefined as string | undefined, sources: [] as SettingSource[], projectRoot: '' }

function write(path: string, text: string): void {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

async function loadedPaths(subdir: 'agents' | 'commands'): Promise<string[]> {
  return (await loadMarkdownFilesForSubdir(subdir, repo)).map(file => relative(root, file.filePath))
}

beforeAll(() => {
  before.configDir = process.env.CLAUDIN_CONFIG_DIR
  before.sources = [...getAllowedSettingSources()]
  before.projectRoot = getProjectRoot()
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'md-config-')))
  repo = join(root, 'repo')
  // A `.git` directory makes `repo` a repository root, which ends the walk.
  mkdirSync(join(repo, '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  getManagedSettingsDropInDir.cache.delete(undefined)
  setAllowedSettingSources([...ALL_SOURCES])
  setProjectRoot(root)
  resetSettingsCache()
  loadMarkdownFilesForSubdir.cache.clear()
})

afterEach(() => {
  loadMarkdownFilesForSubdir.cache.clear()
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  resetSettingsCache()
  setAllowedSettingSources([...before.sources])
  setProjectRoot(before.projectRoot)
  if (before.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = before.configDir
  rmSync(root, { recursive: true, force: true })
})

describe('only a directory is a source', () => {
  test('a file where a source directory belongs is neither walked nor loaded, in any source', async () => {
    const stray = '---\nname: stray\n---\nNot configuration.\n'
    write('managed/.claudin/agents', stray)
    write('config/agents', stray)
    write('repo/.claudin/agents', stray)
    expect(getProjectDirsUpToHome('agents', repo)).toEqual([])
    expect(await loadedPaths('agents')).toEqual([])
  })
})

describe('a failed load is not cached', () => {
  test('once the cause is gone, the same call loads', async () => {
    write('repo/.claudin/commands/deploy.md', 'Deploy.\n')
    // No managed path at all: the load fails where every load starts.
    getManagedFilePath.cache.set(undefined, null)
    await expect(loadMarkdownFilesForSubdir('commands', repo)).rejects.toThrow()
    getManagedFilePath.cache.set(undefined, join(root, 'managed'))
    expect(await loadedPaths('commands')).toEqual(['repo/.claudin/commands/deploy.md'])
  })
})
