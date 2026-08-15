import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/Tool.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import {
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
} from 'src/services/permissions/permissions.js'
import type { PermissionResult } from 'src/services/permissions/PermissionResult.js'

type FakeToolOpts = {
  name: string
  isReadOnly?: boolean
  checkPermissions?: PermissionResult
  requiresUserInteraction?: boolean
}

function fakeTool(opts: FakeToolOpts): Tool {
  const inputSchema = z.object({ path: z.string().optional() })
  return {
    name: opts.name,
    inputSchema,
    async checkPermissions() {
      return (
        opts.checkPermissions ?? {
          behavior: 'passthrough',
          message: '',
        }
      )
    },
    isReadOnly: () => opts.isReadOnly ?? false,
    requiresUserInteraction: opts.requiresUserInteraction
      ? () => true
      : undefined,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    async description() {
      return ''
    },
    async call() {
      throw new Error('not called in tests')
    },
  } as unknown as Tool
}

function makeContext(
  permissionContextOverrides: Partial<ToolPermissionContext> = {},
): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    ...permissionContextOverrides,
  }
  return {
    abortController: new AbortController(),
    options: {
      isNonInteractiveSession: false,
    },
    getAppState() {
      return { toolPermissionContext }
    },
    setAppState() {},
  } as unknown as ToolUseContext
}

const FAKE_ASSISTANT_MSG = {
  message: { id: 'msg_test_id' },
} as unknown as Parameters<typeof hasPermissionsToUseTool>[3]

async function callGate(
  tool: Tool,
  context: ToolUseContext,
  input: Record<string, unknown> = {},
) {
  return hasPermissionsToUseTool(
    tool,
    input,
    context,
    FAKE_ASSISTANT_MSG,
    'tool_use_test',
  )
}

describe('plan mode hard gate', () => {
  test('1. denies non-readonly tool with passthrough checkPermissions', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    if (result.behavior !== 'deny') throw new Error('expected deny')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
    // Not snapshotted: the message names the session's plan file, whose path
    // (project dir + random slug) differs per machine and per run.
    expect(result.message).toStartWith(
      'Plan mode is active. Tool FileEdit is not read-only and cannot run until you call ExitPlanMode.',
    )
    expect(result.message).toMatch(
      /Only the plan file \(.+\.md\) may be edited\.$/,
    )
  })

  test('2. allows when tool.checkPermissions already returned allow (plan file path)', async () => {
    const tool = fakeTool({
      name: 'FileWrite',
      isReadOnly: false,
      checkPermissions: {
        behavior: 'allow',
        updatedInput: {},
        decisionReason: { type: 'other', reason: 'plan file' },
      },
    })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).toBe('allow')
  })

  test('3. read-only tool passes the gate (falls through to default ask)', async () => {
    const tool = fakeTool({ name: 'Grep', isReadOnly: true })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).not.toBe('deny')
  })

  test('4. denies Bash (non-readonly) even with readonly-looking command', async () => {
    const tool = fakeTool({ name: 'Bash', isReadOnly: false })
    const result = await callGate(
      tool,
      makeContext({ mode: 'plan' }),
      { command: 'ls' },
    )
    expect(result.behavior).toBe('deny')
  })

  test('5. inherited bypass (plan + isBypassPermissionsModeAvailable) allows non-readonly tools', async () => {
    const tool = fakeTool({ name: 'FileWrite', isReadOnly: false })
    const result = await callGate(
      tool,
      makeContext({
        mode: 'plan',
        isBypassPermissionsModeAvailable: true,
      }),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'mode', mode: 'plan' })
  })

  test('6. ExitPlanMode itself is not blocked by the gate', async () => {
    const tool = fakeTool({
      name: EXIT_PLAN_MODE_V2_TOOL_NAME,
      isReadOnly: false,
      checkPermissions: { behavior: 'ask', message: 'Exit plan mode?' },
    })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).not.toBe('deny')
  })

  test('8. MCP-like tool with isReadOnly=false is denied in plan mode', async () => {
    const tool = fakeTool({
      name: 'mcp__my_server__do_thing',
      isReadOnly: false,
    })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).toBe('deny')
  })

  test('9. MCP-like tool with isReadOnly=true passes the gate', async () => {
    const tool = fakeTool({
      name: 'mcp__my_server__read_thing',
      isReadOnly: true,
    })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).not.toBe('deny')
  })

  test('11. tool with requiresUserInteraction (e.g. PowerShell) is hard-denied, no prompt', async () => {
    const tool = fakeTool({
      name: 'PowerShell',
      isReadOnly: false,
      requiresUserInteraction: true,
    })
    const result = await callGate(tool, makeContext({ mode: 'plan' }))
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
  })

  test('non-plan modes are unaffected: default mode still asks for non-readonly tool', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await callGate(tool, makeContext({ mode: 'default' }))
    expect(result.behavior).not.toBe('deny')
  })

  test('7. auto mode inside plan mode still hard-denies non-readonly tools', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await callGate(
      tool,
      makeContext({ mode: 'plan', isAutoModeAvailable: true }),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
  })

  test('10. user always-allow rule (Edit(*)) is overridden by plan mode', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await callGate(
      tool,
      makeContext({
        mode: 'plan',
        alwaysAllowRules: {
          userSettings: ['FileEdit'],
        },
      }),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
  })

  test('non-plan modes are unaffected: acceptEdits still allows', async () => {
    const tool = fakeTool({
      name: 'FileEdit',
      isReadOnly: false,
      checkPermissions: {
        behavior: 'allow',
        updatedInput: {},
        decisionReason: { type: 'other', reason: 'acceptEdits' },
      },
    })
    const result = await callGate(tool, makeContext({ mode: 'acceptEdits' }))
    expect(result.behavior).toBe('allow')
  })
})

describe('plan mode hard gate — checkRuleBasedPermissions (PreToolUse hook path)', () => {
  test('hook approval path denies non-readonly tool in plan mode', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await checkRuleBasedPermissions(
      tool,
      {},
      makeContext({ mode: 'plan' }),
    )
    expect(result?.behavior).toBe('deny')
    expect(result?.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
  })

  test('hook approval path allows read-only tool in plan mode', async () => {
    const tool = fakeTool({ name: 'Grep', isReadOnly: true })
    const result = await checkRuleBasedPermissions(
      tool,
      {},
      makeContext({ mode: 'plan' }),
    )
    expect(result).toBeNull()
  })

  test('hook approval path allows plan-file write (tool.checkPermissions=allow)', async () => {
    const tool = fakeTool({
      name: 'FileWrite',
      isReadOnly: false,
      checkPermissions: {
        behavior: 'allow',
        updatedInput: {},
        decisionReason: { type: 'other', reason: 'plan file' },
      },
    })
    const result = await checkRuleBasedPermissions(
      tool,
      {},
      makeContext({ mode: 'plan' }),
    )
    expect(result).toBeNull()
  })

  test('hook approval path: inherited bypass lets non-readonly through in plan mode', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await checkRuleBasedPermissions(
      tool,
      {},
      makeContext({
        mode: 'plan',
        isBypassPermissionsModeAvailable: true,
      }),
    )
    expect(result).toBeNull()
  })

  test('hook approval path: non-plan modes unaffected', async () => {
    const tool = fakeTool({ name: 'FileEdit', isReadOnly: false })
    const result = await checkRuleBasedPermissions(
      tool,
      {},
      makeContext({ mode: 'default' }),
    )
    expect(result).toBeNull()
  })
})
