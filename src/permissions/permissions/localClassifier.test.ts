import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  _resetLocalClassifierNoticeForTesting,
  classifierWouldRunLocally,
  LOCAL_CLASSIFIER_NOTICE,
  takeLocalClassifierNotice,
} from 'src/permissions/permissions/localClassifier.js'

describe('takeLocalClassifierNotice', () => {
  test('once per process', () => {
    _resetLocalClassifierNoticeForTesting()
    expect(takeLocalClassifierNotice()).toBe(LOCAL_CLASSIFIER_NOTICE)
    expect(takeLocalClassifierNotice()).toBeNull()
    _resetLocalClassifierNoticeForTesting()
  })
})

describe('classifierWouldRunLocally', () => {
  test('a local model behind a local endpoint judges its own actions', () => {
    expect(
      classifierWouldRunLocally('mgraffam/qwen3.8-35B-A3B-empero:latest', 'http://localhost:11434/v1'),
    ).toBe(true)
    expect(classifierWouldRunLocally('llama3.1:8b', 'http://127.0.0.1:8080/v1')).toBe(true)
    expect(classifierWouldRunLocally('qwen3:8b', 'http://192.168.1.20:11434/v1')).toBe(true)
  })

  test('a Claude model keeps the classifier even through a local proxy', () => {
    expect(classifierWouldRunLocally('claude-sonnet-4-6', 'http://localhost:4000/v1')).toBe(false)
    expect(classifierWouldRunLocally('anthropic/claude-opus-5-5', 'http://localhost:4000/v1')).toBe(false)
    expect(classifierWouldRunLocally('us.anthropic.claude-haiku-5-5', 'http://localhost:4000/v1')).toBe(false)
  })

  test('a hosted endpoint keeps the classifier whatever the model', () => {
    expect(classifierWouldRunLocally('gpt-5.5', 'https://api.openai.com/v1')).toBe(false)
    expect(classifierWouldRunLocally('qwen3-coder', 'https://openrouter.ai/api/v1')).toBe(false)
  })

  test('no base URL (first-party Anthropic) keeps the classifier', () => {
    expect(classifierWouldRunLocally('claude-opus-5-5', undefined)).toBe(false)
    expect(classifierWouldRunLocally('some-model', undefined)).toBe(false)
  })
})

// The auto-mode branch of hasPermissionsToUseTool sits behind
// feature('TRANSCRIPT_CLASSIFIER'), which reads false under bun test, so the
// wiring is pinned on the source: the local check comes before the classifier
// call and leaves the auto branch instead of calling it.
describe('permissions.ts wiring', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'permissions.ts'), 'utf8')

  test('the local check runs before the classifier is called', () => {
    const check = source.indexOf('classifierWouldRunLocally(')
    const call = source.indexOf('classifierResult = await classifyYoloAction(')
    expect(check).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(-1)
    expect(check).toBeLessThan(call)
  })
})
