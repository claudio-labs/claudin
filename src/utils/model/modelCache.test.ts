import { describe, expect, it, beforeEach, afterEach, vi } from 'bun:test'
import { isModelCacheValid, getCachedModelsFromDisk, saveModelsToCache } from '../model/modelCache.js'

// Bun's `vi.mock` is process-global and leaks across parallel test files. A
// bare `{ isOllamaProvider }` mock would strip every other export from
// ollamaModels.js (e.g. getCachedOllamaModelOptions) and break sibling tests.
// Spread the real module so only isOllamaProvider is overridden. See team
// memory bun-test-global-config-isolation.md.
const realOllamaModels = await import('../model/ollamaModels.js')

vi.mock('../model/ollamaModels.js', () => ({
  ...realOllamaModels,
  isOllamaProvider: vi.fn(() => true),
}))

describe('modelCache', () => {
  const mockModel = { value: 'llama3', label: 'Llama 3', description: 'Test model' }

  describe('isModelCacheValid', () => {
    it('returns false for non-existent cache', async () => {
      const result = await isModelCacheValid('ollama')
      expect(result).toBe(false)
    })
  })

  describe('getCachedModelsFromDisk', () => {
    it('returns null when not cache available', async () => {
      const result = await getCachedModelsFromDisk()
      expect(result).toBeNull()
    })
  })

  describe('saveModelsToCache', () => {
    it('has saveModelsToCache function', () => {
      expect(typeof saveModelsToCache).toBe('function')
    })
  })
})