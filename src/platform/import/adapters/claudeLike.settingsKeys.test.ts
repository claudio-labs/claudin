/**
 * Guards the one place where `/import` and the startup migration must NOT agree.
 *
 * The startup migration moves `~/.claude` into `~/.claudin` wholesale, keys
 * included. `/import` promised the opposite, so a well-meaning "make the two
 * whitelists share a constant" refactor would silently start copying API keys
 * out of another agent's config.
 */
import { expect, test } from 'bun:test'

import { claudeAdapter } from 'src/platform/import/adapters/claudeLike.js'
import { makeFixture } from 'src/platform/import/__testutils__/fixtures.js'

const SETTINGS_WITH_SECRETS = JSON.stringify({
  theme: 'dark',
  permissions: { allow: [] },
  providerProfiles: [
    { id: 'p1', name: 'OpenAI', provider: 'openai', apiKey: 'sk-super-secret' },
  ],
  activeProviderProfileId: 'p1',
  mcpServers: { github: { command: 'npx', args: ['-y', 'g'] } },
})

test('/import never carries provider profiles across, because they hold API keys', async () => {
  const ctx = makeFixture({ home: { '.claude/settings.json': SETTINGS_WITH_SECRETS } })
  const plan = await claudeAdapter.collect(ctx)

  const keys = plan.artifacts
    .filter(artifact => artifact.kind === 'settingsKey')
    .map(artifact => (artifact.kind === 'settingsKey' ? artifact.key : ''))
  expect(keys).not.toContain('providerProfiles')
  expect(keys).not.toContain('activeProviderProfileId')
  expect(JSON.stringify(plan)).not.toContain('sk-super-secret')
})

test('mcpServers is imported as servers, not copied as a settings blob', async () => {
  const ctx = makeFixture({ home: { '.claude/settings.json': SETTINGS_WITH_SECRETS } })
  const plan = await claudeAdapter.collect(ctx)

  const keys = plan.artifacts
    .filter(artifact => artifact.kind === 'settingsKey')
    .map(artifact => (artifact.kind === 'settingsKey' ? artifact.key : ''))
  expect(keys).not.toContain('mcpServers')
  expect(
    plan.artifacts.filter(artifact => artifact.kind === 'mcpServer'),
  ).toHaveLength(1)
})
