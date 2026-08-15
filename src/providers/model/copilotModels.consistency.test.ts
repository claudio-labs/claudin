/**
 * Guard test: keep `copilotModels.ts` and the `github:copilot:` /
 * `github_copilot/` blocks of `openaiContextWindows.ts` in sync, plus the
 * Copilot display-name map referenced by `model.ts`.
 *
 * If you add or rename a Copilot model in `copilotModels.ts`, these
 * assertions fail until the parallel tables are updated. The check is
 * structural — it does not validate that the values are correct, only that
 * they are present and agree.
 */
import { describe, expect, test } from 'bun:test'

import {
  COPILOT_DISPLAY_NAMES,
  COPILOT_MODELS,
  getAllCopilotModels,
} from 'src/providers/model/copilotModels.js'
import {
  OPENAI_CONTEXT_WINDOWS,
  OPENAI_MAX_OUTPUT_TOKENS,
} from 'src/providers/model/openaiContextWindows.js'

const NAMESPACE_PROVIDER = 'github:copilot:' as const
const NAMESPACE_LITELLM = 'github_copilot/' as const

const namespacedKeys = (table: Record<string, number>): string[] =>
  Object.keys(table).filter(key => key.startsWith(NAMESPACE_PROVIDER))

const litellmKeys = (table: Record<string, number>): string[] =>
  Object.keys(table).filter(key => key.startsWith(NAMESPACE_LITELLM))

describe('copilotModels registry stays in sync with companion tables', () => {
  test('COPILOT_MODELS is non-empty (otherwise forward-direction tests pass vacuously)', () => {
    expect(getAllCopilotModels().length).toBeGreaterThan(0)
  })

  test('every COPILOT_MODELS entry has a context window in both namespaces', () => {
    for (const model of getAllCopilotModels()) {
      const providerKey = `${NAMESPACE_PROVIDER}${model.id}`
      const litellmKey = `${NAMESPACE_LITELLM}${model.id}`
      expect(OPENAI_CONTEXT_WINDOWS[providerKey]).toBe(model.limit.context)
      expect(OPENAI_CONTEXT_WINDOWS[litellmKey]).toBe(model.limit.context)
    }
  })

  test('every COPILOT_MODELS entry has matching max-output tokens in both namespaces', () => {
    for (const model of getAllCopilotModels()) {
      const providerKey = `${NAMESPACE_PROVIDER}${model.id}`
      const litellmKey = `${NAMESPACE_LITELLM}${model.id}`
      expect(OPENAI_MAX_OUTPUT_TOKENS[providerKey]).toBe(model.limit.output)
      expect(OPENAI_MAX_OUTPUT_TOKENS[litellmKey]).toBe(model.limit.output)
    }
  })

  test('namespaced github:copilot:* entries do not reference unknown models', () => {
    for (const key of namespacedKeys(OPENAI_CONTEXT_WINDOWS)) {
      const id = key.slice(NAMESPACE_PROVIDER.length)
      if (id === '') continue // bare 'github:copilot' alias
      expect(COPILOT_MODELS[id], `Stale ${key} — id missing from COPILOT_MODELS`).toBeDefined()
    }
    for (const key of namespacedKeys(OPENAI_MAX_OUTPUT_TOKENS)) {
      const id = key.slice(NAMESPACE_PROVIDER.length)
      if (id === '') continue
      expect(COPILOT_MODELS[id], `Stale ${key} — id missing from COPILOT_MODELS`).toBeDefined()
    }
  })

  test('LiteLLM github_copilot/* entries do not reference unknown models', () => {
    for (const key of litellmKeys(OPENAI_CONTEXT_WINDOWS)) {
      const id = key.slice(NAMESPACE_LITELLM.length)
      expect(COPILOT_MODELS[id], `Stale ${key} — id missing from COPILOT_MODELS`).toBeDefined()
    }
    for (const key of litellmKeys(OPENAI_MAX_OUTPUT_TOKENS)) {
      const id = key.slice(NAMESPACE_LITELLM.length)
      expect(COPILOT_MODELS[id], `Stale ${key} — id missing from COPILOT_MODELS`).toBeDefined()
    }
  })

  test('every COPILOT_MODELS entry has a display name', () => {
    for (const model of getAllCopilotModels()) {
      expect(COPILOT_DISPLAY_NAMES[model.id]).toBe(model.name)
    }
  })

  test('display-name map has no orphan entries', () => {
    for (const id of Object.keys(COPILOT_DISPLAY_NAMES)) {
      expect(COPILOT_MODELS[id], `Stale display name for ${id}`).toBeDefined()
    }
  })
})
