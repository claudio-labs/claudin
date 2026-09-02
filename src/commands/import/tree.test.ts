import { expect, test } from 'bun:test'

import {
  agentRowKey,
  buildAgentEntries,
  buildTreeRows,
  cascadeSelection,
  countConflicts,
  defaultSelection,
  groupRowKey,
  selectedArtifacts,
  type AgentEntry,
} from 'src/commands/import/tree.js'
import type {
  DetectedAgent,
  ImportArtifact,
  ImportPlan,
} from 'src/platform/import/types.js'

function mcp(
  agent: ImportArtifact['agent'],
  name: string,
  status: ImportArtifact['status'] = 'new',
): ImportArtifact {
  return {
    agent,
    scope: 'user',
    source: '/src/config',
    destination: 'user MCP config',
    status,
    kind: 'mcpServer',
    name,
    config: { type: 'stdio', command: 'x', args: [] },
  }
}

function hint(agent: ImportArtifact['agent']): ImportArtifact {
  return {
    agent,
    scope: 'user',
    source: '/src/config',
    destination: '/dst/config.json',
    status: 'new',
    kind: 'providerHint',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
  }
}

function detected(id: ImportArtifact['agent'], label: string): DetectedAgent {
  return { id, label, roots: [{ path: `/home/u/.${id}`, scope: 'user' }] }
}

function planOf(artifacts: ImportArtifact[]): ImportPlan {
  return { artifacts, notImportable: [], warnings: [] }
}

function entries(): AgentEntry[] {
  return buildAgentEntries(
    [detected('claude', 'Claude Code'), detected('codex', 'OpenAI Codex')],
    planOf([mcp('claude', 'github'), hint('claude'), mcp('codex', 'sentry')]),
    '/home/u',
  )
}

test('an agent with nothing importable is dropped from the tree entirely', () => {
  const built = buildAgentEntries(
    [detected('claude', 'Claude Code'), detected('cursor', 'Cursor')],
    planOf([mcp('claude', 'github')]),
  )
  expect(built.map(entry => entry.id)).toEqual(['claude'])
})

test('rows are an agent followed by its indented groups', () => {
  const rows = buildTreeRows(entries(), new Set())
  expect(rows.map(row => row.key)).toEqual([
    'agent:claude',
    'claude:mcpServer:user',
    'claude:providerHint:user',
    'agent:codex',
    'codex:mcpServer:user',
  ])
  expect(rows[0]?.label).toBe('▸ Claude Code')
  expect(rows[1]?.label.startsWith('      ')).toBe(true)
})

test('the tree uses no glyph that renders as tofu here', () => {
  const labels = buildTreeRows(entries(), new Set())
    .map(row => row.label)
    .join('')
  expect(labels).not.toContain('▾')
  expect(labels).not.toContain('▼')
})

test('provider config starts unchecked, MCP servers start checked', () => {
  const selected = new Set(defaultSelection(entries()))
  expect(selected.has(groupRowKey('claude', 'mcpServer:user'))).toBe(true)
  expect(selected.has(groupRowKey('claude', 'providerHint:user'))).toBe(false)
  expect(selected.has(agentRowKey('claude'))).toBe(true)
})

test('a group with nothing left to do starts unchecked', () => {
  const built = buildAgentEntries(
    [detected('claude', 'Claude Code')],
    planOf([mcp('claude', 'github', 'identical')]),
  )
  expect(defaultSelection(built)).toEqual([])
})

test('a partially selected agent says so in its label', () => {
  const built = entries()
  const rows = buildTreeRows(
    built,
    new Set([groupRowKey('claude', 'mcpServer:user')]),
  )
  expect(rows[0]?.label).toBe('▸ Claude Code (1/2)')
})

test('checking an agent row selects all of its groups', () => {
  const built = entries()
  const next = cascadeSelection(built, [], [agentRowKey('claude')])
  expect(new Set(next)).toEqual(
    new Set([
      agentRowKey('claude'),
      groupRowKey('claude', 'mcpServer:user'),
      groupRowKey('claude', 'providerHint:user'),
    ]),
  )
})

test('unchecking an agent row clears all of its groups', () => {
  const built = entries()
  const all = cascadeSelection(built, [], [agentRowKey('claude')])
  const cleared = cascadeSelection(
    built,
    all,
    all.filter(key => key !== agentRowKey('claude')),
  )
  expect(cleared.filter(key => key.startsWith('claude'))).toEqual([])
})

test('unchecking the last child also unchecks its parent', () => {
  const built = entries()
  const previous = [
    agentRowKey('claude'),
    groupRowKey('claude', 'mcpServer:user'),
  ]
  const next = cascadeSelection(
    built,
    previous,
    previous.filter(key => key !== groupRowKey('claude', 'mcpServer:user')),
  )
  expect(next).not.toContain(agentRowKey('claude'))
})

test('checking a lone child checks its parent, without touching its siblings', () => {
  const built = entries()
  const next = cascadeSelection(
    built,
    [],
    [groupRowKey('claude', 'providerHint:user')],
  )
  expect(new Set(next)).toEqual(
    new Set([agentRowKey('claude'), groupRowKey('claude', 'providerHint:user')]),
  )
})

test('one agent cascading does not disturb the other', () => {
  const built = entries()
  const previous = cascadeSelection(built, [], [agentRowKey('codex')])
  const next = cascadeSelection(built, previous, [
    ...previous,
    agentRowKey('claude'),
  ])
  expect(next).toContain(groupRowKey('codex', 'mcpServer:user'))
  expect(next).toContain(groupRowKey('claude', 'mcpServer:user'))
})

test('only the checked groups contribute artifacts', () => {
  const built = entries()
  const artifacts = selectedArtifacts(
    built,
    new Set([groupRowKey('codex', 'mcpServer:user')]),
  )
  expect(artifacts.map(artifact => artifact.agent)).toEqual(['codex'])
})

test('conflicts are counted so the confirmation step knows whether to appear', () => {
  expect(countConflicts([mcp('claude', 'a'), mcp('claude', 'b', 'conflict')])).toBe(
    1,
  )
})
