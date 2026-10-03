/**
 * Characterization of `src/memory/instructions/projectInstructions.ts`: which
 * file names count as a directory's root instructions, and which one wins.
 *
 * The functions take the existence check as a parameter. The tests pass the
 * real `existsSync` over a temp tree, narrowed to that tree so that whatever
 * sits in /tmp or / cannot change an answer; one test passes a check of its
 * own to reach the filesystem root.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, parse, relative, sep } from 'path'
// One line per import: the provenance measure skips import statements.
import { findProjectInstructionFilePathInAncestors, getProjectInstructionFilePath, getProjectInstructionFilePaths, isProjectInstructionFileName, PRIMARY_PROJECT_INSTRUCTION_FILE } from 'src/memory/instructions/projectInstructions.js'

let root: string
const made: string[] = []

const inTreeExists = (path: string): boolean => path.startsWith(root + sep) && existsSync(path)
const local = (path: string | null): string | null => (path === null ? null : relative(root, path))

function touch(rel: string): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x\n')
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'project-instr-')))
  made.push(root)
})

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('the names', () => {
  test('AGENTS.md is the primary name, CLAUDE.md the fallback, in that order', () => {
    expect(PRIMARY_PROJECT_INSTRUCTION_FILE).toBe('AGENTS.md')
    expect(getProjectInstructionFilePaths(join('/', 'w', 'p'))).toEqual([join('/', 'w', 'p', 'AGENTS.md'), join('/', 'w', 'p', 'CLAUDE.md')])
  })

  const names: Array<[string, boolean]> = [
    ['AGENTS.md', true],
    ['CLAUDE.md', true],
    ['agents.md', false],
    ['Claude.md', false],
    ['CLAUDE.local.md', false],
    ['AGENTS.md.bak', false],
    ['', false],
  ]
  test('isProjectInstructionFileName is exact and case-sensitive', () => {
    expect(names.map(([name]) => [name, isProjectInstructionFileName(name)])).toEqual(names)
  })
})

describe('getProjectInstructionFilePath', () => {
  const cases: Array<[string, string[], string]> = [
    ['both exist: AGENTS.md', ['AGENTS.md', 'CLAUDE.md'], 'AGENTS.md'],
    ['only CLAUDE.md', ['CLAUDE.md'], 'CLAUDE.md'],
    ['only AGENTS.md', ['AGENTS.md'], 'AGENTS.md'],
    ['neither: still the CLAUDE.md path', [], 'CLAUDE.md'],
  ]
  test.each(cases)('%s', (_name, present, expected) => {
    for (const name of present) touch(name)

    expect(local(getProjectInstructionFilePath(root, inTreeExists))).toBe(expected)
  })
})

describe('findProjectInstructionFilePathInAncestors', () => {
  const cases: Array<[string, string[], string | null]> = [
    ['the start directory itself', ['a/b/AGENTS.md'], 'a/b/AGENTS.md'],
    ['the nearest directory wins, whichever name it has', ['a/AGENTS.md', 'a/b/CLAUDE.md'], 'a/b/CLAUDE.md'],
    ['an ancestor, AGENTS.md before CLAUDE.md', ['a/CLAUDE.md', 'a/AGENTS.md'], 'a/AGENTS.md'],
    ['two levels up', ['AGENTS.md'], 'AGENTS.md'],
    ['nothing anywhere', [], null],
  ]
  test.each(cases)('%s', (_name, present, expected) => {
    for (const rel of present) touch(rel)
    mkdirSync(join(root, 'a', 'b'), { recursive: true })

    expect(local(findProjectInstructionFilePathInAncestors(join(root, 'a', 'b'), inTreeExists))).toBe(expected)
  })

  test('the search goes as far as the filesystem root, and looks there too', () => {
    const top = parse(root).root
    const atTop = join(top, 'CLAUDE.md')

    expect(findProjectInstructionFilePathInAncestors(join(root, 'a'), path => path === atTop)).toBe(atTop)
  })
})
