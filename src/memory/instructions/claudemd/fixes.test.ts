/**
 * The three "fix" decisions of the `memory/claudemd` spec (Findings 3, 4, 5).
 * The characterization suites leave each of them unpinned on purpose, so they
 * are pinned here, against the real loader and real files.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { clearMemoryFileCaches, getClaudeMds, getMemoryFiles, processMemoryFile, resetGetMemoryFilesCache } from 'src/memory/instructions/claudemd.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getAllowedSettingSources, getOriginalCwd, setAllowedSettingSources, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const ALL_SOURCES: SettingSource[] = ['policySettings', 'flagSettings', 'userSettings', 'projectSettings', 'localSettings']
const TOUCHED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_AUTO_MEMORY'] as const

let root: string
const saved = { cwd: '', sources: [] as SettingSource[], env: {} as Record<string, string | undefined> }

function write(rel: string, text: string): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

beforeAll(() => {
  saved.cwd = getOriginalCwd()
  saved.sources = [...getAllowedSettingSources()]
  for (const key of TOUCHED_ENV) saved.env[key] = process.env[key]
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-fixes-')))
  setOriginalCwd(join(root, 'real', 'repo'))
  setAllowedSettingSources(ALL_SOURCES)
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  resetSettingsCache()
  clearMemoryFileCaches()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  setOriginalCwd(saved.cwd)
  setAllowedSettingSources(saved.sources)
  for (const key of TOUCHED_ENV) {
    if (saved.env[key] === undefined) delete process.env[key]
    else process.env[key] = saved.env[key]
  }
  getManagedFilePath.cache.clear?.()
  resetSettingsCache()
  // Leave the one-shot report armed, as a fresh process has it.
  resetGetMemoryFilesCache()
})

describe('Findings 3: the managed file has a label of its own', () => {
  const labelOf = (type: MemoryType): string =>
    /^Contents of \/f\.md \((.+)\):$/m.exec(getClaudeMds([{ type, path: '/f.md', content: 'x' }]))?.[1] ?? ''

  test('it names the organization\'s managed policy, not the user\'s private global instructions', () => {
    const managed = labelOf('Managed')

    expect(managed).toMatch(/organization/)
    expect(managed).toMatch(/managed policy/)
    expect(managed).not.toMatch(/private/)
    expect(managed).not.toBe(labelOf('User'))
  })

  test('every type the loader produces gets a distinct label', () => {
    const types: MemoryType[] = ['Managed', 'User', 'Project', 'Local', 'AutoMem', 'TeamMem']

    expect(new Set(types.map(labelOf)).size).toBe(types.length)
  })
})

describe('Findings 4: claudeMdExcludes resolves every literal directory before the first wildcard', () => {
  function excludes(patterns: string[]): void {
    write('config/settings.json', JSON.stringify({ claudeMdExcludes: patterns }))
    resetSettingsCache()
  }

  async function loads(rel: string): Promise<boolean> {
    return (await processMemoryFile(join(root, rel), 'Local', new Set(), true)).length > 0
  }

  // Each pattern is written through <root>/alias, a link to <root>/real.
  const cases: Array<[string, (alias: string) => string, boolean]> = [
    ['a glob right after the linked directory (the fix)', alias => `${alias}/**/CLAUDE.local.md`, false],
    ['a single-segment wildcard right after the link', alias => `${alias}/*/CLAUDE.local.md`, false],
    ['a literal path through the link', alias => `${alias}/repo/CLAUDE.local.md`, false],
    ['a glob after a literal directory below the link', alias => `${alias}/repo/**/CLAUDE.local.md`, false],
    ['a literal path through the link to a missing directory', alias => `${alias}/gone/**/CLAUDE.local.md`, true],
    ['a glob for another file name', alias => `${alias}/**/AGENTS.md`, true],
  ]
  test.each(cases)('%s', async (_name, pattern, loaded) => {
    write('real/repo/CLAUDE.local.md', 'local\n')
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    excludes([pattern(join(root, 'alias'))])

    expect(await loads('real/repo/CLAUDE.local.md')).toBe(loaded)
  })
})

describe('Findings 5: getMemoryFiles() and getMemoryFiles(false) share one cache entry', () => {
  test('both spellings return the same array, and the forced load stays apart', async () => {
    write('real/repo/AGENTS.md', 'repo\n')

    const absent = await getMemoryFiles()
    const explicit = await getMemoryFiles(false)
    const forced = await getMemoryFiles(true)

    expect(explicit).toBe(absent)
    expect(forced).not.toBe(absent)
    expect(getMemoryFiles.cache.has(false)).toBe(true)
    expect(getMemoryFiles.cache.has(undefined)).toBe(false)
  })
})
