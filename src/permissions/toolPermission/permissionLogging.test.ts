/**
 * What the decision store keeps about each permission decision — the record
 * a tool_result message carries into the transcript.
 *
 * Until 2026-10-19 it kept who decided and when, in memory only, and every
 * automatic decision was `config`: a rule, the mode and the auto-mode
 * classifier looked the same, so the 10-19 census could count neither the
 * classifier's denials nor the prompts the user answered.
 */
import { describe, expect, test } from 'bun:test'
import { logPermissionDecision } from 'src/permissions/toolPermission/permissionLogging.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'

function logged(
  args: Parameters<typeof logPermissionDecision>[1],
  promptStartedMs?: number,
) {
  const toolUseContext = {} as ToolUseContext
  logPermissionDecision(
    { tool: { name: 'Bash' } as Tool, input: {}, toolUseContext, messageId: 'msg_1', toolUseID: 'toolu_1' },
    args,
    promptStartedMs,
  )
  return toolUseContext.toolDecisions?.get('toolu_1')
}

describe('the permission decision record', () => {
  test('a rule names itself', () => {
    const record = logged({
      decision: 'accept',
      source: 'config',
      reason: {
        type: 'rule',
        rule: { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'git log:*' } },
      },
    })
    expect(record).toMatchObject({ decision: 'accept', source: 'automatic', reason: 'rule', detail: 'Bash(git log:*)' })
  })

  test('an auto-mode verdict is automatic, with the classifier as its reason, capped at 200 characters', () => {
    const record = logged({
      decision: 'reject',
      source: 'config',
      reason: { type: 'classifier', classifier: 'auto-mode', reason: 'x'.repeat(500) },
    })
    expect(record).toMatchObject({ decision: 'reject', source: 'automatic', reason: 'classifier' })
    expect(record?.detail).toHaveLength(200)
  })

  test('a mode says which', () => {
    expect(logged({ decision: 'accept', source: 'config', reason: { type: 'mode', mode: 'acceptEdits' } })).toMatchObject({
      source: 'automatic',
      reason: 'mode',
      detail: 'acceptEdits',
    })
  })

  test('a prompt the user answered records how long it waited', () => {
    const record = logged({ decision: 'accept', source: { type: 'user', permanent: false } }, Date.now() - 1_500)
    expect(record?.source).toBe('user_temporary')
    expect(record?.waitMs).toBeGreaterThanOrEqual(1_500)
  })

  test('a decision with no reason and no prompt keeps only who and what', () => {
    const record = logged({ decision: 'accept', source: 'config' })
    expect(Object.keys(record ?? {}).sort()).toEqual(['decision', 'source'])
  })
})
