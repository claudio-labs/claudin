import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getAttachments } from 'src/agent/attachments/attachments.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'input-directives-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeContext(): ToolUseContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [{ agentType: 'helper' }] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { commands: [] },
    }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

function directives(attachments: Attachment[]): string[] {
  return attachments
    .map(a => a.type)
    .filter(type => type === 'directory' || type === 'agent_mention')
    .sort()
}

test('a prompt the user typed expands its @-mentions', async () => {
  const out = await getAttachments(
    `look at @${dir} and ask @agent-helper`,
    makeContext(),
    null,
    [],
  )
  expect(directives(out)).toEqual(['agent_mention', 'directory'])
})

test('text another agent wrote keeps its @-mentions literal', async () => {
  const out = await getAttachments(
    `look at @${dir} and ask @agent-helper`,
    makeContext(),
    null,
    [],
    [],
    undefined,
    { skipInputDirectives: true },
  )
  expect(directives(out)).toEqual([])
})
