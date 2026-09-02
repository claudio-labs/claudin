import { expect, test } from 'bun:test'

import { codexAdapter } from 'src/platform/import/adapters/codex.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'

const CONFIG = [
  'model = "gpt-5.4"',
  'model_provider = "openai"',
  'approval_policy = "on-request"',
  '',
  '[model_providers.openai]',
  'name = "OpenAI"',
  'base_url = "https://api.openai.com/v1"',
  'env_key = "OPENAI_API_KEY"',
  '',
  '[mcp_servers.github]',
  'command = "npx"',
  'args = ["-y", "server-github"]',
  '',
  '[mcp_servers.sentry]',
  'url = "https://mcp.sentry.dev/mcp"',
  'bearer_token_env_var = "SENTRY_TOKEN"',
].join('\n')

function codexFixture() {
  return makeFixture({
    home: {
      '.codex/config.toml': CONFIG,
      '.codex/AGENTS.md': 'Global Codex instructions.\n',
      '.codex/prompts/review.md': 'Review $ARGUMENTS.\n',
      '.codex/auth.json': '{"tokens":{}}',
    },
  })
}

test('Codex MCP tables become servers, including the token-by-env-var form', async () => {
  const plan = await codexAdapter.collect(codexFixture())
  expect(artifactNames(plan, 'mcpServer')).toEqual(['github', 'sentry'])

  const sentry = artifactsOfKind(plan, 'mcpServer').find(
    server => server.name === 'sentry',
  )
  expect(sentry?.config).toEqual({
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
  })
})

test('the provider hint carries the env var NAME and never a token', async () => {
  const plan = await codexAdapter.collect(codexFixture())
  const hint = artifactsOfKind(plan, 'providerHint')[0]
  expect(hint).toMatchObject({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    envKey: 'OPENAI_API_KEY',
  })
  expect(JSON.stringify(hint)).not.toContain('auth.json')
})

test('Codex prompts and the global AGENTS.md are imported', async () => {
  const plan = await codexAdapter.collect(codexFixture())
  expect(artifactNames(plan, 'command')).toEqual(['review'])

  const instructions = artifactsOfKind(plan, 'instructions')[0]
  expect(instructions?.text).toContain('Global Codex instructions')
  // User memory is CLAUDE.md even when the source was called AGENTS.md.
  expect(instructions?.destination.endsWith('.claudin/CLAUDE.md')).toBe(true)
})

test('auth.json and the approval policy are reported, not imported', async () => {
  const plan = await codexAdapter.collect(codexFixture())
  const labels = plan.notImportable.map(item => item.label)
  expect(labels).toContain('credentials')
  expect(labels).toContain('approval & sandbox policy')
})

test('Codex skills are imported, and its bundled .system ones are not', async () => {
  const ctx = makeFixture({
    home: {
      '.codex/skills/deploy/SKILL.md': '---\nname: deploy\n---\n',
      '.codex/skills/.system/skill-creator/SKILL.md': '---\nname: bundled\n---\n',
      '.codex/skills/notaskill/README.md': 'no SKILL.md here',
    },
  })
  const plan = await codexAdapter.collect(ctx)
  expect(artifactNames(plan, 'skillDir')).toEqual(['deploy'])
})

test('a project .codex/skills directory is imported at project scope', async () => {
  const ctx = makeFixture({
    project: { '.codex/skills/local/SKILL.md': '---\nname: local\n---\n' },
  })
  const skills = artifactsOfKind(await codexAdapter.collect(ctx), 'skillDir')
  expect(skills.map(skill => skill.name)).toEqual(['local'])
  expect(skills[0]?.scope).toBe('project')
})

test('a project .codex/config.toml contributes MCP servers only', async () => {
  const ctx = makeFixture({
    project: {
      '.codex/config.toml': [
        'model = "should-be-ignored"',
        '[mcp_servers.local]',
        'command = "./server"',
      ].join('\n'),
    },
  })
  const plan = await codexAdapter.collect(ctx)
  expect(artifactNames(plan, 'mcpServer')).toEqual(['local'])
  expect(artifactsOfKind(plan, 'providerHint')).toEqual([])
})

test('CODEX_HOME relocates the whole search', async () => {
  const ctx = makeFixture({
    home: { 'elsewhere/config.toml': '[mcp_servers.a]\ncommand = "a"' },
  })
  const relocated = { ...ctx, env: { CODEX_HOME: ctx.homePath('elsewhere') } }
  expect(artifactNames(await codexAdapter.collect(relocated), 'mcpServer')).toEqual(
    ['a'],
  )
  expect(detectForeignAgents(relocated).map(agent => agent.id)).toContain('codex')
})

test('a malformed config.toml is a warning, not a crash', async () => {
  const ctx = makeFixture({ home: { '.codex/config.toml': 'model = ' } })
  const plan = await codexAdapter.collect(ctx)
  expect(plan.artifacts).toEqual([])
  expect(plan.warnings.join(' ')).toContain('config.toml')
})
