import { describe, expect, test } from 'bun:test'
import { resolveShimEffortValues } from 'src/providers/model/reasoningCatalog.js'
import { geminiThinkingConfig } from 'src/providers/shims/gemini/thinking.js'

const NATIVE = 'https://generativelanguage.googleapis.com/v1beta'
const COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai'
const VERTEX = 'https://us-central1-aiplatform.googleapis.com'

const config = (model: string, effort?: string, thinkingDisabled = false, baseUrl = NATIVE) =>
  geminiThinkingConfig({ model, baseUrl, effort, thinkingDisabled })

describe('geminiThinkingConfig on Gemini 3', () => {
  test('no effort: HIGH with thought summaries, like gemini-cli', () => {
    expect(config('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true })
  })

  test('the effort, clamped onto the levels the model takes', () => {
    expect(config('gemini-3-flash-preview', 'low')).toEqual({ thinkingLevel: 'LOW', includeThoughts: true })
    // 3.1 Pro takes low/medium/high: xhigh lands on high.
    expect(config('gemini-3.1-pro-preview', 'xhigh')).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true })
  })

  test('thinking disabled: the least the model allows, without summaries', () => {
    expect(config('gemini-3-flash-preview', 'high', true)).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: false })
    expect(config('gemini-3.1-pro-preview', 'high', true)).toEqual({ thinkingLevel: 'LOW', includeThoughts: false })
  })

  test('on Vertex the levels come from the same rows', () => {
    expect(config('gemini-3-flash-preview', 'low', false, VERTEX)).toEqual({ thinkingLevel: 'LOW', includeThoughts: true })
  })

  // ai.google.dev/gemini-api/docs/thinking: every current text model takes
  // low/medium/high, gemini-4-argon included.
  test('a model the catalog does not list yet gets low/medium/high', () => {
    expect(config('gemini-4-argon', 'medium')).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true })
    expect(config('gemini-3.9-ultra', 'medium', false, undefined)).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true })
  })
})

describe('geminiThinkingConfig on Gemini 2.5', () => {
  test('no effort: 8192 tokens, like gemini-cli', () => {
    expect(config('gemini-2.5-pro')).toEqual({ thinkingBudget: 8192, includeThoughts: true })
  })

  test('a budget per level', () => {
    expect(config('gemini-2.5-flash', 'low')).toEqual({ thinkingBudget: 1024, includeThoughts: true })
    expect(config('gemini-2.5-flash', 'high')).toEqual({ thinkingBudget: 24576, includeThoughts: true })
    expect(config('gemini-2.5-flash', 'max')).toEqual({ thinkingBudget: 24576, includeThoughts: true })
  })

  test('thinking disabled: 0, except Pro, whose floor is 128', () => {
    expect(config('gemini-2.5-flash', undefined, true)).toEqual({ thinkingBudget: 0, includeThoughts: false })
    expect(config('gemini-2.5-pro', undefined, true)).toEqual({ thinkingBudget: 128, includeThoughts: false })
  })
})

test('models that do not think get no thinkingConfig', () => {
  expect(config('gemini-2.0-flash')).toBeUndefined()
  expect(config('gemma-4-31b-it')).toBeUndefined()
})

describe('resolveShimEffortValues for Gemini', () => {
  test('native 2.5: the three budget levels', () => {
    expect(resolveShimEffortValues(NATIVE, 'gemini-2.5-pro')).toEqual(['low', 'medium', 'high'])
  })

  test('native 3.x: the catalog row', () => {
    expect(resolveShimEffortValues(NATIVE, 'gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high'])
  })

  test('native, a model newer than the catalog: low/medium/high, so /effort shows', () => {
    expect(resolveShimEffortValues(NATIVE, 'gemini-4-argon')).toEqual(['low', 'medium', 'high'])
    expect(resolveShimEffortValues(VERTEX, 'gemini-4-argon')).toEqual(['low', 'medium', 'high'])
  })

  test('Vertex: the google rows, not the Claude ones', () => {
    expect(resolveShimEffortValues(VERTEX, 'gemini-3-flash-preview')).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  test('the OpenAI-compatible endpoint keeps the catalog alone', () => {
    expect(resolveShimEffortValues(COMPAT, 'gemini-2.5-pro')).toBeUndefined()
    expect(resolveShimEffortValues(COMPAT, 'gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high'])
  })
})
