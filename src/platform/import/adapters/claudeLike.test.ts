import { expect, test } from 'bun:test'

import {
  claudeAdapter,
  openclaudeAdapter,
} from 'src/platform/import/adapters/claudeLike.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'

function claudeHome() {
  return makeFixture({
    home: {
      '.claude/settings.json': JSON.stringify({
        theme: 'dark',
        editorMode: 'vim',
        permissions: { allow: ['Bash(ls:*)'] },
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'server-github'] },
        },
      }),
      '.claude/CLAUDE.md': '# My global rules\n',
      '.claude/commands/review.md':
        '---\ndescription: Review\n---\n\nReview $ARGUMENTS.\n',
      '.claude/commands/git/commit.md': 'Commit it.\n',
      '.claude/agents/planner.md':
        '---\nname: planner\ndescription: Plans\ntools:\n  - Read\n---\n\nYou plan.\n',
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\n\nDeploy.\n',
      '.claude/.credentials.json': '{"claudeAiOauth":{"accessToken":"x"}}',
    },
  })
}

test('the Claude adapter finds every surface it owns, at user scope', async () => {
  const ctx = claudeHome()
  const plan = await claudeAdapter.collect(ctx)

  expect(artifactNames(plan, 'mcpServer')).toEqual(['github'])
  expect(artifactNames(plan, 'command')).toEqual(['git:commit', 'review'])
  expect(artifactNames(plan, 'agent')).toEqual(['planner'])
  expect(artifactNames(plan, 'skillDir')).toEqual(['deploy'])
  expect(artifactNames(plan, 'settingsKey')).toEqual([
    'editorMode',
    'permissions',
    'theme',
  ])
  expect(artifactsOfKind(plan, 'instructions')).toHaveLength(1)
})

test('Claude commands and agents cross over byte for byte', async () => {
  const ctx = claudeHome()
  const plan = await claudeAdapter.collect(ctx)

  const agent = artifactsOfKind(plan, 'agent')[0]
  expect(agent?.markdown).toContain('tools:')
  expect(agent?.markdown).toContain('- Read')

  const nested = artifactsOfKind(plan, 'command').find(
    c => c.name === 'git:commit',
  )
  expect(nested?.destination.endsWith('commands/git/commit.md')).toBe(true)
})

test('credentials are named as not importable rather than copied', async () => {
  const plan = await claudeAdapter.collect(claudeHome())
  const entry = plan.notImportable.find(item => item.label === 'credentials')
  expect(entry?.detail).toContain('/provider')
  expect(
    plan.artifacts.some(artifact => artifact.source.includes('.credentials')),
  ).toBe(false)
})

test('a project .claude directory is collected at project scope', async () => {
  const ctx = makeFixture({
    project: {
      '.claude/settings.json': JSON.stringify({
        mcpServers: { local: { command: './server' } },
      }),
      '.claude/commands/ship.md': 'Ship it.\n',
    },
  })
  const plan = await claudeAdapter.collect(ctx)
  expect(plan.artifacts.every(artifact => artifact.scope === 'project')).toBe(
    true,
  )
  expect(artifactNames(plan, 'mcpServer')).toEqual(['local'])
  expect(artifactNames(plan, 'command')).toEqual(['ship'])
})

test('openclaude is the same adapter pointed at its own directory', async () => {
  const ctx = makeFixture({
    home: {
      '.openclaude/settings.json': JSON.stringify({
        mcpServers: { fs: { command: 'server-fs' } },
      }),
    },
  })
  const plan = await openclaudeAdapter.collect(ctx)
  expect(artifactNames(plan, 'mcpServer')).toEqual(['fs'])
  expect(await claudeAdapter.collect(ctx)).toEqual(
    expect.objectContaining({ artifacts: [] }),
  )
})

test('openclaude is also probed under ~/.config, since its dir is undocumented', async () => {
  const ctx = makeFixture({
    home: {
      '.config/openclaude/settings.json': JSON.stringify({
        mcpServers: { fs: { command: 'server-fs' } },
      }),
    },
  })
  expect(artifactNames(await openclaudeAdapter.collect(ctx), 'mcpServer')).toEqual(
    ['fs'],
  )
  expect(detectForeignAgents(ctx).map(agent => agent.id)).toContain('openclaude')
})

test('detection reports nothing when no agent is configured', () => {
  expect(detectForeignAgents(makeFixture())).toEqual([])
})
