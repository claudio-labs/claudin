import { describe, expect, it } from 'bun:test'
import {
  getTokenizerConfig,
  getBytesPerTokenForModel,
  detectContentType,
  getCompressionRatio,
  estimateWithBounds,
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

describe('Content Type Detection', () => {
  describe('detectContentType', () => {
    it('detects JSON', () => {
      expect(detectContentType('{"key": "value"}')).toBe('json')
      expect(detectContentType('[1, 2, 3]')).toBe('json')
    })

    it('detects code', () => {
      expect(detectContentType('function test() { return 1 + 2; }')).toBe('code')
      expect(detectContentType('const x = () => {}')).toBe('code')
    })

    it('detects prose', () => {
      expect(detectContentType('This is a natural language response.')).toBe('prose')
      expect(detectContentType('Hello world how are you?')).toBe('prose')
    })

    it('detects code-like technical', () => {
      // Has both code chars and technical - higher code char ratio wins
      expect(detectContentType('margin: 10px; padding: 5px;')).toBe('code')
    })

    it('detects list', () => {
      expect(detectContentType('- item 1\n- item 2')).toBe('list')
      expect(detectContentType('1. first\n2. second')).toBe('list')
    })

    it('detects prose by default', () => {
      // Single column with newlines = prose
      expect(detectContentType('a b c\n1 2 3')).toBe('prose')
    })
  })
})

describe('Compression Ratio', () => {
  describe('getCompressionRatio', () => {
    it('returns appropriate ratios', () => {
      expect(getCompressionRatio('{"a":1}').ratio).toBe(2)
      expect(getCompressionRatio('code here {} []').ratio).toBe(3.5)
      expect(getCompressionRatio('Hello world').ratio).toBe(4)
    })
  })

  describe('estimateWithBounds', () => {
    it('returns estimate with bounds', () => {
      const result = estimateWithBounds('Hello world')
      
      expect(result.min).toBeLessThanOrEqual(result.estimate)
      expect(result.max).toBeGreaterThanOrEqual(result.estimate)
      expect(result.min).toBeLessThan(result.max)
    })

    it('handles JSON with tighter bounds', () => {
      const result = estimateWithBounds('{"key": "value"}')
      
      // JSON has smaller ratio range
      expect(result.max).toBeLessThan(10)
    })
  })
})