import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import {
  getAvailableEffortLevels,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
} from './effort.js'

// Pin getAPIProvider to 'openai' so the effort functions see a Kimi provider as
// an OpenAI-compatible transport, not the first-party fallback. This matches
// the real runtime when a Kimi Code profile is active.
const realProviders = { ...(await import('./model/providers.js')) }
const pinOpenAiProvider = () =>
  mock.module('./model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'openai' as const,
  }))
pinOpenAiProvider()

beforeEach(pinOpenAiProvider)

afterAll(() => {
  mock.module('./model/providers.js', () => realProviders)
})

test('K3 supports effort', () => {
  expect(modelSupportsEffort('k3')).toBe(true)
  expect(modelSupportsEffort('kimi-code/k3')).toBe(true)
})

test('other Kimi models do not support granular effort under an openai provider', () => {
  expect(modelSupportsEffort('kimi-for-coding')).toBe(false)
  expect(modelSupportsEffort('kimi-for-coding-highspeed')).toBe(false)
})

test('K3 supports max effort', () => {
  expect(modelSupportsMaxEffort('k3')).toBe(true)
})

test('K3 exposes Low/High/Max levels only', () => {
  expect(getAvailableEffortLevels('k3')).toEqual(['low', 'high', 'max'])
})

test('K3 defaults to max effort', () => {
  expect(resolveAppliedEffort('k3', undefined)).toBe('max')
})

test('K3 normalizes non-Kimi levels', () => {
  expect(resolveAppliedEffort('k3', 'medium')).toBe('low')
  expect(resolveAppliedEffort('k3', 'xhigh')).toBe('max')
})

test('K3 passes through its native levels', () => {
  expect(resolveAppliedEffort('k3', 'low')).toBe('low')
  expect(resolveAppliedEffort('k3', 'high')).toBe('high')
  expect(resolveAppliedEffort('k3', 'max')).toBe('max')
})
