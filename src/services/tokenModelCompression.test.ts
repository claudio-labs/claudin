import { describe, expect, it } from 'bun:test'
import {
  getTokenizerConfig,
  getBytesPerTokenForModel,
} from './tokenEstimation.js'

describe('Model Tokenizers', () => {
  describe('getTokenizerConfig', () => {
    it('returns config for claude models', () => {
      const config = getTokenizerConfig('claude-sonnet-4-5-20250514')
      expect(config.modelFamily).toBe('claude')
      expect(config.bytesPerToken).toBe(3.5)
    })

    it('returns config for gpt models', () => {
      const config = getTokenizerConfig('gpt-4')
      expect(config.modelFamily).toBe('gpt-4')
      expect(config.bytesPerToken).toBe(4)
    })

    it('returns default for unknown models', () => {
      const config = getTokenizerConfig('unknown-model')
      expect(config.modelFamily).toBe('unknown')
      expect(config.bytesPerToken).toBe(4)
    })
  })

  describe('getBytesPerTokenForModel', () => {
    it('returns bytes per token for model', () => {
      expect(getBytesPerTokenForModel('claude-opus-3-5-20250214')).toBe(3.5)
      expect(getBytesPerTokenForModel('gpt-4o')).toBe(4)
      expect(getBytesPerTokenForModel('deepseek-chat')).toBe(3.5)
      expect(getBytesPerTokenForModel('minimax-M2.7')).toBe(3.2)
      // Regression: Gemini was 3.5 (under-estimating context by ~14%).
      // Official Google guidance is ~4 chars/token; empirical 4.2.
      expect(getBytesPerTokenForModel('gemini-2.0-flash')).toBe(4)
      expect(getBytesPerTokenForModel('gemini-2.5-pro')).toBe(4)
      // New families covered:
      expect(getBytesPerTokenForModel('mistral-large-2411')).toBe(3.8)
      expect(getBytesPerTokenForModel('devstral-latest')).toBe(3.8)
      expect(getBytesPerTokenForModel('qwen-coder-32b')).toBe(3.5)
      expect(getBytesPerTokenForModel('glm-4-9b')).toBe(3.5)
      expect(getBytesPerTokenForModel('kimi-for-coding')).toBe(3.5)
      expect(getBytesPerTokenForModel('kimi-k2.5')).toBe(3.5)
      expect(getBytesPerTokenForModel('moonshot-v1-8k')).toBe(3.5)
      // OpenRouter / multi-provider hubs:
      expect(getBytesPerTokenForModel('x-ai/grok-4')).toBe(4)
      expect(getBytesPerTokenForModel('cohere/command-r-plus')).toBe(4)
      expect(getBytesPerTokenForModel('google/gemma-3-27b')).toBe(4)
      expect(getBytesPerTokenForModel('microsoft/phi-4')).toBe(4)
    })
  })
})

