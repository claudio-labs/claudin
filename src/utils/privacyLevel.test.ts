import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getEssentialTrafficOnlyReason,
  getPrivacyLevel,
  isEssentialTrafficOnly,
  isTelemetryDisabled,
} from './privacyLevel.js'

const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
] as const

describe('privacyLevel', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('Claudin default = essential-traffic when no env vars set', () => {
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(isEssentialTrafficOnly()).toBe(true)
    expect(isTelemetryDisabled()).toBe(true)
    expect(getEssentialTrafficOnlyReason()).toBe('claudin-default')
  })

  test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 → essential-traffic (explicit)', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(getEssentialTrafficOnlyReason()).toBe(
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    )
  })

  test('ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=1 → essential-traffic (explicit)', () => {
    process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(getEssentialTrafficOnlyReason()).toBe(
      'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
    )
  })

  test('ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0 → default (opt-in to nonessential)', () => {
    process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    expect(getPrivacyLevel()).toBe('default')
    expect(isEssentialTrafficOnly()).toBe(false)
    expect(getEssentialTrafficOnlyReason()).toBeNull()
  })

  test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=false → default', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 'false'
    expect(getPrivacyLevel()).toBe('default')
  })

  test('opt-in + DISABLE_TELEMETRY → no-telemetry', () => {
    process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    process.env.DISABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('no-telemetry')
  })

  test('DISABLE_TELEMETRY alone does NOT override Claudin essential-traffic default', () => {
    process.env.DISABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
  })

  test('CLAUDE_CODE_* takes precedence over ANTHROPIC_* in reason reporting', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    process.env.ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getEssentialTrafficOnlyReason()).toBe(
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    )
  })
})
