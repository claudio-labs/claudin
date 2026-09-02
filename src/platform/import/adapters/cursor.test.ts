import { expect, test } from 'bun:test'

import { cursorAdapter } from 'src/platform/import/adapters/cursor.js'
import {
  artifactNames,
  artifactsOfKind,
  makeFixture,
} from 'src/platform/import/__testutils__/fixtures.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'

test('MCP servers come from both scopes and keep their own scope', async () => {
  const ctx = makeFixture({
    home: {
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { global: { command: 'g' } },
      }),
    },
    project: {
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { local: { url: 'https://l/mcp', type: 'http' } },
      }),
    },
  })
  const plan = await cursorAdapter.collect(ctx)
  const byName = new Map(
    artifactsOfKind(plan, 'mcpServer').map(s => [s.name, s.scope]),
  )
  expect(byName.get('global')).toBe('user')
  expect(byName.get('local')).toBe('project')
})

test('an auto-attached .mdc rule lands as a scoped rule our loader honours', async () => {
  const ctx = makeFixture({
    project: {
      '.cursor/rules/ts.mdc': [
        '---',
        'description: TS rules',
        'globs: src/**/*.ts',
        'alwaysApply: false',
        '---',
        '',
        'Use zod.',
      ].join('\n'),
    },
  })
  const plan = await cursorAdapter.collect(ctx)
  const rule = artifactsOfKind(plan, 'rule')[0]
  expect(rule?.name).toBe('ts')
  expect(rule?.destination.endsWith('.claudin/rules/ts.md')).toBe(true)

  const inspection = inspectRuleFrontmatter(rule?.markdown ?? '')
  expect(inspection.paths).toEqual(['src/**/*.ts'])
  expect(inspection.unsupportedKeys).toEqual([])
})

test('rule types with no equivalent are warned about, not imported unconditionally', async () => {
  const ctx = makeFixture({
    project: {
      '.cursor/rules/agent.mdc':
        '---\ndescription: Use when reviewing\nalwaysApply: false\n---\n\nBody.',
      '.cursor/rules/notes.md': 'Cursor ignores .md here, and so do we.',
    },
  })
  const plan = await cursorAdapter.collect(ctx)
  expect(artifactNames(plan, 'rule')).toEqual([])
  expect(plan.warnings.join(' ')).toContain('Agent Requested')
  expect(plan.warnings.join(' ')).not.toContain('notes.md')
})

test('Cursor permission lists are counted and pointed at /permissions', async () => {
  const ctx = makeFixture({
    home: {
      '.cursor/cli-config.json': JSON.stringify({
        permissions: { allow: ['Shell(ls)', 'Shell(cat)'], deny: ['Shell(rm)'] },
      }),
    },
  })
  const plan = await cursorAdapter.collect(ctx)
  const entry = plan.notImportable.find(item => item.label === 'permissions')
  expect(entry?.detail).toContain('2 allow, 1 deny')
  expect(entry?.detail).toContain('/permissions')
})
