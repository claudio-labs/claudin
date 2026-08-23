import { describe, expect, test } from 'bun:test'

import { resolveAgentPermissionMode } from 'src/tools/AgentTool/agentPermissionMode.js'

// 'auto' is deliberately untested: whether it wins depends on the
// TRANSCRIPT_CLASSIFIER build flag, and an assertion that reads the flag to
// decide what to expect would pass with the branch deleted.
describe('resolveAgentPermissionMode', () => {
  test('keeps the parent mode when the agent declares none', () => {
    expect(resolveAgentPermissionMode('plan', undefined)).toBe('plan')
    expect(resolveAgentPermissionMode('default', undefined)).toBe('default')
  })

  test('applies the agent mode over an unprotected parent mode', () => {
    expect(resolveAgentPermissionMode('default', 'bubble')).toBe('bubble')
    expect(resolveAgentPermissionMode('default', 'dontAsk')).toBe('dontAsk')
  })

  test('plan mode wins over the agent mode', () => {
    // The fork definition declares 'bubble'. Letting it win hands the child a
    // context whose mode is not 'plan', and the plan-mode hard deny reads the
    // mode off that context — so the child would be free to write.
    expect(resolveAgentPermissionMode('plan', 'bubble')).toBe('plan')
    expect(resolveAgentPermissionMode('plan', 'dontAsk')).toBe('plan')
    expect(resolveAgentPermissionMode('plan', 'default')).toBe('plan')
    expect(resolveAgentPermissionMode('plan', 'acceptEdits')).toBe('plan')
  })

  test('bypassPermissions and acceptEdits keep winning', () => {
    expect(resolveAgentPermissionMode('bypassPermissions', 'bubble')).toBe(
      'bypassPermissions',
    )
    expect(resolveAgentPermissionMode('bypassPermissions', 'default')).toBe(
      'bypassPermissions',
    )
    expect(resolveAgentPermissionMode('acceptEdits', 'bubble')).toBe(
      'acceptEdits',
    )
    expect(resolveAgentPermissionMode('acceptEdits', 'default')).toBe(
      'acceptEdits',
    )
  })
})
