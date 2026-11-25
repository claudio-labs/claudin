import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A git pull that hits its timeout resolves while the fetch and index-pack it
// started may still be writing into the cache, so the rm that clears the stale
// directory retries instead of failing the refresh with ENOTEMPTY (found by
// the 2026-11-25 review round). cacheMarketplaceFromGit is not exported and
// the rest of its flow needs a remote, so the option is pinned on the source.
test('the stale marketplace directory is removed with retries', () => {
  const source = readFileSync(join(import.meta.dir, 'marketplaceManager.ts'), 'utf8')
  expect(source).toMatch(
    /await fs\.rm\(cachePath, \{ recursive: true, maxRetries: \d+ \}\)/,
  )
})
