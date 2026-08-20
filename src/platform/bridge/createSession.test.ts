import { expect, test } from 'bun:test'
import { shouldRetryWithoutGitContext } from 'src/platform/bridge/createSession.ts'

// The 400 this guards against is the one the CCR server returns when the
// repository in session_context.sources is not visible to the account's
// Claude GitHub App — it fails the whole session creation, so Remote Control
// is unusable in any repo the app cannot see until the field is dropped.
test('a 400 on a body that carried git context is worth one retry without it', () => {
  expect(shouldRetryWithoutGitContext(400, true)).toBe(true)
})

test('a 400 without git context has nothing left to strip', () => {
  expect(shouldRetryWithoutGitContext(400, false)).toBe(false)
})

test('auth and not-found answers are not about the git context', () => {
  expect(shouldRetryWithoutGitContext(401, true)).toBe(false)
  expect(shouldRetryWithoutGitContext(403, true)).toBe(false)
  expect(shouldRetryWithoutGitContext(404, true)).toBe(false)
  expect(shouldRetryWithoutGitContext(429, true)).toBe(false)
})
