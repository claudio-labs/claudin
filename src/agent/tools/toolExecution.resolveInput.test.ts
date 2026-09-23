// Tool.resolveInput, wired through the real tool loop: what every step after
// the zod parse receives, and what reaches the transcript. apply_patch's
// `*** Resubmit` is the one production user; a probe tool keeps this about the
// wiring rather than about patches.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runToolUse } from 'src/agent/tools/toolExecution.js'
import {
  buildTool,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'

/** The input each step received; `permission` is what canUseTool (prompt, classifier, rules) was asked about. */
type Seen = { validate?: unknown; permission?: unknown; call?: unknown }

function probeTool(seen: Seen) {
  return buildTool({
    name: 'RefProbe',
    maxResultSizeChars: 10_000,
    async description() {
      return 'probe'
    },
    async prompt() {
      return 'probe'
    },
    get inputSchema() {
      return z.strictObject({ ref: z.string() })
    },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    resolveInput(input: { ref: string }) {
      if (input.ref === 'KEPT') return { ok: true as const, input: { ref: 'the real thing' } }
      if (input.ref === 'NONE') return { ok: false as const, message: 'nothing was kept' }
      return { ok: true as const, input }
    },
    async validateInput(input: { ref: string }) {
      seen.validate = input
      return { result: true as const }
    },
    async checkPermissions(input: { ref: string }) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
    async call(input: { ref: string }) {
      seen.call = input
      return { data: `ran ${input.ref}` }
    },
    mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
    },
    renderToolUseMessage: () => null,
  })
}

function contextFor(tool: ReturnType<typeof probeTool>): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
    options: {
      tools: [tool],
      mcpClients: [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-opus-5-5',
    },
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function run(ref: string) {
  const seen: Seen = {}
  const tool = probeTool(seen)
  const toolUse = { type: 'tool_use' as const, id: 'toolu_probe', name: 'RefProbe', input: { ref } }
  const assistant = {
    type: 'assistant',
    uuid: 'a-probe',
    message: { id: 'msg_probe', role: 'assistant', content: [toolUse] },
  }
  const allow = (async (_tool: unknown, input: unknown) => {
    seen.permission = input
    return { behavior: 'allow', updatedInput: input }
  }) as never
  const results: unknown[] = []
  for await (const update of runToolUse(toolUse as never, assistant as never, allow, contextFor(tool))) {
    results.push(update)
  }
  return { seen, texts: JSON.stringify(results), toolUse }
}

describe('Tool.resolveInput in the tool loop', () => {
  test('validation, permissions and call() all get the resolved input', async () => {
    const { seen, texts, toolUse } = await run('KEPT')
    expect(seen.validate).toEqual({ ref: 'the real thing' })
    expect(seen.permission).toEqual({ ref: 'the real thing' })
    expect(seen.call).toEqual({ ref: 'the real thing' })
    expect(texts).toContain('ran the real thing')
    // What the model sent is not rewritten: the transcript and the cached prefix keep it.
    expect(toolUse.input).toEqual({ ref: 'KEPT' })
  })

  test('an input with nothing to resolve passes through unchanged', async () => {
    const { seen } = await run('plain')
    expect(seen.call).toEqual({ ref: 'plain' })
  })

  test('a refused resolution is an error result, and nothing after it runs', async () => {
    const { seen, texts } = await run('NONE')
    expect(texts).toContain('nothing was kept')
    expect(texts).toContain('"is_error":true')
    expect(seen).toEqual({})
  })
})
