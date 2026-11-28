// The mcp_resource_changed producer's place in getAttachments: a thread gets
// the notices queued for it (src/mcp/resourceChanges.ts), once, and an agent
// that strips re-injected context gets none.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAttachments } from 'src/agent/attachments/attachments.js'
import { getMcpResourceChanges, MAIN_THREAD } from 'src/mcp/resourceChanges.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const README = { server: 'docs', uri: 'docs://readme' }

function makeContext(extra: Record<string, unknown> = {}): ToolUseContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({ toolPermissionContext: {}, mcp: { commands: [] } }),
    setAppState: () => {},
    readFileState: new Map(),
    ...extra,
  } as unknown as ToolUseContext
}

async function changedOf(context: ToolUseContext) {
  const out = await getAttachments(null, context, null, [])
  return out.filter(a => a.type === 'mcp_resource_changed')
}

describe('getAttachments — mcp_resource_changed', () => {
  beforeEach(() => {
    delete process.env.CLAUDIN_DISABLE_ATTACHMENTS
    delete process.env.CLAUDIN_SIMPLE
  })

  afterEach(() => {
    getMcpResourceChanges().clear()
  })

  test('the main thread gets its notice once', async () => {
    getMcpResourceChanges().noteRead(MAIN_THREAD, README)
    getMcpResourceChanges().record(README)
    expect(await changedOf(makeContext())).toEqual([{ type: 'mcp_resource_changed', changes: [README] }])
    expect(await changedOf(makeContext())).toEqual([])
  })

  test('a sub-agent gets what it read, mid-loop too; a slim agent gets nothing', async () => {
    getMcpResourceChanges().noteRead('agent-reader', README)
    getMcpResourceChanges().record(README)
    expect(await changedOf(makeContext({ agentId: 'agent-other' }))).toEqual([])
    expect(await changedOf(makeContext({ agentId: 'agent-reader' }))).toEqual([
      { type: 'mcp_resource_changed', changes: [README] },
    ])
    getMcpResourceChanges().record(README)
    expect(await changedOf(makeContext({ agentId: 'agent-reader', omitClaudeMdAttachments: true }))).toEqual([])
  })
})
