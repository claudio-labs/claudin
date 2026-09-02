import { expect, test } from 'bun:test'

import { artifactKey, collectImportPlan } from 'src/platform/import/collect.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import { makeFixture } from 'src/platform/import/__testutils__/fixtures.js'

function twoAgentsWithTheSameServer() {
  return makeFixture({
    home: {
      '.claude/settings.json': JSON.stringify({
        mcpServers: { github: { command: 'claude-github' } },
      }),
      '.kimi/mcp.json': JSON.stringify({
        mcpServers: { github: { command: 'kimi-github' } },
      }),
    },
  })
}

test('the agent selected first wins a name collision, and the loser says who won', async () => {
  const ctx = twoAgentsWithTheSameServer()
  const plan = await collectImportPlan(ctx, ['claude', 'kimi'])
  const servers = plan.artifacts.filter(a => a.kind === 'mcpServer')
  expect(servers).toHaveLength(2)
  expect(servers[0]?.status).toBe('new')
  expect(servers[1]?.status).toBe('conflict')
  expect(servers[1]?.statusReason).toContain('Claude Code')
})

test('reversing the selection order reverses who wins', async () => {
  const ctx = twoAgentsWithTheSameServer()
  const plan = await collectImportPlan(ctx, ['kimi', 'claude'])
  const servers = plan.artifacts.filter(a => a.kind === 'mcpServer')
  expect(servers[1]?.statusReason).toContain('Kimi CLI')
})

test('an unselected agent contributes nothing, however configured it is', async () => {
  const ctx = twoAgentsWithTheSameServer()
  const plan = await collectImportPlan(ctx, ['kimi'])
  expect(plan.artifacts.every(artifact => artifact.agent === 'kimi')).toBe(true)
})

test('an MCP server collides on name-within-scope, a file on its destination', () => {
  const shared = {
    agent: 'claude' as const,
    source: '/s',
    status: 'new' as const,
  }
  expect(
    artifactKey({
      ...shared,
      scope: 'user',
      destination: 'a',
      kind: 'mcpServer',
      name: 'github',
      config: { type: 'stdio', command: 'x', args: [] },
    }),
  ).toBe(
    artifactKey({
      ...shared,
      scope: 'user',
      destination: 'b',
      kind: 'mcpServer',
      name: 'github',
      config: { type: 'stdio', command: 'y', args: [] },
    }),
  )

  expect(
    artifactKey({
      ...shared,
      scope: 'user',
      destination: '/dst/review.md',
      kind: 'command',
      name: 'review',
      markdown: 'a',
    }),
  ).not.toBe(
    artifactKey({
      ...shared,
      scope: 'user',
      destination: '/dst/other.md',
      kind: 'command',
      name: 'review',
      markdown: 'a',
    }),
  )
})

test('the same server at different scopes is not a collision', () => {
  const shared = {
    agent: 'cursor' as const,
    source: '/s',
    destination: 'x',
    status: 'new' as const,
    kind: 'mcpServer' as const,
    name: 'github',
    config: { type: 'stdio' as const, command: 'x', args: [] },
  }
  expect(artifactKey({ ...shared, scope: 'user' })).not.toBe(
    artifactKey({ ...shared, scope: 'project' }),
  )
})

test('detection lists every configured agent and nothing else', async () => {
  const ctx = twoAgentsWithTheSameServer()
  expect(detectForeignAgents(ctx).map(agent => agent.id).sort()).toEqual([
    'claude',
    'kimi',
  ])
})
