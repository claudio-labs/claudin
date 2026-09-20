/**
 * OAuth for MCP servers: token storage, the browser authorization flow,
 * refresh and revocation.
 *
 * This file is a BARREL — the implementation lives in auth/: callbackParams
 * (the redirect's query string), oauthErrors (non-standard error bodies),
 * authFetch (the OAuth fetch + metadata discovery), serverKey (the credential
 * key), tokenRevocation, oauthFlow (the interactive flow), claudeAuthProvider
 * (the SDK's OAuthClientProvider) and clientSecretStore. Edit the sibling, not
 * this file.
 */

export {
  getFirstOAuthCallbackParam,
  redactSensitiveUrlParams,
  validateOAuthCallbackParams,
} from 'src/mcp/auth/callbackParams.js'
export {
  ClaudeAuthProvider,
  getScopeFromMetadata,
} from 'src/mcp/auth/claudeAuthProvider.js'
export {
  clearMcpClientConfig,
  readClientSecret,
  saveMcpClientSecret,
} from 'src/mcp/auth/clientSecretStore.js'
export { normalizeOAuthErrorBody } from 'src/mcp/auth/oauthErrors.js'
export {
  AuthenticationCancelledError,
  performMCPOAuthFlow,
  wrapFetchWithStepUpDetection,
} from 'src/mcp/auth/oauthFlow.js'
export {
  getServerKey,
  hasMcpDiscoveryButNoToken,
} from 'src/mcp/auth/serverKey.js'
export {
  clearServerTokensFromSecureStorage,
  revokeServerTokens,
} from 'src/mcp/auth/tokenRevocation.js'
