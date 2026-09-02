import { expect, test } from 'bun:test'

import {
  geminiAdapter,
  qwenAdapter,
} from 'src/platform/import/adapters/geminiLike.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'

test('mcpServers is read from the TOP level, not from the mcp policy section', async () => {
  const ctx = makeFixture({
    home: {
      '.gemini/settings.json': JSON.stringify({
        mcp: { allowed: ['github'] },
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'g'] },
          docs: { httpUrl: 'https://docs/mcp' },
          legacy: { url: 'https://legacy/sse' },
        },
      }),
    },
  })
  const plan = await geminiAdapter.collect(ctx)
  expect(artifactNames(plan, 'mcpServer')).toEqual(['docs', 'github', 'legacy'])

  const byName = new Map(
    artifactsOfKind(plan, 'mcpServer').map(server => [server.name, server.config]),
  )
  expect(byName.get('docs')).toEqual({ type: 'http', url: 'https://docs/mcp' })
  expect(byName.get('legacy')).toEqual({ type: 'sse', url: 'https://legacy/sse' })
})

test('GEMINI.md is imported at both scopes, from the right two places', async () => {
  const ctx = makeFixture({
    home: { '.gemini/GEMINI.md': 'global gemini rules' },
    project: { 'GEMINI.md': 'project gemini rules' },
  })
  const plan = await geminiAdapter.collect(ctx)
  const instructions = artifactsOfKind(plan, 'instructions')
  expect(instructions).toHaveLength(2)
  expect(
    instructions.find(a => a.scope === 'project')?.destination.endsWith('AGENTS.md'),
  ).toBe(true)
  expect(
    instructions.find(a => a.scope === 'user')?.destination.endsWith('CLAUDE.md'),
  ).toBe(true)
})

test('context.fileName overrides the memory filename', async () => {
  const ctx = makeFixture({
    home: {
      '.gemini/settings.json': JSON.stringify({
        context: { fileName: 'HOUSE.md' },
      }),
      '.gemini/HOUSE.md': 'house rules',
      '.gemini/GEMINI.md': 'should be ignored',
    },
  })
  const plan = await geminiAdapter.collect(ctx)
  expect(artifactsOfKind(plan, 'instructions')[0]?.text).toBe('house rules')
})

test('both TOML and markdown commands are read from one directory', async () => {
  const ctx = makeFixture({
    home: {
      '.qwen/commands/old.toml': 'prompt = "old style {{args}}"',
      '.qwen/commands/git/new.md':
        '---\ndescription: New\n---\n\nnew style {{args}}\n',
    },
  })
  const plan = await qwenAdapter.collect(ctx)
  expect(artifactNames(plan, 'command')).toEqual(['git:new', 'old'])
  for (const command of artifactsOfKind(plan, 'command')) {
    expect(command.markdown).toContain('$ARGUMENTS')
  }
})

test('Qwen has agents and skills, which Gemini does not', async () => {
  const files = {
    'commands/x.toml': 'prompt = "x"',
    'agents/reviewer.md': '---\ndescription: Reviews\n---\n\nYou review.\n',
    'skills/deploy/SKILL.md': '---\nname: deploy\n---\n\nDeploy.\n',
  }
  const qwenCtx = makeFixture({
    home: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [`.qwen/${k}`, v]),
    ),
  })
  const geminiCtx = makeFixture({
    home: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [`.gemini/${k}`, v]),
    ),
  })

  const qwenPlan = await qwenAdapter.collect(qwenCtx)
  expect(artifactNames(qwenPlan, 'agent')).toEqual(['reviewer'])
  expect(artifactNames(qwenPlan, 'skillDir')).toEqual(['deploy'])

  const geminiPlan = await geminiAdapter.collect(geminiCtx)
  expect(artifactNames(geminiPlan, 'agent')).toEqual([])
  expect(artifactNames(geminiPlan, 'skillDir')).toEqual([])
})

test('the provider hint reads the nested model section and the legacy flat key', async () => {
  const nested = makeFixture({
    home: {
      '.gemini/settings.json': JSON.stringify({
        model: { name: 'gemini-3-pro', baseUrl: 'https://g/v1' },
      }),
    },
  })
  expect(artifactsOfKind(await geminiAdapter.collect(nested), 'providerHint')[0])
    .toMatchObject({ provider: 'gemini', model: 'gemini-3-pro' })

  const flat = makeFixture({
    home: { '.gemini/settings.json': JSON.stringify({ model: 'gemini-3-pro' }) },
  })
  expect(artifactsOfKind(await geminiAdapter.collect(flat), 'providerHint')[0])
    .toMatchObject({ model: 'gemini-3-pro' })
})

test('Qwen is treated as an OpenAI-compatible transport, Gemini as its own', async () => {
  const qwen = makeFixture({
    home: { '.qwen/settings.json': JSON.stringify({ model: { name: 'qwen3' } }) },
  })
  expect(
    artifactsOfKind(await qwenAdapter.collect(qwen), 'providerHint')[0]?.provider,
  ).toBe('openai')
})

test('an auth block is reported rather than imported', async () => {
  const ctx = makeFixture({
    home: {
      '.gemini/settings.json': JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
      }),
    },
  })
  const plan = await geminiAdapter.collect(ctx)
  expect(plan.notImportable.map(item => item.label)).toContain('auth settings')
})
