import { describe, expect, test } from 'bun:test'

import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import { parseBrowseValue, TIDY_VALUE } from 'src/memory/ui/memoryDirRows.js'
import {
  buildSelectorRows,
  classifyFile,
  type SelectorRow,
  type SelectorRowDeps,
  type SelectorRowInput,
} from 'src/memory/ui/memoryFileSelector/rows.js'

const USER_FILE = '/cfg/CLAUDE.md'
const START = '/work/repo'

const deps: SelectorRowDeps = {
  displayPath: path => (path.startsWith(`${START}/`) ? path.slice(START.length + 1) : `<${path}>`),
  agentMemoryDir: (agentType, scope) => `/agents/${scope}/${agentType}/`,
}

function file(path: string, type: MemoryFileInfo['type'], parent?: string): MemoryFileInfo {
  return { path, type, content: '', ...(parent === undefined ? {} : { parent }) }
}

function input(overrides: Partial<SelectorRowInput> = {}): SelectorRowInput {
  return {
    loadedFiles: [],
    startDir: START,
    userFilePath: USER_FILE,
    inGitRepo: true,
    autoMemoryOn: false,
    privateDir: '/mem/private/',
    teamDir: '/mem/private/team/',
    agents: [],
    ...overrides,
  }
}

type RowText = { label: string; description?: string }
const text = (rows: SelectorRow[]): RowText[] => rows.map(({ label, description }) => ({ label, description }))

describe('buildSelectorRows: the instruction files', () => {
  const cases: Array<{ name: string; given: Partial<SelectorRowInput>; rows: RowText[] }> = [
    {
      name: 'nothing loaded: the user and project files still get their rows',
      given: {},
      rows: [
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
        { label: 'Project memory', description: 'Checked in at ./AGENTS.md' },
      ],
    },
    {
      name: 'outside a repository the project file is saved, not checked in',
      given: { inGitRepo: false },
      rows: [
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
        { label: 'Project memory', description: 'Saved in ./AGENTS.md' },
      ],
    },
    {
      name: 'the private and team indexes are not listed as files',
      given: { loadedFiles: [file('/mem/private/MEMORY.md', 'AutoMem'), file('/mem/private/team/MEMORY.md', 'TeamMem')] },
      rows: [
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
        { label: 'Project memory', description: 'Checked in at ./AGENTS.md' },
      ],
    },
    {
      name: 'imports are indented one step per level past the first',
      given: {
        loadedFiles: [
          file(`${START}/CLAUDE.md`, 'Project'),
          file(`${START}/docs/a.md`, 'Project', `${START}/CLAUDE.md`),
          file(`${START}/docs/b.md`, 'Project', `${START}/docs/a.md`),
          file(`${START}/docs/c.md`, 'Project', `${START}/docs/b.md`),
        ],
      },
      rows: [
        { label: 'Project memory', description: 'Checked in at ./CLAUDE.md' },
        { label: 'L docs/a.md', description: '@-imported' },
        { label: '  L docs/b.md', description: '@-imported' },
        { label: '    L docs/c.md', description: '@-imported' },
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
      ],
    },
    {
      // Fix: every User-type file used to say "Saved in ~/.claudin/CLAUDE.md".
      name: 'a user rule has no description, and a user import says @-imported',
      given: {
        loadedFiles: [
          file(USER_FILE, 'User'),
          file('/cfg/style.md', 'User', USER_FILE),
          file('/cfg/rules/tone.md', 'User'),
        ],
      },
      rows: [
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
        { label: 'L </cfg/style.md>', description: '@-imported' },
        { label: '</cfg/rules/tone.md>', description: undefined },
        { label: 'Project memory', description: 'Checked in at ./AGENTS.md' },
      ],
    },
    {
      // Fix: the ancestor's file used to be described as ./AGENTS.md.
      name: 'a project file in an ancestor is described from the start directory',
      given: { startDir: `${START}/pkg/inner`, loadedFiles: [file(`${START}/AGENTS.md`, 'Project')] },
      rows: [
        { label: 'Project memory', description: 'Checked in at ../../AGENTS.md' },
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
      ],
    },
    {
      name: 'managed, rules and local files: their display path and no description',
      given: {
        loadedFiles: [
          file('/etc/claudin/CLAUDE.md', 'Managed'),
          file(`${START}/.claudin/rules/x.md`, 'Project'),
          file(`${START}/CLAUDE.local.md`, 'Local'),
        ],
      },
      rows: [
        { label: '</etc/claudin/CLAUDE.md>', description: undefined },
        { label: '.claudin/rules/x.md', description: undefined },
        { label: 'CLAUDE.local.md', description: undefined },
        { label: 'User memory', description: 'Saved in ~/.claudin/CLAUDE.md' },
        { label: 'Project memory', description: 'Checked in at ./AGENTS.md' },
      ],
    },
  ]

  for (const { name, given, rows } of cases) {
    test(name, () => {
      expect(text(buildSelectorRows(input(given), deps))).toEqual(rows)
    })
  }

  test('a file row hands back its own path, the missing ones theirs', () => {
    const rows = buildSelectorRows(input({ loadedFiles: [file('/etc/claudin/CLAUDE.md', 'Managed')] }), deps)
    expect(rows.map(row => row.value)).toEqual(['/etc/claudin/CLAUDE.md', USER_FILE, `${START}/AGENTS.md`])
  })
})

describe('buildSelectorRows: the memory folders', () => {
  const agents = [
    { agentType: 'reviewer', memory: 'project' as const },
    { agentType: 'plain' },
    { agentType: 'writer', memory: 'user' as const },
  ]

  test('only while auto memory is on', () => {
    const off = buildSelectorRows(input({ agents }), deps)
    expect(off.map(row => row.label)).toEqual(['User memory', 'Project memory'])
  })

  const counted: Array<{ name: string; counts?: { private: number; team: number }; labels: [string, string] }> = [
    { name: 'no counts', labels: ['Private memory', 'Team memory'] },
    { name: 'counts, zero included', counts: { private: 0, team: 4 }, labels: ['Private memory · 0', 'Team memory · 4'] },
  ]
  for (const { name, counts, labels } of counted) {
    test(`private, team, tidy, then each agent with a memory scope: ${name}`, () => {
      const rows = buildSelectorRows(input({ autoMemoryOn: true, counts, agents }), deps).slice(2)
      expect(text(rows)).toEqual([
        { label: labels[0], description: 'Saved in </mem/private/>' },
        { label: labels[1], description: 'Shared with the team, git-tracked at </mem/private/team/>' },
        { label: 'Tidy memories', description: 'Merge duplicate memories and rebuild the index' },
        { label: 'reviewer agent memory', description: 'project scope' },
        { label: 'writer agent memory', description: 'user scope' },
      ])
      expect(rows.map(row => row.emphasis)).toEqual([undefined, undefined, undefined, 'reviewer', 'writer'])
    })
  }

  test('the values: browse targets without the count, and the tidy sentinel', () => {
    const rows = buildSelectorRows(input({ autoMemoryOn: true, counts: { private: 2, team: 3 }, agents }), deps).slice(2)
    expect(rows.map(row => parseBrowseValue(row.value) ?? row.value)).toEqual([
      { dir: '/mem/private/', title: 'Private memory', isTeamDir: false },
      { dir: '/mem/private/team/', title: 'Team memory', isTeamDir: true },
      TIDY_VALUE,
      { dir: '/agents/project/reviewer/', title: 'reviewer agent memory', isTeamDir: false },
      { dir: '/agents/user/writer/', title: 'writer agent memory', isTeamDir: false },
    ])
  })

  test('no team row when team memory is off', () => {
    const labels = buildSelectorRows(input({ autoMemoryOn: true, teamDir: null }), deps).map(row => row.label)
    expect(labels).toEqual(['User memory', 'Project memory', 'Private memory', 'Tidy memories'])
  })
})

describe('classifyFile', () => {
  const anchors = { userFilePath: USER_FILE, projectFilePath: `${START}/AGENTS.md` }

  test('an import loop does not hang the depth count', () => {
    const a = file('/x/a.md', 'Project', '/x/b.md')
    const b = file('/x/b.md', 'Project', '/x/a.md')
    const byPath = new Map([a, b].map(f => [f.path, f]))
    expect(classifyFile(a, anchors, byPath)).toEqual({ kind: 'import', depth: 2 })
  })

  test('an import whose parent was not loaded is one level deep', () => {
    expect(classifyFile(file('/x/a.md', 'Project', '/x/gone.md'), anchors, new Map())).toEqual({ kind: 'import', depth: 1 })
  })
})
