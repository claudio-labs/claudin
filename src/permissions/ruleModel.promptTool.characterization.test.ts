/**
 * The permission prompt tool: in headless runs an SDK host (or an MCP tool
 * named by --permission-prompt-tool) answers permission questions. These
 * are the shapes of the question and the answer, and how an answer becomes a
 * decision: an allow may rewrite the tool input and carry permission updates,
 * which are applied to the session and saved; a deny may stop the turn.
 *
 * The host's answer is untrusted input, so the malformed cases matter.
 */
import { describe, expect, test } from 'bun:test'
import {
  inputSchema,
  outputSchema,
  permissionPromptToolResultToPermissionDecision,
  type Output,
} from 'src/permissions/PermissionPromptToolResultSchema.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { useRuleModelWorld } from 'src/permissions/__testutils__/ruleModelWorld.js'
import { getEmptyToolPermissionContext, type Tool, type ToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

const world = useRuleModelWorld('prompt-tool')

/** What the decision needs from its caller: the app state it may update, and the turn it may stop. */
function turn() {
  let state = { toolPermissionContext: getEmptyToolPermissionContext() as ToolPermissionContext, other: 'kept' }
  let updates = 0
  const abortController = new AbortController()
  const context = {
    abortController,
    setAppState(update: (prev: typeof state) => typeof state) {
      updates += 1
      state = update(state)
    },
  } as unknown as ToolUseContext
  return { context, abortController, state: () => state, updates: () => updates }
}

const bash = { name: 'Bash' } as Tool
const ORIGINAL = { command: 'ls -la' }

describe('the question', () => {
  const questions: Array<[input: unknown, ok: boolean]> = [
    [{ tool_name: 'Bash', input: { command: 'ls' } }, true],
    [{ tool_name: 'Bash', input: {}, tool_use_id: 'toolu_1' }, true],
    [{ input: {} }, false],
    [{ tool_name: 'Bash' }, false],
    [{ tool_name: 'Bash', input: 'ls' }, false],
    [{ tool_name: 3, input: {} }, false],
    [{ tool_name: 'Bash', input: {}, tool_use_id: 9 }, false],
  ]
  test.each(questions)('%p is a valid question: %p', (input, ok) => {
    expect(inputSchema().safeParse(input).success).toBe(ok)
  })
})

describe('the answer', () => {
  const answers: Array<[why: string, input: unknown, ok: boolean]> = [
    ['an allow with its input', { behavior: 'allow', updatedInput: { a: 1 } }, true],
    ['an allow with empty input', { behavior: 'allow', updatedInput: {} }, true],
    ['an allow without input', { behavior: 'allow' }, false],
    ['an allow whose input is not an object', { behavior: 'allow', updatedInput: 'ls' }, false],
    ['a deny with a message', { behavior: 'deny', message: 'no' }, true],
    ['a deny that stops the turn', { behavior: 'deny', message: 'no', interrupt: true }, true],
    ['a deny without a message', { behavior: 'deny' }, false],
    ['a deny with a non-boolean interrupt', { behavior: 'deny', message: 'no', interrupt: 'yes' }, false],
    ['an ask', { behavior: 'ask', message: 'x' }, false],
    ['a passthrough', { behavior: 'passthrough', updatedInput: {} }, false],
    ['nothing', {}, false],
  ]
  test.each(answers)('%s is valid: %p', (_why, input, ok) => {
    expect(outputSchema().safeParse(input).success).toBe(ok)
  })

  test('valid optional fields are kept and unknown fields are dropped', () => {
    const updates: PermissionUpdate[] = [{ type: 'setMode', mode: 'plan', destination: 'session' }]
    expect(outputSchema().parse({
      behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions: updates, toolUseID: 't1', decisionClassification: 'user_permanent', extra: true,
    })).toEqual({ behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions: updates, toolUseID: 't1', decisionClassification: 'user_permanent' })
    expect(outputSchema().parse({ behavior: 'deny', message: 'm', interrupt: false, toolUseID: 't2', decisionClassification: 'user_reject', extra: 1 }))
      .toEqual({ behavior: 'deny', message: 'm', interrupt: false, toolUseID: 't2', decisionClassification: 'user_reject' })
  })

  test('the three decision classifications are accepted on both behaviors', () => {
    for (const decisionClassification of ['user_temporary', 'user_permanent', 'user_reject'] as const) {
      expect(outputSchema().parse({ behavior: 'allow', updatedInput: {}, decisionClassification }).decisionClassification).toBe(decisionClassification)
      expect(outputSchema().parse({ behavior: 'deny', message: 'm', decisionClassification }).decisionClassification).toBe(decisionClassification)
    }
  })

  const badPermissions: unknown[] = [
    [{ type: 'bogus' }],
    [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'policySettings' }],
    [{ type: 'setMode', mode: 'auto', destination: 'session' }],
    'not a list',
  ]
  test.each(badPermissions)('malformed permission updates %p are dropped, and the allow still stands', updatedPermissions => {
    const parsed = outputSchema().parse({ behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions, toolUseID: 't' })
    expect(parsed).toEqual({ behavior: 'allow', updatedInput: { a: 1 }, toolUseID: 't' })
  })

  test('a malformed decision classification is dropped, and the answer still stands', () => {
    for (const answer of [{ behavior: 'allow', updatedInput: {} }, { behavior: 'deny', message: 'm' }]) {
      const parsed = outputSchema().parse({ ...answer, decisionClassification: 'whatever' })
      expect(parsed as unknown).toEqual(answer)
    }
  })
})

describe('turning an answer into a decision', () => {
  const reasonFor = (result: Output) => ({ type: 'permissionPromptTool' as const, permissionPromptToolName: 'Bash', toolResult: result })

  test('an allow uses the rewritten input and names the prompt tool as the reason', () => {
    const t = turn()
    const result: Output = { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'u1' }
    expect(permissionPromptToolResultToPermissionDecision(result, bash, ORIGINAL, t.context)).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      toolUseID: 'u1',
      decisionReason: reasonFor(result),
    })
    expect(t.updates()).toBe(0)
    expect(t.abortController.signal.aborted).toBe(false)
  })

  test('an allow with an empty input runs the tool with its original input', () => {
    const t = turn()
    const result: Output = { behavior: 'allow', updatedInput: {} }
    const decision = permissionPromptToolResultToPermissionDecision(result, bash, ORIGINAL, t.context)
    expect(decision.behavior === 'allow' && decision.updatedInput).toEqual(ORIGINAL)
  })

  test('an allow that carries updates applies them to the session and saves the file-bound ones', () => {
    const t = turn()
    const updatedPermissions: PermissionUpdate[] = [
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] },
      { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'WebFetch' }] },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]
    const result: Output = { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions }
    const decision = permissionPromptToolResultToPermissionDecision(result, bash, ORIGINAL, t.context)

    expect(decision).toEqual({ ...result, decisionReason: reasonFor(result) })
    expect(t.updates()).toBe(1)
    const ctx = t.state().toolPermissionContext
    expect([ctx.mode, ctx.alwaysAllowRules, ctx.alwaysDenyRules]).toEqual([
      'acceptEdits',
      { localSettings: ['Bash(npm test)'] },
      { session: ['WebFetch'] },
    ])
    expect(t.state().other).toBe('kept')
    expect(world.json('local')).toEqual({ permissions: { allow: ['Bash(npm test)'] } })
    expect(world.text('user')).toBeNull()
  })

  test('a deny keeps its message and does not stop the turn', () => {
    const t = turn()
    const result: Output = { behavior: 'deny', message: 'not now', toolUseID: 'u2' }
    expect(permissionPromptToolResultToPermissionDecision(result, bash, ORIGINAL, t.context)).toEqual({
      behavior: 'deny',
      message: 'not now',
      toolUseID: 'u2',
      decisionReason: reasonFor(result),
    })
    expect(t.abortController.signal.aborted).toBe(false)
    expect(t.updates()).toBe(0)
  })

  test('a deny with interrupt stops the turn', () => {
    const t = turn()
    const result: Output = { behavior: 'deny', message: 'stop', interrupt: true }
    const decision = permissionPromptToolResultToPermissionDecision(result, bash, ORIGINAL, t.context)
    expect(t.abortController.signal.aborted).toBe(true)
    expect(decision).toEqual({ ...result, decisionReason: reasonFor(result) })
  })

  test('the reason names whichever tool asked', () => {
    const t = turn()
    const result: Output = { behavior: 'deny', message: 'x' }
    const decision = permissionPromptToolResultToPermissionDecision(result, { name: 'mcp__gate__check' } as Tool, {}, t.context)
    expect(decision.decisionReason).toEqual({ type: 'permissionPromptTool', permissionPromptToolName: 'mcp__gate__check', toolResult: result })
  })
})
