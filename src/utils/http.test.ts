/**
 * Pre-removal regression tests for getUserAgent — workload tag (cron QoS
 * routing) is being removed; pin the surrounding User-Agent contract so
 * the simplification doesn't accidentally drop the SDK / client-app
 * suffixes or change the prefix consumers rely on.
 *
 * NOTE: log filtering on Anthropic's side keys on `claude-cli` (see the
 * comment in src/utils/http.ts). Do not rename without coordinating
 * downstream — these tests guard that.
 */
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudinlabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getUserAgent } from './http.ts'

const ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('getUserAgent', () => {
  test('starts with claude-cli/<version> — required for Anthropic-side log filtering', () => {
    const ua = getUserAgent()
    expect(ua.startsWith('claude-cli/99.0.0')).toBe(true)
  })

  test('includes entrypoint inside the parenthesized metadata (defaults to "cli")', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/\(cli/)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk'
    expect(getUserAgent()).toMatch(/\(sdk/)
  })

  test('appends agent-sdk and client-app suffixes when their env vars are set', () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = '1.2.3'
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'my-app/1.0.0'
    const ua = getUserAgent()
    expect(ua).toContain('agent-sdk/1.2.3')
    expect(ua).toContain('client-app/my-app/1.0.0')
  })
})
