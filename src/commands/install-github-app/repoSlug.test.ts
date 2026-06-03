import assert from 'node:assert/strict'
import test from 'node:test'

import { extractGitHubRepoSlug } from './repoSlug.ts'

test('keeps owner/repo input as-is', () => {
  assert.equal(extractGitHubRepoSlug('Gitlawb/claudin'), 'Gitlawb/claudin')
})

test('extracts slug from https GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('https://github.com/Gitlawb/claudin'),
    'Gitlawb/claudin',
  )
  assert.equal(
    extractGitHubRepoSlug('https://www.github.com/Gitlawb/claudin.git'),
    'Gitlawb/claudin',
  )
})

test('extracts slug from ssh GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('git@github.com:Gitlawb/claudin.git'),
    'Gitlawb/claudin',
  )
  assert.equal(
    extractGitHubRepoSlug('ssh://git@github.com/Gitlawb/claudin'),
    'Gitlawb/claudin',
  )
})

test('rejects malformed or non-GitHub URLs', () => {
  assert.equal(extractGitHubRepoSlug('https://gitlab.com/Gitlawb/claudin'), null)
  assert.equal(extractGitHubRepoSlug('https://github.com/Gitlawb'), null)
  assert.equal(extractGitHubRepoSlug('not actually github.com/Gitlawb/claudin'), null)
  assert.equal(
    extractGitHubRepoSlug('https://evil.example/?next=github.com/Gitlawb/claudin'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://github.com.evil.example/Gitlawb/claudin'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://example.com/github.com/Gitlawb/claudin'),
    null,
  )
})
