// Characterization of the tool loop's less-travelled paths, driven through the
// real runToolUse with probe tools (the harness of toolExecution.advise.test.ts):
// a call that never reaches its tool, a permission verdict that carries more
// than allow/deny, and a result that carries more than its data. Pins what
// toolExecution.ts does today; scripts/migrations/probes/coverToolExecution.json
// breaks one line per group and proves each one goes red.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  buildSchemaNotSentHint,
  classifyToolError,
  runToolUse,
  type MessageUpdateLazy,
} from 'src/agent/tools/toolExecution.js'
import { McpAuthError } from 'src/mcp/client.js'
import { CANCEL_MESSAGE } from 'src/agent/messages/constants.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import { buildTool, getEmptyToolPermissionContext, type Tool, type ToolUseContext } from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'

type Def = Record<string, unknown>

/** A tool with every required member; `def` overrides any of them. */
function makeTool(name: string, def: Def = {}): Tool {
  return buildTool({
    name,
    maxResultSizeChars: 10_000,
    async description() {
      return 'probe'
    },
    async prompt() {
      return 'probe'
    },
    get inputSchema() {
      return z.strictObject({ mode: z.string() })
    },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions(input: unknown) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
    async call(input: { mode: string }) {
      return { data: `ran ${input.mode}` }
    },
    mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
    },
    renderToolUseMessage: () => null,
    ...def,
  } as Parameters<typeof buildTool>[0]) as unknown as Tool
}

const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never

type RunOptions = {
  tools?: unknown[]
  messages?: unknown[]
  canUseTool?: never
  mcpClients?: unknown[]
  setAppState?: (f: (prev: never) => unknown) => void
  aborted?: boolean
}

function contextFor(options: RunOptions & { tools: unknown[] }): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  const abortController = new AbortController()
  if (options.aborted) abortController.abort()
  return {
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: options.messages ?? [],
    options: {
      tools: options.tools,
      mcpClients: options.mcpClients ?? [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-opus-5-5',
    },
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
    setAppState: options.setAppState ?? (() => {}),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

const TOOL_USE_ID = 'toolu_cov'

/** Every update runToolUse yields for one call of `name` with `input`. */
async function run(name: string, input: unknown, options: RunOptions = {}): Promise<MessageUpdateLazy[]> {
  const toolUse = { type: 'tool_use' as const, id: TOOL_USE_ID, name, input }
  const assistant = {
    type: 'assistant',
    uuid: 'a-cov',
    message: { id: 'msg_cov', role: 'assistant', content: [toolUse] },
  }
  const context = contextFor({ ...options, tools: options.tools ?? [] })
  const updates: MessageUpdateLazy[] = []
  for await (const update of runToolUse(toolUse as never, assistant as never, options.canUseTool ?? allow, context)) {
    updates.push(update)
  }
  return updates
}

type Block = { type: string; [key: string]: unknown }
type UserRecord = {
  type: 'user'
  message: { content: string | Block[] }
  toolUseResult?: unknown
  imagePasteIds?: number[]
}

/** The user message holding the tool_result. */
function resultMessage(updates: MessageUpdateLazy[]): UserRecord {
  for (const { message } of updates) {
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (message.type === 'user' && Array.isArray(content) && content.some((b: Block) => b.type === 'tool_result')) {
      return message as unknown as UserRecord
    }
  }
  throw new Error('no tool_result message')
}

function toolResultBlock(updates: MessageUpdateLazy[]): Block & { content: unknown; is_error?: boolean } {
  const content = resultMessage(updates).message.content as Block[]
  return content.find(b => b.type === 'tool_result') as Block & { content: unknown; is_error?: boolean }
}

function attachments(updates: MessageUpdateLazy[]): Record<string, unknown>[] {
  return updates
    .map(u => u.message)
    .filter(m => m.type === 'attachment')
    .map(m => (m as unknown as { attachment: Record<string, unknown> }).attachment)
}

// ---------------------------------------------------------------------------

describe('classifyToolError', () => {
  test('a telemetry-safe error reports its vetted message, capped at 200', () => {
    const vetted = new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS('/home/x/secret.ts', 'x'.repeat(300))
    expect(classifyToolError(vetted)).toBe('x'.repeat(200))
  })

  test('a filesystem error reports its errno code', () => {
    const enoent = Object.assign(new Error('ENOENT: no such file, open /a/b'), { code: 'ENOENT' })
    expect(classifyToolError(enoent)).toBe('Error:ENOENT')
  })

  test('a named error reports its name; a short or default name does not', () => {
    class ImageSizeError extends Error {
      override name = 'ImageSizeError'
    }
    class Nj extends Error {
      override name = 'nJT'
    }
    expect(classifyToolError(new ImageSizeError('too big'))).toBe('ImageSizeError')
    // A three-character name is what a minifier leaves behind.
    expect(classifyToolError(new Nj('mangled'))).toBe('Error')
    expect(classifyToolError(new Error('plain'))).toBe('Error')
  })

  test('a thrown non-error is UnknownError', () => {
    expect(classifyToolError('a string')).toBe('UnknownError')
    expect(classifyToolError(undefined)).toBe('UnknownError')
  })
})

// ---------------------------------------------------------------------------

describe('a call that never reaches its tool', () => {
  test('an unknown tool name is answered with an error result', async () => {
    const updates = await run('NoSuchProbe', { mode: 'x' })
    const block = toolResultBlock(updates)
    expect(block.is_error).toBe(true)
    expect(block.tool_use_id).toBe(TOOL_USE_ID)
    expect(block.content).toBe('<tool_use_error>Error: No such tool available: NoSuchProbe</tool_use_error>')
    expect(resultMessage(updates).toolUseResult).toBe('Error: No such tool available: NoSuchProbe')
  })

  test('a deprecated alias reaches the base tool that took it over', async () => {
    // KillShell is TaskStop's old name: the call resolves to TaskStop even
    // though the session's tool list does not hold it, and fails TaskStop's
    // own validation instead of reporting an unknown tool.
    const updates = await run('KillShell', { bogus: 1 })
    const block = toolResultBlock(updates)
    expect(String(block.content)).not.toContain('No such tool available')
    expect(String(block.content)).toContain('InputValidationError')
  })

  test("a base tool's primary name is not a fallback", async () => {
    // Only an alias falls back: a tool the session left out stays out.
    const updates = await run('TaskStop', { task_id: 'x' })
    expect(toolResultBlock(updates).content).toBe('<tool_use_error>Error: No such tool available: TaskStop</tool_use_error>')
  })

  test('an aborted turn cancels the call before it runs', async () => {
    let ran = 0
    const tool = makeTool('CancelProbe', {
      async call() {
        ran++
        return { data: 'ran' }
      },
    })
    const updates = await run('CancelProbe', { mode: 'x' }, { tools: [tool], aborted: true })
    expect(ran).toBe(0)
    expect(resultMessage(updates).toolUseResult).toBe(CANCEL_MESSAGE)
  })

  test('validateInput rejecting the call answers with its message, and the tool never runs', async () => {
    let ran = 0
    const tool = makeTool('ValidateProbe', {
      async validateInput(input: { mode: string }) {
        return input.mode === 'bad'
          ? { result: false as const, message: 'mode bad is not allowed', errorCode: 1 }
          : { result: true as const }
      },
      async call() {
        ran++
        return { data: 'ran' }
      },
    })
    const updates = await run('ValidateProbe', { mode: 'bad' }, { tools: [tool] })
    const block = toolResultBlock(updates)
    expect(ran).toBe(0)
    expect(block.is_error).toBe(true)
    expect(block.content).toBe('<tool_use_error>mode bad is not allowed</tool_use_error>')
    expect(resultMessage(updates).toolUseResult).toBe('Error: mode bad is not allowed')
    // The same tool with a valid input runs.
    expect(toolResultBlock(await run('ValidateProbe', { mode: 'ok' }, { tools: [tool] })).content).toBe('ran')
  })
})

// ---------------------------------------------------------------------------

describe('the schema-not-sent hint', () => {
  const savedToolSearch = process.env.ENABLE_TOOL_SEARCH
  afterEach(() => {
    if (savedToolSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = savedToolSearch
  })

  const deferred = makeTool('DeferredProbe', { shouldDefer: true })
  const toolSearch = makeTool('ToolSearch')
  const loaded = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: [{ type: 'tool_reference', tool_name: 'DeferredProbe' }],
        },
      ],
    },
  }

  test('names the ToolSearch call for a deferred tool not loaded yet, and nothing once it is', () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const hint = buildSchemaNotSentHint(deferred, [], [deferred, toolSearch])
    expect(hint).toContain("This tool's schema was not sent to the API")
    expect(hint).toContain('call ToolSearch with query "select:DeferredProbe", then retry this call.')
    expect(buildSchemaNotSentHint(deferred, [loaded] as never, [deferred, toolSearch])).toBeNull()
  })

  test('a deferred tool that fails its schema unloaded gets the hint on the error', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const updates = await run('DeferredProbe', { mode: 7 }, { tools: [deferred, toolSearch] })
    const content = String(toolResultBlock(updates).content)
    expect(content).toStartWith('<tool_use_error>InputValidationError: ')
    expect(content).toContain('"select:DeferredProbe"')
    // Loaded, the same bad input gets the plain validation error.
    const plain = await run('DeferredProbe', { mode: 7 }, { tools: [deferred, toolSearch], messages: [loaded] })
    expect(String(toolResultBlock(plain).content)).not.toContain('select:DeferredProbe')
  })
})

// ---------------------------------------------------------------------------

describe("runToolUse's outer catch", () => {
  const input = { mode: 'x' }
  const throwing = (error: unknown) =>
    (async () => {
      throw error
    }) as never

  /** Two earlier identical failures of CatchProbe: the next one completes a streak of three. */
  function priorFailures(): unknown[] {
    const out: unknown[] = [{ type: 'user', uuid: 'h', isMeta: false, message: { role: 'user', content: 'go' } }]
    for (let i = 0; i < 2; i++) {
      out.push({
        type: 'assistant',
        uuid: `a${i}`,
        message: { role: 'assistant', id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'CatchProbe', input }] },
      })
      out.push({
        type: 'user',
        uuid: `u${i}`,
        isMeta: false,
        toolUseResult: 'Error: boom',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true, content: 'boom' }] },
      })
    }
    return out
  }

  test('a throwing permission check becomes an error result naming the tool', async () => {
    const tool = makeTool('CatchProbe')
    const updates = await run('CatchProbe', input, { tools: [tool], canUseTool: throwing(new Error('permission exploded')) })
    const block = toolResultBlock(updates)
    expect(block.is_error).toBe(true)
    expect(block.content).toBe('<tool_use_error>Error calling tool (CatchProbe): permission exploded</tool_use_error>')
    expect(resultMessage(updates).toolUseResult).toBe('Error calling tool (CatchProbe): permission exploded')
  })

  test('the third identical failure carries the repeated-failure hint; an abort never does', async () => {
    const tool = makeTool('CatchProbe')
    const failed = await run('CatchProbe', input, {
      tools: [tool],
      messages: priorFailures(),
      canUseTool: throwing(new Error('permission exploded')),
    })
    expect(String(toolResultBlock(failed).content)).toContain('failed 3 times in a row')

    // A raw DOMException is what an AbortSignal throws: not our AbortError
    // class, and still the user's interrupt.
    const aborted = await run('CatchProbe', input, {
      tools: [tool],
      messages: priorFailures(),
      canUseTool: throwing(new DOMException('The operation was aborted.', 'AbortError')),
    })
    const content = String(toolResultBlock(aborted).content)
    expect(content).toContain('Error calling tool (CatchProbe)')
    expect(content).not.toContain('failed 3 times in a row')
  })
})

// ---------------------------------------------------------------------------

describe('the input between the parse and the call', () => {
  test("Bash drops a model-supplied _simulatedSedEdit before anything sees it", async () => {
    const seen: { permission?: unknown; call?: unknown } = {}
    const bash = makeTool('Bash', {
      get inputSchema() {
        return z.strictObject({ command: z.string(), _simulatedSedEdit: z.unknown().optional() })
      },
      async call(input: unknown) {
        seen.call = input
        return { data: 'ran' }
      },
    })
    const canUseTool = (async (_tool: unknown, input: unknown) => {
      seen.permission = input
      return { behavior: 'allow', updatedInput: input }
    }) as never
    await run('Bash', { command: 'echo hi', _simulatedSedEdit: { filePath: '/etc/passwd', newContent: 'x' } }, {
      tools: [bash],
      canUseTool,
    })
    expect(seen.permission).toEqual({ command: 'echo hi' })
    expect(seen.call).toEqual({ command: 'echo hi' })
  })

  describe('backfillObservableInput', () => {
    function backfillTool(seen: { permission?: unknown; call?: unknown }) {
      return makeTool('BackfillProbe', {
        get inputSchema() {
          return z.strictObject({ file_path: z.string(), note: z.string().optional() })
        },
        backfillObservableInput(input: Record<string, unknown>) {
          input.file_path = `/abs/${String(input.file_path)}`
        },
        async call(input: unknown) {
          seen.call = input
          return { data: 'ran' }
        },
      })
    }

    test('permission sees the backfilled input; the call keeps what the model sent', async () => {
      const seen: { permission?: unknown; call?: unknown } = {}
      const canUseTool = (async (_tool: unknown, input: unknown) => {
        seen.permission = input
        return { behavior: 'allow', updatedInput: input }
      }) as never
      await run('BackfillProbe', { file_path: 'a.ts' }, { tools: [backfillTool(seen)], canUseTool })
      expect(seen.permission).toEqual({ file_path: '/abs/a.ts' })
      expect(seen.call).toEqual({ file_path: 'a.ts' })
    })

    test('a fresh updatedInput keeps its changes, and the model\'s path when the path is the backfilled one', async () => {
      const seen: { permission?: unknown; call?: unknown } = {}
      const rewrite = (async (_tool: unknown, input: Record<string, unknown>) => ({
        behavior: 'allow',
        updatedInput: { ...input, note: 'added by permission' },
      })) as never
      await run('BackfillProbe', { file_path: 'a.ts' }, { tools: [backfillTool(seen)], canUseTool: rewrite })
      expect(seen.call).toEqual({ file_path: 'a.ts', note: 'added by permission' })

      // A path the permission changed is the path that runs.
      const moved = (async () => ({ behavior: 'allow', updatedInput: { file_path: '/elsewhere/b.ts' } })) as never
      await run('BackfillProbe', { file_path: 'a.ts' }, { tools: [backfillTool(seen)], canUseTool: moved })
      expect(seen.call).toEqual({ file_path: '/elsewhere/b.ts' })
    })
  })

  test('a tool split into hook units derives them again from the input that failed', async () => {
    let derived = 0
    const units = (input: { mode: string }) => {
      derived++
      return {
        inputs: [{ mode: input.mode }],
        label: () => input.mode,
        merge: () => ({ input }),
      }
    }
    const tool = makeTool('UnitsProbe', {
      hookUnits: units,
      async call(input: { mode: string }) {
        if (input.mode === 'throw') throw new Error('unit failed')
        return { data: `ran ${input.mode}`, unitResults: [{ input, output: 'ok' }] }
      },
    })
    expect(toolResultBlock(await run('UnitsProbe', { mode: 'ok' }, { tools: [tool] })).content).toBe('ran ok')
    expect(derived).toBe(1)
    derived = 0
    const failed = toolResultBlock(await run('UnitsProbe', { mode: 'throw' }, { tools: [tool] }))
    expect(String(failed.content)).toContain('unit failed')
    expect(derived).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('a permission verdict that carries more than allow or deny', () => {
  const PERMISSION_REQUEST = { type: 'hook' as const, hookName: 'PermissionRequest' }

  test('a PermissionRequest hook verdict is recorded as an attachment, allow or deny', async () => {
    const tool = makeTool('VerdictProbe')
    const allowed = await run('VerdictProbe', { mode: 'x' }, {
      tools: [tool],
      canUseTool: (async (_t: unknown, input: unknown) => ({
        behavior: 'allow',
        updatedInput: input,
        decisionReason: PERMISSION_REQUEST,
      })) as never,
    })
    expect(attachments(allowed)).toContainEqual({
      type: 'hook_permission_decision',
      decision: 'allow',
      toolUseID: TOOL_USE_ID,
      hookEvent: 'PermissionRequest',
    })

    const denied = await run('VerdictProbe', { mode: 'x' }, {
      tools: [tool],
      canUseTool: (async () => ({ behavior: 'deny', message: 'hook said no', decisionReason: PERMISSION_REQUEST })) as never,
    })
    expect(attachments(denied)).toContainEqual(expect.objectContaining({ type: 'hook_permission_decision', decision: 'deny' }))
    expect(toolResultBlock(denied).content).toBe('hook said no')

    // A rule's verdict records nothing.
    const byRule = await run('VerdictProbe', { mode: 'x' }, {
      tools: [tool],
      canUseTool: (async (_t: unknown, input: unknown) => ({
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'default' },
      })) as never,
    })
    expect(attachments(byRule).filter(a => a.type === 'hook_permission_decision')).toEqual([])
  })

  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  /** A transcript whose pasted images already took ids 7 and 3. */
  const pasted = [{ type: 'user', uuid: 'p', imagePasteIds: [7, 3], message: { role: 'user', content: 'see' } }]

  test("a rejection's pasted images ride beside the error, numbered after the transcript's", async () => {
    const tool = makeTool('RejectProbe')
    const updates = await run('RejectProbe', { mode: 'x' }, {
      tools: [tool],
      messages: pasted,
      canUseTool: (async () => ({
        behavior: 'ask',
        message: 'rejected, see the screenshot',
        contentBlocks: [image, { type: 'text', text: 'look' }, image],
      })) as never,
    })
    const message = resultMessage(updates)
    const content = message.message.content as Block[]
    expect(content.map(b => b.type)).toEqual(['tool_result', 'image', 'text', 'image'])
    expect(content[0]).toMatchObject({ is_error: true, content: 'rejected, see the screenshot' })
    expect(message.imagePasteIds).toEqual([8, 9])
  })

  test("an approval's feedback and pasted images follow the result", async () => {
    const tool = makeTool('ApproveProbe')
    const updates = await run('ApproveProbe', { mode: 'x' }, {
      tools: [tool],
      messages: pasted,
      canUseTool: (async (_t: unknown, input: unknown) => ({
        behavior: 'allow',
        updatedInput: input,
        acceptFeedback: 'go ahead, but be careful',
        contentBlocks: [image],
      })) as never,
    })
    const message = resultMessage(updates)
    const content = message.message.content as Block[]
    expect(content.map(b => b.type)).toEqual(['tool_result', 'text', 'image'])
    expect(content[0]).toMatchObject({ content: 'ran x' })
    expect(content[1]).toEqual({ type: 'text', text: 'go ahead, but be careful' })
    expect(message.imagePasteIds).toEqual([8])
  })
})

// ---------------------------------------------------------------------------

describe('a result that carries more than its data', () => {
  test('progress, structured output, new messages and a context modifier all reach the caller', async () => {
    const extra = { type: 'user', uuid: 'extra', message: { role: 'user', content: 'from the tool' } }
    const modify = (context: ToolUseContext) => context
    const tool = makeTool('RichProbe', {
      async call(
        input: { mode: string },
        _context: unknown,
        _canUseTool: unknown,
        _assistant: unknown,
        onProgress: (p: { toolUseID: string; data: unknown }) => void,
      ) {
        onProgress({ toolUseID: 'inner_progress', data: { type: 'probe_progress', step: 1 } })
        return {
          data: `ran ${input.mode}`,
          structured_output: { answer: 42 },
          newMessages: [extra],
          contextModifier: modify,
        }
      },
    })
    const updates = await run('RichProbe', { mode: 'x' }, { tools: [tool] })

    const progress = updates.find(u => u.message.type === 'progress')?.message as unknown as Record<string, unknown>
    expect(progress).toMatchObject({
      toolUseID: 'inner_progress',
      parentToolUseID: TOOL_USE_ID,
      data: { type: 'probe_progress', step: 1 },
    })
    expect(attachments(updates)).toContainEqual({ type: 'structured_output', data: { answer: 42 } })
    expect(updates.map(u => u.message as unknown)).toContainEqual(extra)
    const withModifier = updates.find(u => u.contextModifier)
    expect(withModifier?.contextModifier).toEqual({ toolUseID: TOOL_USE_ID, modifyContext: modify })
    expect(withModifier?.message).toBe(resultMessage(updates) as never)
  })

  test("advice on a result whose content is blocks becomes one more text block", async () => {
    const tool = makeTool('BlocksProbe', {
      advise: () => ({ message: 'BlocksProbe has a better tool for this.' }),
      mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
        return { type: 'tool_result' as const, tool_use_id: toolUseID, content: [{ type: 'text' as const, text: data }] }
      },
    })
    const content = toolResultBlock(await run('BlocksProbe', { mode: 'x' }, { tools: [tool] })).content
    expect(content).toEqual([
      { type: 'text', text: 'ran x' },
      { type: 'text', text: '<system-reminder>\nBlocksProbe has a better tool for this.\n</system-reminder>' },
    ])
  })
})

// ---------------------------------------------------------------------------

describe('an MCP tool', () => {
  const config = { type: 'http', url: 'https://mcp.example.com/v1?token=secret' }
  const connected = { name: 'my server', type: 'connected', config }

  test('its result is added after the PostToolUse hooks, once', async () => {
    const tool = makeTool('mcp__my_server__echo', { isMcp: true })
    const updates = await run('mcp__my_server__echo', { mode: 'x' }, { tools: [tool], mcpClients: [connected] })
    const results = updates.filter(u => {
      const content = (u.message as { message?: { content?: unknown } }).message?.content
      return Array.isArray(content) && content.some((b: Block) => b.type === 'tool_result')
    })
    expect(results).toHaveLength(1)
    expect(toolResultBlock(updates).content).toBe('ran x')
  })

  test('an auth failure marks its connected server as needing auth, and nothing else', async () => {
    const tool = makeTool('mcp__my_server__echo', {
      isMcp: true,
      async call() {
        throw new McpAuthError('my server', 'token expired')
      },
    })
    const updaters: ((prev: never) => unknown)[] = []
    const updates = await run('mcp__my_server__echo', { mode: 'x' }, {
      tools: [tool],
      mcpClients: [connected],
      setAppState: f => updaters.push(f),
    })
    expect(toolResultBlock(updates).is_error).toBe(true)
    expect(String(toolResultBlock(updates).content)).toContain('token expired')
    expect(updaters).toHaveLength(1)
    const update = updaters[0]!

    const other = { name: 'other', type: 'connected', config }
    const state = { mcp: { clients: [other, connected], tools: [] } }
    expect(update(state as never)).toEqual({
      mcp: { clients: [other, { name: 'my server', type: 'needs-auth', config }], tools: [] },
    })
    // A server that is not connected, or not there, is left as it is.
    const pending = { mcp: { clients: [{ name: 'my server', type: 'pending', config }] } }
    expect(update(pending as never)).toBe(pending)
    const absent = { mcp: { clients: [other] } }
    expect(update(absent as never)).toBe(absent)
  })
})
