/**
 * Tests for Web Search Provider result count configurations.
 */

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'

// Colocated, so the providers are this file's own siblings. It used to live in
// `src/__tests__/` and walked back down (`'..', 'tools', 'WebSearchTool',
// 'providers'`) — a path assembled from segments, which neither tsc nor the
// build's pre-scan can see, so the move stayed green everywhere except here.
const file = (name: string) => Bun.file(resolve(import.meta.dir, name))

describe('Provider result counts', () => {
  const providers = [
    'bing.ts',
    'tavily.ts',
    'exa.ts',
    'firecrawl.ts',
    'mojeek.ts',
    'you.ts',
    'jina.ts',
    'duckduckgo.ts',
    // linkup.ts excluded — uses depth param, not a result count field
  ]

  for (const name of providers) {
    test(`${name} exists and is readable`, async () => {
      const f = file(name)
      expect(await f.exists()).toBe(true)
      const content = await f.text()
      expect(content.length).toBeGreaterThan(100)
    })
  }

  test('No provider hardcodes a limit below 10', async () => {
    const suspiciousPatterns = [
      /count['":\s]*['"]([1-9])['"]/i,
      /limit['":\s]*([1-9])\b/,
      /max_results['":\s]*([1-9])\b/,
      /numResults['":\s]*([1-9])\b/,
    ]

    for (const name of providers) {
      const content = await file(name).text()
      for (const pattern of suspiciousPatterns) {
        const match = content.match(pattern)
        if (match) {
          const num = parseInt(match[1], 10)
          expect(
            num,
            `${name} has suspiciously low result count: ${match[0]}`,
          ).toBeGreaterThanOrEqual(10)
        }
      }
    }
  })
})
