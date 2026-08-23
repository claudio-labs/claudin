import { describe, expect, test } from 'bun:test'

import { createPermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'

type SetterCall = {
  context: ToolPermissionContext
  options: { preserveMode?: boolean } | undefined
}

// The mode reported by the CHILD's getAppState(). In a real fork this is the
// agent definition's mode, while the setter still writes the parent's state.
function makeContext(childMode: PermissionMode) {
  const calls: SetterCall[] = []
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: childMode,
    },
  }
  const toolUseContext = {
    getAppState: () => appState,
    abortController: new AbortController(),
    agentId: 'agent-1',
    options: { isNonInteractiveSession: true },
  } as unknown as ToolUseContext
  const ctx = createPermissionContext(
    { name: 'Bash' } as unknown as Tool,
    {},
    toolUseContext,
    { message: { id: 'msg-1' } } as unknown as AssistantMessage,
    'toolu_1',
    (context, options) => calls.push({ context, options }),
  )
  return { ctx, calls }
}

// destination 'session' keeps persistPermissionUpdate() a no-op, so nothing
// here touches settings.json.
const ALLOW_RULE: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
  behavior: 'allow',
  destination: 'session',
}

describe('persistPermissions', () => {
  test("does not write the child's mode into the parent's state", async () => {
    const { ctx, calls } = makeContext('bubble')

    await ctx.persistPermissions([ALLOW_RULE])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.preserveMode).toBe(true)
    // The rule itself still lands — only the mode is held back.
    expect(calls[0]?.context.alwaysAllowRules['session']).toEqual(['Bash(ls:*)'])
  })

  test('lets an explicit setMode update through', async () => {
    const { ctx, calls } = makeContext('bubble')

    await ctx.persistPermissions([
      ALLOW_RULE,
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options?.preserveMode).toBeFalsy()
    expect(calls[0]?.context.mode).toBe('acceptEdits')
  })

  test('writes nothing when there are no updates', async () => {
    const { ctx, calls } = makeContext('bubble')

    expect(await ctx.persistPermissions([])).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
