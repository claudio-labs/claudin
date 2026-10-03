/**
 * Which file the /memory picker offers as "Project memory".
 *
 * `getProjectMemoryPathForSelector` gets the instruction files the session
 * loaded and the directory the session started in. Half the cases hand it
 * those files the way the loader reports them after reading a real tree; the
 * rest give it hand-made lists, to show that only the list counts and the disk
 * is never consulted.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  clearMemoryFileCaches,
  getMemoryFiles,
  type MemoryFileInfo,
} from 'src/memory/instructions/claudemd.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { getProjectMemoryPathForSelector } from 'src/memory/ui/memoryFileSelectorPaths.js'

const world = useMemdirWorld()

type Loaded = Pick<MemoryFileInfo, 'path' | 'type' | 'parent'>

function loaded(entries: Loaded[]): MemoryFileInfo[] {
  return entries.map(entry => ({ ...entry, content: '' }))
}

async function loaderView(): Promise<MemoryFileInfo[]> {
  clearMemoryFileCaches()
  return getMemoryFiles()
}

describe('getProjectMemoryPathForSelector: from what the loader read', () => {
  const scenarios: Array<{
    name: string
    files: string[]
    start: string
    expected: string
  }> = [
    { name: 'no instruction file anywhere: AGENTS.md in the start directory', files: [], start: 'repo', expected: 'repo/AGENTS.md' },
    { name: 'AGENTS.md in the start directory', files: ['repo/AGENTS.md'], start: 'repo', expected: 'repo/AGENTS.md' },
    { name: 'only CLAUDE.md in the start directory', files: ['repo/CLAUDE.md'], start: 'repo', expected: 'repo/CLAUDE.md' },
    { name: 'both names in one directory: AGENTS.md wins', files: ['repo/AGENTS.md', 'repo/CLAUDE.md'], start: 'repo', expected: 'repo/AGENTS.md' },
    { name: 'the nearest ancestor that has one', files: ['repo/AGENTS.md'], start: 'repo/pkg/inner', expected: 'repo/AGENTS.md' },
    { name: 'the start directory before an ancestor', files: ['repo/AGENTS.md', 'repo/pkg/CLAUDE.md'], start: 'repo/pkg', expected: 'repo/pkg/CLAUDE.md' },
    { name: '.claudin/CLAUDE.md is not a root instruction file', files: ['repo/.claudin/CLAUDE.md'], start: 'repo', expected: 'repo/AGENTS.md' },
    { name: 'CLAUDE.local.md is not one either', files: ['repo/CLAUDE.local.md'], start: 'repo', expected: 'repo/AGENTS.md' },
    { name: 'a file in a sibling directory is not an ancestor', files: ['repo/other/AGENTS.md'], start: 'repo/pkg', expected: 'repo/pkg/AGENTS.md' },
  ]

  for (const { name, files, start, expected } of scenarios) {
    test(name, async () => {
      const w = world()
      w.repo(join(w.root, 'repo'))
      for (const file of files) w.put(join(w.root, file), `# ${file}\n`)
      const startDir = w.mkdir(start)
      w.enter(startDir)

      expect(getProjectMemoryPathForSelector(await loaderView(), startDir)).toBe(join(w.root, expected))
    })
  }

  test('a file the loader reached through an @-import does not count', async () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const pkg = w.mkdir('repo', 'pkg')
    // The root file imports pkg/AGENTS.md, so the loader reports that one as
    // an import even though the walk passes its directory too.
    w.put(join(repo, 'AGENTS.md'), '# root\n\n@./pkg/AGENTS.md\n')
    w.put(join(pkg, 'AGENTS.md'), '# imported\n')
    w.enter(pkg)

    const files = await loaderView()
    expect(files.find(f => f.path === join(pkg, 'AGENTS.md'))?.parent).toBe(join(repo, 'AGENTS.md'))
    expect(getProjectMemoryPathForSelector(files, pkg)).toBe(join(repo, 'AGENTS.md'))
  })
})

describe('getProjectMemoryPathForSelector: only the list counts', () => {
  const cwd = '/work/app/service'
  const cases: Array<{ name: string; files: Loaded[]; expected: string }> = [
    { name: 'an empty list', files: [], expected: '/work/app/service/AGENTS.md' },
    {
      name: 'a project file at the start directory',
      files: [{ path: '/work/app/service/CLAUDE.md', type: 'Project' }],
      expected: '/work/app/service/CLAUDE.md',
    },
    {
      name: 'a project file two levels up',
      files: [{ path: '/work/AGENTS.md', type: 'Project' }],
      expected: '/work/AGENTS.md',
    },
    {
      name: 'at the filesystem root',
      files: [{ path: '/CLAUDE.md', type: 'Project' }],
      expected: '/CLAUDE.md',
    },
    {
      name: 'an imported project file is skipped',
      files: [{ path: '/work/app/AGENTS.md', type: 'Project', parent: '/work/app/README.md' }],
      expected: '/work/app/service/AGENTS.md',
    },
    {
      name: 'a user-level file of the same name is skipped',
      files: [{ path: '/work/app/CLAUDE.md', type: 'User' }],
      expected: '/work/app/service/AGENTS.md',
    },
    {
      name: 'a local file of the same name is skipped',
      files: [{ path: '/work/app/AGENTS.md', type: 'Local' }],
      expected: '/work/app/service/AGENTS.md',
    },
    {
      name: 'a project file with another name is skipped',
      files: [{ path: '/work/app/RULES.md', type: 'Project' }],
      expected: '/work/app/service/AGENTS.md',
    },
    {
      name: 'the imported copy is skipped while a loaded one further up is found',
      files: [
        { path: '/work/app/AGENTS.md', type: 'Project', parent: '/work/app/README.md' },
        { path: '/work/CLAUDE.md', type: 'Project' },
      ],
      expected: '/work/CLAUDE.md',
    },
    {
      name: 'AGENTS.md before CLAUDE.md, whatever the list order',
      files: [
        { path: '/work/app/CLAUDE.md', type: 'Project' },
        { path: '/work/app/AGENTS.md', type: 'Project' },
      ],
      expected: '/work/app/AGENTS.md',
    },
  ]

  for (const { name, files, expected } of cases) {
    test(name, () => {
      expect(getProjectMemoryPathForSelector(loaded(files), cwd)).toBe(expected)
    })
  }

  test('a file on disk that the loader did not report is ignored', () => {
    const w = world()
    const dir = w.mkdir('plain')
    w.put(join(dir, 'CLAUDE.md'), '# on disk, never loaded\n')

    expect(getProjectMemoryPathForSelector([], dir)).toBe(join(dir, 'AGENTS.md'))
  })
})
