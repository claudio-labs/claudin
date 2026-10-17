import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { historyRedactions, renderMessagesForAPI } from 'src/providers/shims/claude/renderMessages.js'
import type { Message } from 'src/shared/types/message.js'

const CODEX_OAUTH: ProviderProfile = {
  id: 'render-codex',
  name: 'Codex OAuth',
  provider: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'codexplan',
}
const ANTHROPIC: ProviderProfile = {
  id: 'render-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
}
const originalSwitch = process.env.CLAUDIN_CODEX_REASONING_REPLAY

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  _resetCacheProfileForTesting()
}

afterEach(() => {
  if (originalSwitch === undefined) delete process.env.CLAUDIN_CODEX_REASONING_REPLAY
  else process.env.CLAUDIN_CODEX_REASONING_REPLAY = originalSwitch
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

const REASONING = { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } }
const TEXT = { type: 'text', text: 'Reading.', citations: [], codex: { id: 'msg_1', phase: 'commentary' } }

function codexHistory(): Message[] {
  return [
    createUserMessage({ content: 'hi' }),
    createAssistantMessage({ content: [REASONING, TEXT] as never }),
    createUserMessage({ content: 'more' }),
  ]
}

function assistantBlocks(redactCodexItems: boolean): unknown[] {
  const { messages } = renderMessagesForAPI(codexHistory(), [], {
    useToolSearch: false,
    advisor: false,
    stripOldThinking: false,
    stripOldNarration: false,
    redactCodexItems,
  })
  return messages.find(m => m.type === 'assistant')!.message.content as unknown[]
}

describe('the Codex item redaction in the render', () => {
  test('on: the reasoning block goes and the text block loses its state', () => {
    expect(assistantBlocks(true)).toEqual([{ type: 'text', text: 'Reading.', citations: [] }])
  })

  test('off: both blocks go out as stored', () => {
    expect(assistantBlocks(false)).toEqual([REASONING, TEXT])
  })
})

describe('historyRedactions decides it by the backend the session talks to', () => {
  test('a Codex OAuth session keeps its item state', () => {
    useProfile(CODEX_OAUTH)
    expect(historyRedactions().redactCodexItems).toBe(false)
  })

  test('so does a Codex backend profile whose model is not an alias', () => {
    useProfile({ ...CODEX_OAUTH, id: 'render-codex-model', model: 'gpt-5.6-terra' })
    expect(historyRedactions().redactCodexItems).toBe(false)
  })

  test('every other provider, and Codex with the killswitch off, redact it', () => {
    useProfile(ANTHROPIC)
    expect(historyRedactions().redactCodexItems).toBe(true)
    useProfile(CODEX_OAUTH)
    process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
    expect(historyRedactions().redactCodexItems).toBe(true)
  })

  test('with no profile at all, it is redacted', () => {
    expect(historyRedactions().redactCodexItems).toBe(true)
  })
})
