import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import {
  getProjectMemoryPathForSelector,
  instructionsFileName,
  PROJECT_INSTRUCTIONS_LABEL,
  USER_INSTRUCTIONS_LABEL,
} from 'src/memory/ui/memoryFileSelectorPaths.js'

function projectFile(path: string): MemoryFileInfo {
  return {
    path,
    type: 'Project',
    content: '',
  }
}

describe('getProjectMemoryPathForSelector', () => {
  test('uses the loaded repo-level AGENTS.md from a nested cwd', () => {
    const repoDir = '/repo'
    const nestedDir = join(repoDir, 'packages', 'app')

    expect(
      getProjectMemoryPathForSelector(
        [projectFile(join(repoDir, 'AGENTS.md'))],
        nestedDir,
      ),
    ).toBe(join(repoDir, 'AGENTS.md'))
  })

  test('uses the loaded repo-level CLAUDE.md fallback from a nested cwd', () => {
    const repoDir = '/repo'
    const nestedDir = join(repoDir, 'packages', 'app')

    expect(
      getProjectMemoryPathForSelector(
        [projectFile(join(repoDir, 'CLAUDE.md'))],
        nestedDir,
      ),
    ).toBe(join(repoDir, 'CLAUDE.md'))
  })

  test('prefers the closest loaded ancestor instruction file', () => {
    const repoDir = '/repo'
    const nestedProjectDir = join(repoDir, 'packages', 'app')

    expect(
      getProjectMemoryPathForSelector(
        [
          projectFile(join(repoDir, 'AGENTS.md')),
          projectFile(join(nestedProjectDir, 'CLAUDE.md')),
        ],
        join(nestedProjectDir, 'src'),
      ),
    ).toBe(join(nestedProjectDir, 'CLAUDE.md'))
  })

  test('defaults to a new AGENTS.md in the current cwd when no project file is loaded', () => {
    const cwd = join('/repo', 'packages', 'app')
    expect(getProjectMemoryPathForSelector([], cwd)).toBe(
      join(cwd, 'AGENTS.md'),
    )
  })

  test('ignores loaded project instruction files outside the current cwd ancestry', () => {
    const outsideRepoPath = join('/other-worktree', 'AGENTS.md')
    const cwd = join('/repo', 'packages', 'app')
    expect(
      getProjectMemoryPathForSelector(
        [projectFile(outsideRepoPath)],
        cwd,
      ),
    ).toBe(join(cwd, 'AGENTS.md'))
  })
})

describe('the instruction rows of /memory', () => {
  test('are instructions, not memory — memory is the three directories below them', () => {
    expect(USER_INSTRUCTIONS_LABEL).toBe('User instructions')
    expect(PROJECT_INSTRUCTIONS_LABEL).toBe('Project instructions')
  })

  test('MemoryFileSelector labels its two rows with them, and no row "memory"', () => {
    // React-Compiler output that needs AppState to render, so its two label
    // assignments are pinned on the text.
    const source = readFileSync(join(import.meta.dir, 'MemoryFileSelector.tsx'), 'utf8')
    expect(source).toContain('label = USER_INSTRUCTIONS_LABEL;')
    expect(source).toContain('label = PROJECT_INSTRUCTIONS_LABEL;')
    expect(source).not.toContain('"User memory"')
    expect(source).not.toContain('"Project memory"')
  })

  test('the "Opened …" line names the file by its row', () => {
    const paths = { user: '/home/u/.claudin/CLAUDE.md', project: '/repo/AGENTS.md' }
    expect(instructionsFileName('/home/u/.claudin/CLAUDE.md', paths)).toBe('user instructions')
    expect(instructionsFileName('/repo/AGENTS.md', paths)).toBe('project instructions')
    expect(instructionsFileName('/repo/.claudin/rules/testing.md', paths)).toBe('instructions file')
  })
})
