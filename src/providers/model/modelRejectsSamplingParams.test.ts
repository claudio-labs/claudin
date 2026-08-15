import { expect, test } from 'bun:test'

import { modelRejectsSamplingParams } from 'src/providers/model/model.js'

test('rejects sampling params for Opus 4.7+ family', () => {
  expect(modelRejectsSamplingParams('claude-opus-4-8')).toBe(true)
  expect(modelRejectsSamplingParams('claude-opus-4-8[1m]')).toBe(true)
  expect(modelRejectsSamplingParams('claude-opus-4-7')).toBe(true)
  expect(modelRejectsSamplingParams('claude-opus-4-7[1m]')).toBe(true)
})

test('rejects sampling params for Fable 5, Sonnet 5 and Opus 5', () => {
  expect(modelRejectsSamplingParams('claude-fable-5')).toBe(true)
  expect(modelRejectsSamplingParams('claude-sonnet-5')).toBe(true)
  expect(modelRejectsSamplingParams('claude-opus-5')).toBe(true)
})

test('accepts sampling params for older Anthropic models', () => {
  expect(modelRejectsSamplingParams('claude-opus-4-6')).toBe(false)
  expect(modelRejectsSamplingParams('claude-sonnet-4-6')).toBe(false)
  expect(modelRejectsSamplingParams('claude-haiku-4-5-20251001')).toBe(false)
})

test('does not affect non-Anthropic providers', () => {
  expect(modelRejectsSamplingParams('deepseek-chat')).toBe(false)
  expect(modelRejectsSamplingParams('gpt-4o')).toBe(false)
  expect(modelRejectsSamplingParams('gemini-2.5-pro')).toBe(false)
})
