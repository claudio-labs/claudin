import { describe, expect, test } from 'bun:test'
import * as barrel from 'src/providers/shims/claude.js'

// Smoke regression: verify every re-exported symbol in the public barrel
// resolves to the expected runtime kind. Catches typos in the barrel and
// import cycles without depending on the broader provider suite.
describe('claude.ts barrel re-exports', () => {
  test('paramBuilders re-exports are functions', () => {
    expect(typeof barrel.addCacheBreakpoints).toBe('function')
    expect(typeof barrel.adjustParamsForNonStreaming).toBe('function')
    expect(typeof barrel.buildSystemPromptBlocks).toBe('function')
    expect(typeof barrel.configureTaskBudgetParams).toBe('function')
    expect(typeof barrel.detectLargeSystemPromptOnce).toBe('function')
    expect(typeof barrel.getCacheControl).toBe('function')
    expect(typeof barrel.getExtraBodyParams).toBe('function')
    expect(typeof barrel.getMaxOutputTokensForModel).toBe('function')
    expect(typeof barrel.getPromptCachingEnabled).toBe('function')
  })

  test('MAX_NON_STREAMING_TOKENS is a number', () => {
    expect(typeof barrel.MAX_NON_STREAMING_TOKENS).toBe('number')
    expect(barrel.MAX_NON_STREAMING_TOKENS).toBe(64_000)
  })

  test('metadata re-exports are functions', () => {
    expect(typeof barrel.getAPIMetadata).toBe('function')
    expect(typeof barrel.verifyApiKey).toBe('function')
  })

  test('messageConverters re-exports are functions', () => {
    expect(typeof barrel.assistantMessageToMessageParam).toBe('function')
    expect(typeof barrel.stripExcessMediaItems).toBe('function')
    expect(typeof barrel.userMessageToMessageParam).toBe('function')
  })

  test('streaming re-exports are functions', () => {
    expect(typeof barrel.accumulateUsage).toBe('function')
    expect(typeof barrel.cleanupStream).toBe('function')
    expect(typeof barrel.queryModelWithStreaming).toBe('function')
    expect(typeof barrel.updateUsage).toBe('function')
  })

  test('nonStreaming re-exports are functions', () => {
    expect(typeof barrel.queryModelWithoutStreaming).toBe('function')
  })

  test('convenience re-exports are functions', () => {
    expect(typeof barrel.queryHaiku).toBe('function')
    expect(typeof barrel.queryWithModel).toBe('function')
  })
})
