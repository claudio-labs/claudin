import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  applyImportPlan,
  defaultApplyDeps,
  type ApplyDeps,
} from 'src/platform/import/apply.js'
import { markStatuses, type DiffDeps } from 'src/platform/import/diff.js'
import { makeFixture } from 'src/platform/import/__testutils__/fixtures.js'
import type {
  ImportArtifact,
  ImportPlan,
} from 'src/platform/import/types.js'

function emptyPlanWith(artifacts: ImportArtifact[]): ImportPlan {
  return { artifacts, notImportable: [], warnings: [] }
}

function recordingDeps(): ApplyDeps & { mcpCalls: string[] } {
  const mcpCalls: string[] = []
  return {
    ...defaultApplyDeps,
    addMcpServer: async (name, _config, scope, replace) => {
      mcpCalls.push(`${scope}:${name}:${replace ? 'replace' : 'add'}`)
    },
    createProviderProfile: () => {},
    mcpCalls,
  }
}

function fileArtifact(destination: string, markdown: string): ImportArtifact {
  return {
    agent: 'codex',
    scope: 'user',
    source: '/src/review.md',
    destination,
    status: 'new',
    kind: 'command',
    name: 'review',
    markdown,
  }
}

test('a new file artifact is written, creating its directory', async () => {
  const ctx = makeFixture()
  const destination = ctx.homePath('.claudin/commands/git/commit.md')
  const report = await applyImportPlan(
    emptyPlanWith([]),
    [fileArtifact(destination, 'Commit it.\n')],
    {},
    recordingDeps(),
  )
  expect(report.applied).toHaveLength(1)
  expect(readFileSync(destination, 'utf8')).toBe('Commit it.\n')
})

test('a conflict is skipped by default and applied when overwrite is asked for', async () => {
  const ctx = makeFixture({ home: { '.claudin/commands/review.md': 'mine' } })
  const destination = ctx.homePath('.claudin/commands/review.md')
  const artifact: ImportArtifact = {
    ...fileArtifact(destination, 'theirs'),
    status: 'conflict',
    statusReason: 'review.md already exists',
  }

  const skipped = await applyImportPlan(
    emptyPlanWith([]),
    [artifact],
    {},
    recordingDeps(),
  )
  expect(skipped.applied).toEqual([])
  expect(skipped.skipped).toHaveLength(1)
  expect(readFileSync(destination, 'utf8')).toBe('mine')

  const overwritten = await applyImportPlan(
    emptyPlanWith([]),
    [artifact],
    { overwriteConflicts: true },
    recordingDeps(),
  )
  expect(overwritten.applied).toHaveLength(1)
  expect(readFileSync(destination, 'utf8')).toBe('theirs')
})

test('an identical artifact is skipped even when overwrite is on', async () => {
  const ctx = makeFixture({ home: { '.claudin/commands/review.md': 'same' } })
  const artifact: ImportArtifact = {
    ...fileArtifact(ctx.homePath('.claudin/commands/review.md'), 'same'),
    status: 'identical',
  }
  const report = await applyImportPlan(
    emptyPlanWith([]),
    [artifact],
    { overwriteConflicts: true },
    recordingDeps(),
  )
  expect(report.applied).toEqual([])
  expect(report.skipped[0]?.statusReason).toBe('already identical')
})

test('applying twice is a no-op the second time', async () => {
  const ctx = makeFixture()
  const destination = ctx.homePath('.claudin/commands/review.md')
  const deps = recordingDeps()
  const diffDeps: DiffDeps = {
    fileExists: existsSync,
    readFileIfExists: path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    mcpServerNames: () => new Set(),
    settingsKeys: () => new Set(),
    providerProfiles: () => [],
  }

  const plan = emptyPlanWith([fileArtifact(destination, 'body\n')])
  const first = markStatuses(plan, ctx, diffDeps)
  expect((await applyImportPlan(first, first.artifacts, {}, deps)).applied).toHaveLength(1)

  const second = markStatuses(plan, ctx, diffDeps)
  const secondReport = await applyImportPlan(second, second.artifacts, {}, deps)
  expect(secondReport.applied).toEqual([])
  expect(secondReport.skipped[0]?.status).toBe('identical')
})

test('a project MCP server is written to the private local scope, not .mcp.json', async () => {
  const deps = recordingDeps()
  const artifact: ImportArtifact = {
    agent: 'cursor',
    scope: 'project',
    source: '/src/.cursor/mcp.json',
    destination: 'project MCP config (private)',
    status: 'new',
    kind: 'mcpServer',
    name: 'local',
    config: { type: 'stdio', command: './s', args: [] },
  }
  await applyImportPlan(emptyPlanWith([]), [artifact], {}, deps)
  expect(deps.mcpCalls).toEqual(['project:local:add'])
})

test('one failing artifact does not abandon the rest', async () => {
  const ctx = makeFixture()
  const good = fileArtifact(ctx.homePath('.claudin/commands/a.md'), 'a\n')
  const bad: ImportArtifact = {
    agent: 'codex',
    scope: 'user',
    source: '/src/x',
    destination: 'user MCP config',
    status: 'new',
    kind: 'mcpServer',
    name: 'boom',
    config: { type: 'stdio', command: 'x', args: [] },
  }
  const deps: ApplyDeps = {
    ...recordingDeps(),
    addMcpServer: async () => {
      throw new Error('blocked by enterprise policy')
    },
  }

  const report = await applyImportPlan(emptyPlanWith([]), [bad, good], {}, deps)
  expect(report.errors).toHaveLength(1)
  expect(report.errors[0]).toContain('enterprise policy')
  expect(report.applied).toHaveLength(1)
  expect(existsSync(join(ctx.claudinHomeDir, 'commands', 'a.md'))).toBe(true)
})

test('a settings key is merged into the existing settings file, not made to replace it', async () => {
  const ctx = makeFixture({
    home: { '.claudin/settings.json': JSON.stringify({ verbose: true }) },
  })
  const artifact: ImportArtifact = {
    agent: 'claude',
    scope: 'user',
    source: '/src/settings.json',
    destination: ctx.homePath('.claudin/settings.json'),
    status: 'new',
    kind: 'settingsKey',
    key: 'theme',
    value: 'dark',
  }
  await applyImportPlan(emptyPlanWith([]), [artifact], {}, recordingDeps())
  expect(
    JSON.parse(readFileSync(ctx.homePath('.claudin/settings.json'), 'utf8')),
  ).toEqual({ verbose: true, theme: 'dark' })
})
