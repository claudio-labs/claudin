import { describe, expect, test } from 'bun:test'

import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import { deferredToolsHeader } from 'src/tools/ToolSearchTool/prompt.js'

// The deferred_tools_delta renderer takes its header from deferredToolsHeader
// (ToolSearchTool/prompt.ts), which picks it from the persisted lines alone:
// a transcript written before call forms re-renders byte for byte.

function rendered(addedLines: string[]): string {
  const messages = normalizeAttachmentForAPI({
    type: 'deferred_tools_delta',
    addedNames: addedLines.map(l => l.split(' ')[0]!),
    addedLines,
    removedNames: [],
  } as never)
  return JSON.stringify(messages.map(m => m.message.content))
}

describe('deferred_tools_delta header', () => {
  test('plain names render the header deferredToolsHeader gives them', () => {
    const lines = ['TaskList', 'WebFetch']
    expect(rendered(lines)).toContain(JSON.stringify(deferredToolsHeader(lines)).slice(1, -1))
    expect(rendered(lines)).toContain('will fail with InputValidationError')
  })

  test('a line with a call form renders the other header', () => {
    const lines = ['EnterPlanMode — call directly: EnterPlanMode({})', 'WebFetch']
    expect(rendered(lines)).toContain(JSON.stringify(deferredToolsHeader(lines)).slice(1, -1))
    expect(rendered(lines)).not.toContain('will fail with InputValidationError')
  })
})
