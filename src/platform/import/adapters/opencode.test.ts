import { expect, test } from 'bun:test'

import { opencodeAdapter } from 'src/platform/import/adapters/opencode.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'

test('the global config is read from ~/.config/opencode, JSONC included', async () => {
  const ctx = makeFixture({
    home: {
      '.config/opencode/opencode.jsonc': [
        '{',
        '  // my setup',
        '  "model": "anthropic/claude-opus-5",',
        '  "mcp": {',
        '    "github": { "type": "local", "command": ["npx", "-y", "g"] },',
        '    "docs": { "type": "remote", "url": "https://docs/mcp" },',
        '  },',
        '}',
      ].join('\n'),
    },
  })
  const plan = await opencodeAdapter.collect(ctx)
  expect(artifactNames(plan, 'mcpServer')).toEqual(['docs', 'github'])

  const github = artifactsOfKind(plan, 'mcpServer').find(s => s.name === 'github')
  expect(github?.config).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'g'],
  })
})

test('the model prefix picks the transport family, defaulting to openai', async () => {
  const anthropic = makeFixture({
    home: {
      '.config/opencode/opencode.json': JSON.stringify({
        model: 'anthropic/claude-opus-5',
      }),
    },
  })
  expect(
    artifactsOfKind(await opencodeAdapter.collect(anthropic), 'providerHint')[0],
  ).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' })

  const other = makeFixture({
    home: {
      '.config/opencode/opencode.json': JSON.stringify({ model: 'groq/llama' }),
    },
  })
  expect(
    artifactsOfKind(await opencodeAdapter.collect(other), 'providerHint')[0],
  ).toMatchObject({ provider: 'openai', model: 'llama' })
})

test('both the plural and the older singular directory names are read', async () => {
  const plural = makeFixture({
    home: {
      '.config/opencode/commands/ship.md': 'Ship.\n',
      '.config/opencode/agents/rev.md': '---\ndescription: d\n---\n\nBody.\n',
    },
  })
  const pluralPlan = await opencodeAdapter.collect(plural)
  expect(artifactNames(pluralPlan, 'command')).toEqual(['ship'])
  expect(artifactNames(pluralPlan, 'agent')).toEqual(['rev'])

  const singular = makeFixture({
    home: {
      '.config/opencode/command/ship.md': 'Ship.\n',
      '.config/opencode/agent/rev.md': '---\ndescription: d\n---\n\nBody.\n',
    },
  })
  const singularPlan = await opencodeAdapter.collect(singular)
  expect(artifactNames(singularPlan, 'command')).toEqual(['ship'])
  expect(artifactNames(singularPlan, 'agent')).toEqual(['rev'])
})

test('a project opencode.json and .opencode directory are project scope', async () => {
  const ctx = makeFixture({
    project: {
      'opencode.json': JSON.stringify({
        mcp: { local: { type: 'local', command: ['./s'] } },
      }),
      '.opencode/commands/x.md': 'x\n',
    },
  })
  const plan = await opencodeAdapter.collect(ctx)
  expect(plan.artifacts.every(artifact => artifact.scope === 'project')).toBe(
    true,
  )
  expect(artifactNames(plan, 'mcpServer')).toEqual(['local'])
  expect(artifactNames(plan, 'command')).toEqual(['x'])
  expect(detectForeignAgents(ctx).map(agent => agent.id)).toContain('opencode')
})

test('a permission block is reported rather than translated', async () => {
  const ctx = makeFixture({
    home: {
      '.config/opencode/opencode.json': JSON.stringify({
        permission: { bash: 'ask' },
      }),
    },
  })
  const plan = await opencodeAdapter.collect(ctx)
  expect(plan.notImportable.map(item => item.label)).toContain('permissions')
})

test('XDG_CONFIG_HOME relocates the global config', async () => {
  const base = makeFixture({
    home: { 'xdg/opencode/opencode.json': JSON.stringify({ mcp: { a: { type: 'local', command: ['a'] } } }) },
  })
  const ctx = { ...base, env: { XDG_CONFIG_HOME: base.homePath('xdg') } }
  expect(artifactNames(await opencodeAdapter.collect(ctx), 'mcpServer')).toEqual([
    'a',
  ])
})
