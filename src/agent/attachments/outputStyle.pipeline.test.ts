import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { getAttachments } from 'src/agent/attachments/attachments.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'

beforeAll(() => {
  setFlagSettingsInline({ outputStyle: 'Explanatory' })
  resetSettingsCache()
})

afterAll(() => {
  setFlagSettingsInline(null)
  resetSettingsCache()
})

function makeContext(agentId?: string): ToolUseContext {
  return {
    agentId,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
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

async function outputStyleAttachments(
  input: string | null,
  context = makeContext(),
): Promise<Attachment[]> {
  const all = await getAttachments(input, context, null, [], [])
  return all.filter(a => a.type === 'output_style')
}

// The system prompt carries the style itself; this one-line reminder only
// restates it, once per prompt. The tool loop re-runs the pipeline after
// every batch of tool results with input === null, and each pass used to add
// another copy to the transcript.
describe('output_style in the attachment pipeline', () => {
  test('rides along with a real user prompt', async () => {
    expect(await outputStyleAttachments('what next?')).toHaveLength(1)
  })

  test('stays off the mid-turn passes (input === null)', async () => {
    expect(await outputStyleAttachments(null)).toEqual([])
  })

  test('never reaches a subagent', async () => {
    expect(
      await outputStyleAttachments('what next?', makeContext('agent_123')),
    ).toEqual([])
  })
})
