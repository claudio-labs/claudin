import assert from 'node:assert/strict'
import test from 'node:test'

import { extractGitHubRepoSlug } from 'src/commands/install-github-app/repoSlug.ts'

test('keeps owner/repo input as-is', () => {
  assert.equal(extractGitHubRepoSlug('claudio-labs/claudin'), 'claudio-labs/claudin')
})

test('extracts slug from https GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('https://github.com/claudio-labs/claudin'),
    'claudio-labs/claudin',
  )
  assert.equal(
    extractGitHubRepoSlug('https://www.github.com/claudio-labs/claudin.git'),
    'claudio-labs/claudin',
  )
})

test('extracts slug from ssh GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('git@github.com:claudio-labs/claudin.git'),
    'claudio-labs/claudin',
  )
  assert.equal(
    extractGitHubRepoSlug('ssh://git@github.com/claudio-labs/claudin'),
    'claudio-labs/claudin',
  )
})

test('rejects malformed or non-GitHub URLs', () => {
  assert.equal(extractGitHubRepoSlug('https://gitlab.com/claudio-labs/claudin'), null)
  assert.equal(extractGitHubRepoSlug('https://github.com/claudio-labs'), null)
  assert.equal(extractGitHubRepoSlug('not actually github.com/claudio-labs/claudin'), null)
  assert.equal(
    extractGitHubRepoSlug('https://evil.example/?next=github.com/claudio-labs/claudin'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://github.com.evil.example/claudio-labs/claudin'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://example.com/github.com/claudio-labs/claudin'),
    null,
  )
})
