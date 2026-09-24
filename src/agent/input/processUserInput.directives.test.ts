import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  processUserInput,
  type ProcessUserInputContext,
} from 'src/agent/input/processUserInput.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'process-input-directives-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeContext(): ProcessUserInputContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      commands: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { commands: [] },
      sessionHooks: new Map(),
    }),
    setAppState: () => {},
    readFileState: new Map(),
    abortController: new AbortController(),
  } as unknown as ProcessUserInputContext
}

async function attachmentTypes(skipInputDirectives: boolean): Promise<string[]> {
  const result = await processUserInput({
    input: `<agent-message from="researcher">\nsee @${dir}\n</agent-message>`,
    mode: 'task-notification',
    setToolJSX: () => {},
    context: makeContext(),
    skipSlashCommands: true,
    skipInputDirectives,
  })
  return result.messages.flatMap(m =>
    m.type === 'attachment' ? [m.attachment.type] : [],
  )
}

// The option travels processUserInput → processUserInputBase (a positional
// parameter list sixteen long) → the attachment pipeline; this pins the whole
// path, not just the pipeline's end of it.
test('an agent-written prompt reaches the model without its @-mentions expanded', async () => {
  expect(await attachmentTypes(false)).toContain('directory')
  expect(await attachmentTypes(true)).not.toContain('directory')
})
