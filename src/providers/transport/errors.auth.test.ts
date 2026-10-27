import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  getAssistantMessageFromError,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
} from 'src/providers/transport/errors.js'

// What @anthropic-ai/sdk throws before sending when the client has no
// credential. 0.x named "X-Api-Key" in it; 1.x names only "Authorization".
const SDK_NO_CREDENTIAL_0X =
  'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted'
const SDK_NO_CREDENTIAL_1X =
  'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for the "Authorization" header to be explicitly omitted'
const SERVER_INVALID_KEY =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'

// Under NODE_ENV=test the key lookup behind the message throws without a credential.
const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
})
afterEach(() => {
  if (savedOAuthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken
})

function getFirstText(message: ReturnType<typeof getAssistantMessageFromError>): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

test.each([
  ['the SDK 0.x missing-credential error', SDK_NO_CREDENTIAL_0X],
  ['the SDK 1.x missing-credential error', SDK_NO_CREDENTIAL_1X],
  ['the server rejecting the key', SERVER_INVALID_KEY],
])('%s asks the user to log in', (_name, text) => {
  const message = getAssistantMessageFromError(new Error(text), 'claude-sonnet-4-6')

  expect(message.error).toBe('authentication_failed')
  expect([INVALID_API_KEY_ERROR_MESSAGE, INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL]).toContain(
    getFirstText(message),
  )
})
