import { expect, test } from 'bun:test'

import { markStatuses, type DiffDeps } from 'src/platform/import/diff.js'
import { makeFixture } from 'src/platform/import/__testutils__/fixtures.js'
import type {
  ImportArtifact,
  ImportPlan,
} from 'src/platform/import/types.js'

function makeDeps(overrides: Partial<DiffDeps> = {}): DiffDeps {
  return {
    fileExists: () => false,
    readFileIfExists: () => null,
    mcpServerNames: () => new Set(),
    settingsKeys: () => new Set(),
    providerProfiles: () => [],
    ...overrides,
  }
}

function planOf(artifacts: ImportArtifact[]): ImportPlan {
  return { artifacts, notImportable: [], warnings: [] }
}

const commandArtifact: ImportArtifact = {
  agent: 'codex',
  scope: 'user',
  source: '/src/review.md',
  destination: '/dst/commands/review.md',
  status: 'new',
  kind: 'command',
  name: 'review',
  markdown: 'Review it.\n',
}

test('a destination that does not exist stays new', () => {
  const [marked] = markStatuses(
    planOf([commandArtifact]),
    makeFixture(),
    makeDeps(),
  ).artifacts
  expect(marked?.status).toBe('new')
})

test('identical bytes are identical, not a conflict', () => {
  const [marked] = markStatuses(
    planOf([commandArtifact]),
    makeFixture(),
    makeDeps({
      fileExists: () => true,
      readFileIfExists: () => 'Review it.\n',
    }),
  ).artifacts
  expect(marked?.status).toBe('identical')
})

test('different bytes at the destination are a conflict naming the file', () => {
  const [marked] = markStatuses(
    planOf([commandArtifact]),
    makeFixture(),
    makeDeps({ fileExists: () => true, readFileIfExists: () => 'mine' }),
  ).artifacts
  expect(marked?.status).toBe('conflict')
  expect(marked?.statusReason).toContain('review.md')
})

test('an MCP server name already in the target scope conflicts', () => {
  const artifact: ImportArtifact = {
    agent: 'codex',
    scope: 'user',
    source: '/src/config.toml',
    destination: 'user MCP config',
    status: 'new',
    kind: 'mcpServer',
    name: 'github',
    config: { type: 'stdio', command: 'npx', args: [] },
  }
  const deps = makeDeps({
    mcpServerNames: scope => (scope === 'user' ? new Set(['github']) : new Set()),
  })
  expect(
    markStatuses(planOf([artifact]), makeFixture(), deps).artifacts[0]?.status,
  ).toBe('conflict')
  expect(
    markStatuses(
      planOf([{ ...artifact, scope: 'project' }]),
      makeFixture(),
      deps,
    ).artifacts[0]?.status,
  ).toBe('new')
})

test('project instructions conflict on CLAUDE.md too, not only on AGENTS.md', () => {
  const ctx = makeFixture()
  const artifact: ImportArtifact = {
    agent: 'gemini',
    scope: 'project',
    source: '/src/GEMINI.md',
    destination: ctx.projectPath('AGENTS.md'),
    status: 'new',
    kind: 'instructions',
    text: 'rules',
  }
  const marked = markStatuses(
    planOf([artifact]),
    ctx,
    makeDeps({
      fileExists: path => path === ctx.projectPath('CLAUDE.md'),
      readFileIfExists: () => 'something else',
    }),
  ).artifacts[0]
  expect(marked?.status).toBe('conflict')
  expect(marked?.statusReason).toContain('CLAUDE.md')
})

test('a settings key already set conflicts, an unset one does not', () => {
  const artifact: ImportArtifact = {
    agent: 'claude',
    scope: 'user',
    source: '/src/settings.json',
    destination: '/dst/settings.json',
    status: 'new',
    kind: 'settingsKey',
    key: 'theme',
    value: 'dark',
  }
  const deps = makeDeps({ settingsKeys: () => new Set(['theme']) })
  expect(
    markStatuses(planOf([artifact]), makeFixture(), deps).artifacts[0]?.status,
  ).toBe('conflict')
  expect(
    markStatuses(
      planOf([{ ...artifact, key: 'verbose' }]),
      makeFixture(),
      deps,
    ).artifacts[0]?.status,
  ).toBe('new')
})

test('a provider profile that already exists makes the hint identical, not a conflict', () => {
  const artifact: ImportArtifact = {
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
  }
  const marked = markStatuses(
    planOf([artifact]),
    makeFixture(),
    makeDeps({
      providerProfiles: () => [
        { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
      ],
    }),
  ).artifacts[0]
  expect(marked?.status).toBe('identical')
})

test('a collision already resolved between agents keeps its reason', () => {
  const artifact: ImportArtifact = {
    ...commandArtifact,
    status: 'conflict',
    statusReason: 'also provided by Claude Code, which was selected first',
  }
  const marked = markStatuses(
    planOf([artifact]),
    makeFixture(),
    makeDeps({ fileExists: () => true, readFileIfExists: () => 'other' }),
  ).artifacts[0]
  expect(marked?.statusReason).toContain('selected first')
})
