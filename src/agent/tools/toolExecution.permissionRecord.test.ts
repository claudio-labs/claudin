// Every tool_result message carries the permission decision that let its call
// run or stopped it, so the transcript holds what the 10-19 census could not
// count: prompts, their wait, rule hits and the classifier's verdicts. It sits
// beside `toolUseResult` on the message record and never reaches the model.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runToolUse } from 'src/agent/tools/toolExecution.js'
import { logPermissionDecision } from 'src/permissions/toolPermission/permissionLogging.js'
import { userMessageToMessageParam } from 'src/providers/shims/claude/messageConverters.js'
import { buildTool, getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'

const probe = buildTool({
  name: 'PermProbe',
  maxResultSizeChars: 10_000,
  async description() {
    return 'probe'
  },
  async prompt() {
    return 'probe'
  },
  get inputSchema() {
    return z.strictObject({ command: z.string() })
  },
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async checkPermissions(input: { command: string }) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: { command: string }) {
    if (input.command === 'throw') throw new Error('boom')
    return { data: `ran ${input.command}` }
  },
  mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
    return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
  },
  renderToolUseMessage: () => null,
})

function context(): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
    options: { tools: [probe], mcpClients: [], isNonInteractiveSession: true, mainLoopModel: 'claude-opus-5-5' },
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

/** canUseTool as useCanUseTool runs it: log the decision, then hand it back. */
function deciding(args: Parameters<typeof logPermissionDecision>[1], result: unknown) {
  return (async (tool: never, input: unknown, toolUseContext: ToolUseContext, _a: unknown, toolUseID: string) => {
    logPermissionDecision({ tool, input, toolUseContext, messageId: 'msg_probe', toolUseID }, args)
    return result
  }) as never
}

async function resultMessage(command: string, canUseTool: never): Promise<UserMessage> {
  const toolUse = { type: 'tool_use' as const, id: 'toolu_perm', name: 'PermProbe', input: { command } }
  const assistant = { type: 'assistant', uuid: 'a-perm', message: { id: 'msg_probe', role: 'assistant', content: [toolUse] } }
  for await (const update of runToolUse(toolUse as never, assistant as never, canUseTool, context())) {
    const message = (update as { message?: Message }).message
    if (message?.type === 'user' && Array.isArray(message.message.content) && message.message.content.some(b => b.type === 'tool_result')) {
      return message
    }
  }
  throw new Error('no tool_result message')
}

const RULE = {
  type: 'rule' as const,
  rule: { source: 'userSettings' as const, ruleBehavior: 'allow' as const, ruleValue: { toolName: 'PermProbe' } },
}

describe('the permission decision on the tool_result message', () => {
  test('an allowed call that ran carries it', async () => {
    const message = await resultMessage(
      'ok',
      deciding({ decision: 'accept', source: 'config', reason: RULE }, { behavior: 'allow', updatedInput: { command: 'ok' }, decisionReason: RULE }),
    )
    expect(message.permissionDecision).toMatchObject({ decision: 'accept', source: 'automatic', reason: 'rule', detail: 'PermProbe' })
  })

  test('an allowed call that threw carries it too', async () => {
    const message = await resultMessage(
      'throw',
      deciding({ decision: 'accept', source: 'config', reason: RULE }, { behavior: 'allow', updatedInput: { command: 'throw' }, decisionReason: RULE }),
    )
    expect(message.permissionDecision).toMatchObject({ decision: 'accept', reason: 'rule' })
  })

  test("a classifier's denial carries the verdict and its reason", async () => {
    const reason = { type: 'classifier' as const, classifier: 'auto-mode', reason: 'Uses sudo, which the user did not ask for' }
    const message = await resultMessage(
      'sudo ls',
      deciding({ decision: 'reject', source: 'config', reason }, { behavior: 'deny', message: 'Permission for this action has been denied.', decisionReason: reason }),
    )
    expect(message.permissionDecision).toMatchObject({
      decision: 'reject',
      source: 'automatic',
      reason: 'classifier',
      detail: 'Uses sudo, which the user did not ask for',
    })
  })

  test('a canUseTool that logs nothing (print mode, the SDK) still leaves the decision', async () => {
    // `-p` hands hasPermissionsToUseTool's verdict back as is: the first live
    // run of this branch recorded nothing on any of its three tool_results.
    const reason = { type: 'classifier' as const, classifier: 'auto-mode', reason: 'Allowed: a file write in the working directory' }
    const allowedSilently = (async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input, decisionReason: reason })) as never
    const message = await resultMessage('ok', allowedSilently)
    expect(message.permissionDecision).toEqual({
      decision: 'accept',
      source: 'automatic',
      reason: 'classifier',
      detail: 'Allowed: a file write in the working directory',
    })
    const deniedSilently = (async () => ({ behavior: 'deny', message: 'denied', decisionReason: RULE })) as never
    expect((await resultMessage('no', deniedSilently)).permissionDecision).toMatchObject({ decision: 'reject', source: 'automatic', reason: 'rule' })
  })

  test('it never reaches the model', async () => {
    const message = await resultMessage(
      'ok',
      deciding({ decision: 'accept', source: 'config', reason: RULE }, { behavior: 'allow', updatedInput: { command: 'ok' }, decisionReason: RULE }),
    )
    expect(message.permissionDecision).toBeDefined()
    // The wire takes `message.message` only, as it does for toolUseResult.
    for (const addCache of [false, true]) {
      const param = JSON.stringify(userMessageToMessageParam(message, addCache, true))
      expect(param).toContain('ran ok')
      expect(param).not.toContain('permissionDecision')
      expect(param).not.toContain('PermProbe')
    }
  })
})
