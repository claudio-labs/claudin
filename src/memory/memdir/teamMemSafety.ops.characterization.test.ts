/**
 * How a tool call is told apart as team-memory work, and the words the
 * collapsed read/search line uses for it. The collapsed transcript view asks
 * these questions of every Write, Edit and search call it folds.
 */
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'

import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import {
  appendTeamMemorySummaryParts,
  isTeamMemFile,
  isTeamMemorySearch,
  isTeamMemoryWriteOrEdit,
} from 'src/memory/memdir/teamMemoryOps.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const world = useMemdirWorld()

const team = (...segments: string[]): string => join(getTeamMemPath(), ...segments)
const priv = (...segments: string[]): string => join(getAutoMemPath(), ...segments)

const turnMemoryOff = (): void => {
  process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
  world().refresh()
}

describe('isTeamMemFile', () => {
  test('a file below the team directory counts while memory is on', () => {
    expect(isTeamMemFile(team('deploy.md'))).toBe(true)
    expect(isTeamMemFile(team('bugs', 'flaky.md'))).toBe(true)
    expect(isTeamMemFile(priv('deploy.md'))).toBe(false)
    expect(isTeamMemFile(join(world().project, 'README.md'))).toBe(false)
  })

  test('nothing counts while auto memory is off', () => {
    turnMemoryOff()
    expect(isTeamMemFile(team('deploy.md'))).toBe(false)
  })
})

describe('isTeamMemoryWriteOrEdit', () => {
  const cases: Array<[string, string, () => unknown, boolean]> = [
    ['a Write into team', FILE_WRITE_TOOL_NAME, () => ({ file_path: team('deploy.md'), content: 'x' }), true],
    ['an Edit into a team category', FILE_EDIT_TOOL_NAME, () => ({ file_path: team('decisions', 'a.md') }), true],
    ['a Write naming its target as path', FILE_WRITE_TOOL_NAME, () => ({ path: team('deploy.md') }), true],
    ['file_path wins over path', FILE_WRITE_TOOL_NAME, () => ({ file_path: priv('a.md'), path: team('a.md') }), false],
    ['a Write into private memory', FILE_WRITE_TOOL_NAME, () => ({ file_path: priv('a.md') }), false],
    ['a Write into the project', FILE_EDIT_TOOL_NAME, () => ({ file_path: join(world().project, 'a.md') }), false],
    ['a Read of a team file', 'Read', () => ({ file_path: team('deploy.md') }), false],
    ['a Patch touching team', 'Patch', () => ({ file_path: team('deploy.md') }), false],
    ['a tool name in other case', 'write', () => ({ file_path: team('deploy.md') }), false],
    ['no input', FILE_WRITE_TOOL_NAME, () => undefined, false],
    ['null input', FILE_EDIT_TOOL_NAME, () => null, false],
    ['an input without a path', FILE_WRITE_TOOL_NAME, () => ({ content: 'x' }), false],
  ]
  test.each(cases)('%s', (_what, tool, input, expected) => {
    expect(isTeamMemoryWriteOrEdit(tool, input())).toBe(expected)
  })

  test('nothing counts while auto memory is off', () => {
    turnMemoryOff()
    expect(isTeamMemoryWriteOrEdit(FILE_WRITE_TOOL_NAME, { file_path: team('deploy.md') })).toBe(false)
  })
})

describe('isTeamMemorySearch', () => {
  const cases: Array<[string, () => unknown, boolean]> = [
    ['a search under a team category', () => ({ pattern: 'flaky', path: team('bugs') }), true],
    ['a search of one team file', () => ({ pattern: 'x', path: team('deploy.md') }), true],
    ['a search of private memory', () => ({ pattern: 'x', path: priv() }), false],
    ['a search of a sibling of team', () => ({ pattern: 'x', path: `${priv('team-old')}${sep}` }), false],
    ['a team glob without a path', () => ({ pattern: 'x', glob: `${getTeamMemPath()}**/*.md` }), false],
    ['a pattern naming team without a path', () => ({ pattern: team('deploy.md') }), false],
    ['an empty path', () => ({ pattern: 'x', path: '' }), false],
    ['no input', () => undefined, false],
    ['null input', () => null, false],
  ]
  test.each(cases)('%s', (_what, input, expected) => {
    expect(isTeamMemorySearch(input())).toBe(expected)
  })

  test('nothing counts while auto memory is off', () => {
    turnMemoryOff()
    expect(isTeamMemorySearch({ pattern: 'x', path: team('bugs') })).toBe(false)
  })
})

describe('appendTeamMemorySummaryParts', () => {
  type Counts = Parameters<typeof appendTeamMemorySummaryParts>[0]
  const cases: Array<[string, Counts, boolean, string[], string[]]> = [
    ['one recall, done', { teamMemoryReadCount: 1 }, false, [], ['Recalled 1 team memory']],
    ['several recalls, running', { teamMemoryReadCount: 3 }, true, [], ['Recalling 3 team memories']],
    ['searches, done', { teamMemorySearchCount: 4 }, false, [], ['Searched team memories']],
    ['one search, running', { teamMemorySearchCount: 1 }, true, [], ['Searching team memories']],
    ['one write, done', { teamMemoryWriteCount: 1 }, false, [], ['Wrote 1 team memory']],
    ['several writes, running', { teamMemoryWriteCount: 2 }, true, [], ['Writing 2 team memories']],
    [
      'all three, done',
      { teamMemoryReadCount: 2, teamMemorySearchCount: 1, teamMemoryWriteCount: 1 },
      false,
      [],
      ['Recalled 2 team memories', 'searched team memories', 'wrote 1 team memory'],
    ],
    [
      'all three, running, after other parts',
      { teamMemoryReadCount: 1, teamMemorySearchCount: 2, teamMemoryWriteCount: 5 },
      true,
      ['Read 3 files'],
      ['Read 3 files', 'recalling 1 team memory', 'searching team memories', 'writing 5 team memories'],
    ],
    ['a write after other parts', { teamMemoryWriteCount: 1 }, false, ['Searched 2 patterns'], ['Searched 2 patterns', 'wrote 1 team memory']],
    [
      'search then write, running',
      { teamMemorySearchCount: 1, teamMemoryWriteCount: 1 },
      true,
      [],
      ['Searching team memories', 'writing 1 team memory'],
    ],
    ['zero counts', { teamMemoryReadCount: 0, teamMemorySearchCount: 0, teamMemoryWriteCount: 0 }, false, ['x'], ['x']],
    ['no counts at all', {}, true, [], []],
  ]
  test.each(cases)('%s', (_what, counts, active, before, after) => {
    const parts = [...before]
    expect(appendTeamMemorySummaryParts(counts, active, parts)).toBeUndefined()
    expect(parts).toEqual(after)
  })
})
