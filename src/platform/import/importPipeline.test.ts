/**
 * The whole pipeline over one fixture: detect → collect → diff → apply →
 * report, with real files landing on a real (temporary) disk.
 *
 * The unit tests each pin one stage; this is the one that would notice the
 * stages disagreeing — a destination computed one way and written another, or
 * a status that makes apply skip everything.
 */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  applyImportPlan,
  defaultApplyDeps,
  type ApplyDeps,
} from 'src/platform/import/apply.js'
import { collectImportPlan } from 'src/platform/import/collect.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import { markStatuses, type DiffDeps } from 'src/platform/import/diff.js'
import { formatImportReport } from 'src/platform/import/format.js'
import { makeFixture, type Fixture } from 'src/platform/import/__testutils__/fixtures.js'
import { readJson } from 'src/platform/import/writers/files.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'

function fixtureWithFourAgents(): Fixture {
  return makeFixture({
    home: {
      '.claude/settings.json': JSON.stringify({
        theme: 'dark',
        mcpServers: { github: { command: 'npx', args: ['-y', 'g'] } },
      }),
      '.claude/CLAUDE.md': '# Global rules\n',
      '.claude/commands/review.md': 'Review $ARGUMENTS.\n',
      '.codex/config.toml': [
        'model = "gpt-5.4"',
        '[mcp_servers.sentry]',
        'url = "https://mcp.sentry.dev/mcp"',
        'bearer_token_env_var = "SENTRY_TOKEN"',
      ].join('\n'),
      '.codex/prompts/ship.md': 'Ship it.\n',
      '.gemini/settings.json': JSON.stringify({
        mcpServers: { docs: { httpUrl: 'https://docs/mcp' } },
      }),
      '.gemini/commands/git/commit.toml':
        'description = "Commit"\nprompt = "Commit {{args}}."',
    },
    project: {
      '.cursor/rules/ts.mdc':
        '---\ndescription: TS\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse zod.',
    },
  })
}

/**
 * Real file IO; the two config APIs are stood in for, because they write
 * outside the fixture. The stand-ins REMEMBER what they were told, so a second
 * pass sees the same world the real APIs would show it — without that, the
 * idempotency test would only be measuring the stub.
 */
function pipelineDeps(): { apply: ApplyDeps; diff: DiffDeps; mcp: string[] } {
  const mcp: string[] = []
  const servers = new Map<string, Set<string>>()
  const profiles: { baseUrl: string; model: string }[] = []
  return {
    mcp,
    apply: {
      ...defaultApplyDeps,
      addMcpServer: async (name, _config, scope) => {
        mcp.push(`${scope}:${name}`)
        const scoped = servers.get(scope) ?? new Set<string>()
        scoped.add(name)
        servers.set(scope, scoped)
      },
      createProviderProfile: input => {
        profiles.push({ baseUrl: input.baseUrl, model: input.model })
      },
    },
    diff: {
      fileExists: existsSync,
      readFileIfExists: path => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      mcpServerNames: scope => servers.get(scope) ?? new Set<string>(),
      settingsKeys: path => new Set(Object.keys(readJson(path) ?? {})),
      providerProfiles: () => profiles,
    },
  }
}

test('four agents import end to end, and every file lands where the plan said', async () => {
  const ctx = fixtureWithFourAgents()
  const deps = pipelineDeps()

  const detected = detectForeignAgents(ctx)
  expect(detected.map(agent => agent.id).sort()).toEqual([
    'claude',
    'codex',
    'cursor',
    'gemini',
  ])

  const plan = markStatuses(
    await collectImportPlan(
      ctx,
      detected.map(agent => agent.id),
    ),
    ctx,
    deps.diff,
  )
  expect(plan.artifacts.every(artifact => artifact.status === 'new')).toBe(true)

  const report = await applyImportPlan(plan, plan.artifacts, {}, deps.apply)
  expect(report.errors).toEqual([])
  expect(report.skipped).toEqual([])

  expect(deps.mcp.sort()).toEqual(['user:docs', 'user:github', 'user:sentry'])

  // Claude's command crossed over byte for byte; Codex's did too; Gemini's TOML
  // became markdown under the namespace its subdirectory implies.
  const commands = join(ctx.claudinHomeDir, 'commands')
  expect(readFileSync(join(commands, 'review.md'), 'utf8')).toBe(
    'Review $ARGUMENTS.\n',
  )
  expect(readFileSync(join(commands, 'ship.md'), 'utf8')).toBe('Ship it.\n')
  expect(readFileSync(join(commands, 'git', 'commit.md'), 'utf8')).toContain(
    'Commit $ARGUMENTS.',
  )

  expect(readFileSync(join(ctx.claudinHomeDir, 'CLAUDE.md'), 'utf8')).toBe(
    '# Global rules\n',
  )
  expect(
    JSON.parse(readFileSync(join(ctx.claudinHomeDir, 'settings.json'), 'utf8')),
  ).toEqual({ theme: 'dark' })

  // The Cursor rule is scoped by `paths:` and carries no key our loader would
  // reject — the whole point of translating it rather than copying it.
  const rule = readFileSync(
    join(ctx.cwd, '.claudin', 'rules', 'ts.md'),
    'utf8',
  )
  const inspection = inspectRuleFrontmatter(rule)
  expect(inspection.paths).toEqual(['src/**/*.ts'])
  expect(inspection.unsupportedKeys).toEqual([])

  const output = formatImportReport(report, ctx.homeDir)
  expect(output).toContain('3 MCP servers')
  expect(output).toContain('Restart Claudin')
})

test('running the whole pipeline twice writes nothing the second time', async () => {
  const ctx = fixtureWithFourAgents()
  const deps = pipelineDeps()
  const ids = detectForeignAgents(ctx).map(agent => agent.id)

  const first = markStatuses(
    await collectImportPlan(ctx, ids),
    ctx,
    deps.diff,
  )
  await applyImportPlan(first, first.artifacts, {}, deps.apply)

  const second = markStatuses(
    await collectImportPlan(ctx, ids),
    ctx,
    deps.diff,
  )
  const report = await applyImportPlan(second, second.artifacts, {}, deps.apply)

  expect(report.applied).toEqual([])
  expect(report.skipped.length).toBe(second.artifacts.length)
  expect(formatImportReport(report)).toContain('Nothing was imported.')
})

test('a project that already has AGENTS.md keeps it, and the report says which file lost', async () => {
  const ctx = makeFixture({
    home: { '.gemini/settings.json': '{}' },
    project: { 'AGENTS.md': 'mine', 'GEMINI.md': 'theirs' },
  })
  const deps = pipelineDeps()
  const plan = markStatuses(
    await collectImportPlan(ctx, ['gemini']),
    ctx,
    deps.diff,
  )
  const report = await applyImportPlan(plan, plan.artifacts, {}, deps.apply)

  expect(readFileSync(join(ctx.cwd, 'AGENTS.md'), 'utf8')).toBe('mine')
  expect(formatImportReport(report)).toContain('AGENTS.md already exists here')
})
