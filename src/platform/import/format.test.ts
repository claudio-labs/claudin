import { expect, test } from 'bun:test'

import { formatImportReport, groupArtifacts } from 'src/platform/import/format.js'
import type { ImportArtifact, ImportReport } from 'src/platform/import/types.js'

function command(name: string, destination: string): ImportArtifact {
  return {
    agent: 'codex',
    scope: 'user',
    source: `/src/${name}.md`,
    destination,
    status: 'new',
    kind: 'command',
    name,
    markdown: 'body',
  }
}

function mcp(name: string, scope: 'user' | 'project'): ImportArtifact {
  return {
    agent: 'codex',
    scope,
    source: '/src/config.toml',
    destination: 'MCP config',
    status: 'new',
    kind: 'mcpServer',
    name,
    config: { type: 'stdio', command: 'x', args: [] },
  }
}

test('a group names its count and lists up to three members', () => {
  const groups = groupArtifacts([
    mcp('github', 'user'),
    mcp('filesystem', 'user'),
    mcp('slack', 'user'),
    mcp('sentry', 'user'),
  ])
  expect(groups[0]?.label).toBe('4 MCP servers')
  expect(groups[0]?.detail).toContain('github, filesystem, slack, +1')
})

test('one server is singular', () => {
  expect(groupArtifacts([mcp('github', 'user')])[0]?.label).toBe('1 MCP server')
})

test('user and project artifacts of the same kind stay separate rows', () => {
  const groups = groupArtifacts([mcp('a', 'user'), mcp('b', 'project')])
  expect(groups).toHaveLength(2)
  expect(groups.map(group => group.scope)).toEqual(['user', 'project'])
})

test('a file group collapses to the directory its members share', () => {
  const groups = groupArtifacts(
    [
      command('review', '/home/u/.claudin/commands/review.md'),
      command('git:commit', '/home/u/.claudin/commands/git/commit.md'),
    ],
    '/home/u',
  )
  expect(groups[0]?.detail).toBe('→ ~/.claudin/commands/')
})

test('a single file group shows the file itself', () => {
  const groups = groupArtifacts(
    [command('review', '/home/u/.claudin/commands/review.md')],
    '/home/u',
  )
  expect(groups[0]?.detail).toBe('→ ~/.claudin/commands/review.md')
})

test('an instructions group is named after the file it came from', () => {
  const groups = groupArtifacts([
    {
      agent: 'gemini',
      scope: 'user',
      source: '/home/u/.gemini/GEMINI.md',
      destination: '/home/u/.claudin/CLAUDE.md',
      status: 'new',
      kind: 'instructions',
      text: 'x',
    },
  ])
  expect(groups[0]?.label).toBe('GEMINI.md')
})

test('the report lists what was applied, what was skipped and why', () => {
  const report: ImportReport = {
    applied: [mcp('github', 'user')],
    skipped: [
      {
        ...command('review', '/dst/review.md'),
        status: 'conflict',
        statusReason: 'review.md already exists',
      },
    ],
    notImportable: [
      { agent: 'codex', label: 'credentials', detail: 'never copied' },
    ],
    warnings: [],
    errors: [],
  }
  const output = formatImportReport(report)
  expect(output).toContain('✓ 1 MCP server')
  expect(output).toContain('⚠ 1 skipped')
  expect(output).toContain('review — review.md already exists')
  expect(output).toContain('credentials — never copied')
  expect(output).toContain('Restart Claudin')
})

test('an empty report says so rather than rendering an empty list', () => {
  const output = formatImportReport({
    applied: [],
    skipped: [],
    notImportable: [],
    warnings: [],
    errors: [],
  })
  expect(output).toBe('Nothing was imported.')
})

test('a provider hint reminds the user that no token came with it', () => {
  const output = formatImportReport({
    applied: [
      {
        agent: 'codex',
        scope: 'user',
        source: '/src/config.toml',
        destination: '/dst/config.json',
        status: 'new',
        kind: 'providerHint',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
      },
    ],
    skipped: [],
    notImportable: [],
    warnings: [],
    errors: [],
  })
  expect(output).toContain('no tokens were copied')
  expect(output).toContain('gpt-5.4 at https://api.openai.com/v1')
})
