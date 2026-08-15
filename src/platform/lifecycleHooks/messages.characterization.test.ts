/**
 * Characterization tests for pure hook message formatters and HookOutsideReplResult helpers.
 *
 * Locks in the exact strings these functions return so the 11d split (moving them to
 * `hooks/messages.ts`) cannot drift behavior. These are pure functions — no mocks needed.
 *
 * Covered exports from src/platform/lifecycleHooks/hooks.ts:
 *   - getPreToolHookBlockingMessage
 *   - getStopHookMessage
 *   - getTeammateIdleHookMessage
 *   - getTaskCreatedHookMessage
 *   - getTaskCompletedHookMessage
 *   - getUserPromptSubmitHookBlockingMessage
 *   - hasBlockingResult
 *   - getSessionEndHookTimeoutMs
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTeammateIdleHookMessage,
  getTaskCreatedHookMessage,
  getTaskCompletedHookMessage,
  getUserPromptSubmitHookBlockingMessage,
  hasBlockingResult,
  getSessionEndHookTimeoutMs,
  type HookBlockingError,
} from 'src/platform/lifecycleHooks/hooks.js'
import type { HookOutsideReplResult } from 'src/platform/lifecycleHooks/types.js'

const sampleError: HookBlockingError = {
  blockingError: 'permission denied',
  command: 'echo blocked',
}

describe('hook message formatters (characterization)', () => {
  test('getPreToolHookBlockingMessage formats with hook name + blockingError', () => {
    expect(getPreToolHookBlockingMessage('PreToolGuard', sampleError)).toBe(
      'PreToolGuard hook error: permission denied',
    )
  })

  test('getPreToolHookBlockingMessage preserves multi-line blockingError verbatim', () => {
    const multiline: HookBlockingError = {
      blockingError: 'line 1\nline 2\nline 3',
      command: 'noop',
    }
    expect(getPreToolHookBlockingMessage('Guard', multiline)).toBe(
      'Guard hook error: line 1\nline 2\nline 3',
    )
  })

  test('getStopHookMessage prefixes "Stop hook feedback:\\n"', () => {
    expect(getStopHookMessage(sampleError)).toBe(
      'Stop hook feedback:\npermission denied',
    )
  })

  test('getTeammateIdleHookMessage prefixes "TeammateIdle hook feedback:\\n"', () => {
    expect(getTeammateIdleHookMessage(sampleError)).toBe(
      'TeammateIdle hook feedback:\npermission denied',
    )
  })

  test('getTaskCreatedHookMessage prefixes "TaskCreated hook feedback:\\n"', () => {
    expect(getTaskCreatedHookMessage(sampleError)).toBe(
      'TaskCreated hook feedback:\npermission denied',
    )
  })

  test('getTaskCompletedHookMessage prefixes "TaskCompleted hook feedback:\\n"', () => {
    expect(getTaskCompletedHookMessage(sampleError)).toBe(
      'TaskCompleted hook feedback:\npermission denied',
    )
  })

  test('getUserPromptSubmitHookBlockingMessage prefixes "UserPromptSubmit operation blocked by hook:\\n"', () => {
    expect(getUserPromptSubmitHookBlockingMessage(sampleError)).toBe(
      'UserPromptSubmit operation blocked by hook:\npermission denied',
    )
  })

  test('all formatters tolerate empty blockingError string', () => {
    const empty: HookBlockingError = { blockingError: '', command: 'noop' }
    expect(getPreToolHookBlockingMessage('X', empty)).toBe('X hook error: ')
    expect(getStopHookMessage(empty)).toBe('Stop hook feedback:\n')
    expect(getTeammateIdleHookMessage(empty)).toBe('TeammateIdle hook feedback:\n')
    expect(getTaskCreatedHookMessage(empty)).toBe('TaskCreated hook feedback:\n')
    expect(getTaskCompletedHookMessage(empty)).toBe('TaskCompleted hook feedback:\n')
    expect(getUserPromptSubmitHookBlockingMessage(empty)).toBe(
      'UserPromptSubmit operation blocked by hook:\n',
    )
  })
})

describe('hasBlockingResult (characterization)', () => {
  function mk(blocked: boolean): HookOutsideReplResult {
    return {
      command: 'noop',
      succeeded: !blocked,
      output: '',
      blocked,
    }
  }

  test('returns false for empty array', () => {
    expect(hasBlockingResult([])).toBe(false)
  })

  test('returns false when no result is blocked', () => {
    expect(hasBlockingResult([mk(false), mk(false), mk(false)])).toBe(false)
  })

  test('returns true when any single result is blocked', () => {
    expect(hasBlockingResult([mk(false), mk(true), mk(false)])).toBe(true)
  })

  test('returns true when all results are blocked', () => {
    expect(hasBlockingResult([mk(true), mk(true)])).toBe(true)
  })
})

describe('getSessionEndHookTimeoutMs (characterization)', () => {
  const ENV_KEY = 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'
  const original = process.env[ENV_KEY]

  beforeEach(() => {
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = original
    }
  })

  test('returns default when env var unset', () => {
    const result = getSessionEndHookTimeoutMs()
    expect(result).toBeGreaterThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test('returns parsed value when env var is a positive integer', () => {
    process.env[ENV_KEY] = '12345'
    expect(getSessionEndHookTimeoutMs()).toBe(12345)
  })

  test('falls back to default when env var is non-numeric', () => {
    process.env[ENV_KEY] = 'not-a-number'
    const fallback = getSessionEndHookTimeoutMs()
    expect(fallback).toBeGreaterThan(0)
    expect(Number.isFinite(fallback)).toBe(true)
  })

  test('falls back to default when env var is zero', () => {
    process.env[ENV_KEY] = '0'
    expect(getSessionEndHookTimeoutMs()).toBeGreaterThan(0)
  })

  test('falls back to default when env var is negative', () => {
    process.env[ENV_KEY] = '-500'
    expect(getSessionEndHookTimeoutMs()).toBeGreaterThan(0)
  })

  test('falls back to default when env var is empty string', () => {
    process.env[ENV_KEY] = ''
    expect(getSessionEndHookTimeoutMs()).toBeGreaterThan(0)
  })

  test('parseInt accepts leading digits with trailing garbage (current behavior)', () => {
    // Locks in parseInt's permissive parsing — `parseInt('500abc', 10) === 500`.
    // If the split refactor swaps to Number()/stricter parsing, this test catches it.
    process.env[ENV_KEY] = '500abc'
    expect(getSessionEndHookTimeoutMs()).toBe(500)
  })
})
