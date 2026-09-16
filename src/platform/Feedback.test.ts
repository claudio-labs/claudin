import { expect, test } from 'bun:test'

import { createGitHubIssueUrl } from 'src/platform/Feedback.tsx'

(globalThis as { MACRO?: { VERSION?: string } }).MACRO = { VERSION: '0.1.7' }

test('createGitHubIssueUrl builds a draft against this fork, not upstream', () => {
  // The constant behind this used to be empty, which silently disabled every
  // branch that offers the draft — the dialog reached its done screen with
  // nothing to open. An assertion on the host is what keeps that from
  // regressing into a dead end again.
  const url = createGitHubIssueUrl('Bug title', 'Bug description', [])

  expect(url.startsWith('https://github.com/claudio-labs/claudin/issues/new?')).toBe(true)
  expect(url).toContain('labels=user-reported,bug')
})

test('createGitHubIssueUrl carries the description and the error block', () => {
  const url = decodeURIComponent(
    createGitHubIssueUrl('Bug title', 'Bug description', []),
  )

  expect(url).toContain('Bug Description')
  expect(url).toContain('Bug description')
  expect(url).toContain('Errors')
  // No feedback ID any more: nothing is uploaded, so there is no id to join on.
  expect(url).not.toContain('Feedback ID:')
})

test('createGitHubIssueUrl redacts a secret pasted into the description', () => {
  const url = decodeURIComponent(
    createGitHubIssueUrl(
      'Bug title',
      'it fails with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in the config',
      [],
    ),
  )

  expect(url).not.toContain('sk-ant-api03')
  expect(url).toContain('[REDACTED_API_KEY]')
})
