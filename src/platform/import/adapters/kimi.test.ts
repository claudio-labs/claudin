import { expect, test } from 'bun:test'

import { kimiAdapter } from 'src/platform/import/adapters/kimi.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'

function kimiFixture() {
  return makeFixture({
    home: {
      '.kimi/mcp.json': JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'g'] },
          docs: { type: 'http', url: 'https://docs/mcp' },
        },
      }),
      '.kimi/AGENTS.md': 'Kimi global instructions.\n',
      '.kimi/config.toml': [
        '[providers.moonshot]',
        'type = "openai"',
        'base_url = "https://api.moonshot.ai/v1"',
        '',
        '[models.k2]',
        'provider = "moonshot"',
        'model = "kimi-k2"',
        'max_context_size = 200000',
      ].join('\n'),
      '.kimi/credentials/moonshot.json': '{"token":"secret"}',
    },
  })
}

test('Kimi MCP is Claude-shaped and imports without translation surprises', async () => {
  const plan = await kimiAdapter.collect(kimiFixture())
  expect(artifactNames(plan, 'mcpServer')).toEqual(['docs', 'github'])
  expect(
    artifactsOfKind(plan, 'mcpServer').find(s => s.name === 'docs')?.config,
  ).toEqual({ type: 'http', url: 'https://docs/mcp' })
})

test('the provider hint pairs a provider with the model that names it', async () => {
  const plan = await kimiAdapter.collect(kimiFixture())
  expect(artifactsOfKind(plan, 'providerHint')[0]).toMatchObject({
    provider: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2',
  })
})

test('the credentials directory is never read, only named', async () => {
  const plan = await kimiAdapter.collect(kimiFixture())
  expect(plan.notImportable.map(item => item.label)).toContain('credentials')
  expect(JSON.stringify(plan.artifacts)).not.toContain('secret')
})

test('Kimi YAML agents are reported as undiscoverable rather than guessed at', async () => {
  const plan = await kimiAdapter.collect(kimiFixture())
  const entry = plan.notImportable.find(item => item.label === 'agents')
  expect(entry?.detail).toContain('--agent-file')
})

test('Kimi contributes nothing at project scope, since AGENTS.md is already read', async () => {
  const ctx = makeFixture({ project: { 'AGENTS.md': 'project rules' } })
  const plan = await kimiAdapter.collect(ctx)
  expect(plan.artifacts.filter(a => a.scope === 'project')).toEqual([])
})
