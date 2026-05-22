// Barrel module for the MCP client subsystem.
//
// The historical monolith (3367 lines) was split into focused submodules
// under ./client/. This file preserves the public surface so callers across
// the codebase continue to import from 'src/services/mcp/client'.
//
// New code should prefer importing directly from the relevant submodule.
// Splitting layout:
//   errors.ts            — McpAuthError, McpToolCallError, isMcpSessionExpiredError
//   authCache.ts         — on-disk needs-auth cache
//   fetch.ts             — createClaudeAiProxyFetch, wrapFetchWithTimeout, batch sizes
//   transport.ts         — createTransport() per server type, ws client
//   connection.ts        — connectToServer, getServerCacheKey, cleanup, config compare
//   toolResult.ts        — transformResultContent/MCPResult, processMCPResult, schema
//   callTool.ts          — callMCPTool(WithUrlElicitationRetry), tool timeouts
//   fetchCapabilities.ts — fetch tools/resources/commands, getMcpToolsCommandsAndResources
//   ide.ts               — callIdeRpc
//   sdkClients.ts        — setupSdkMcpClients

export {
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  isMcpSessionExpiredError,
} from './client/errors.js'

export { clearMcpAuthCache } from './client/authCache.js'

export {
  createClaudeAiProxyFetch,
  wrapFetchWithTimeout,
  getMcpServerConnectionBatchSize,
} from './client/fetch.js'

export {
  cleanupFailedConnection,
  getServerCacheKey,
  connectToServer,
  clearServerCache,
  ensureConnectedClient,
  areMcpConfigsEqual,
} from './client/connection.js'

export {
  transformResultContent,
  inferCompactSchema,
  transformMCPResult,
  processMCPResult,
  type MCPResultType,
  type TransformedMCPResult,
} from './client/toolResult.js'

export { callMCPToolWithUrlElicitationRetry } from './client/callTool.js'

export {
  mcpToolInputToAutoClassifierInput,
  fetchToolsForClient,
  fetchResourcesForClient,
  fetchCommandsForClient,
  reconnectMcpServerImpl,
  getMcpToolsCommandsAndResources,
  prefetchAllMcpResources,
} from './client/fetchCapabilities.js'

export { callIdeRpc } from './client/ide.js'

export { setupSdkMcpClients } from './client/sdkClients.js'
