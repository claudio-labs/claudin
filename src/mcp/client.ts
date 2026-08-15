// Barrel module for the MCP client subsystem.
//
// The historical monolith (3367 lines) was split into focused submodules
// under ./client/. This file preserves the public surface so callers across
// the codebase continue to import from 'src/mcp/client'.
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
} from 'src/mcp/client/errors.js'

export { clearMcpAuthCache } from 'src/mcp/client/authCache.js'

export {
  createClaudeAiProxyFetch,
  wrapFetchWithTimeout,
  getMcpServerConnectionBatchSize,
} from 'src/mcp/client/fetch.js'

export {
  cleanupFailedConnection,
  getServerCacheKey,
  connectToServer,
  clearServerCache,
  ensureConnectedClient,
  areMcpConfigsEqual,
} from 'src/mcp/client/connection.js'

export {
  transformResultContent,
  inferCompactSchema,
  transformMCPResult,
  processMCPResult,
  type MCPResultType,
  type TransformedMCPResult,
} from 'src/mcp/client/toolResult.js'

export { callMCPToolWithUrlElicitationRetry } from 'src/mcp/client/callTool.js'

export {
  mcpToolInputToAutoClassifierInput,
  fetchToolsForClient,
  fetchResourcesForClient,
  fetchCommandsForClient,
  reconnectMcpServerImpl,
  getMcpToolsCommandsAndResources,
  prefetchAllMcpResources,
} from 'src/mcp/client/fetchCapabilities.js'

export { callIdeRpc } from 'src/mcp/client/ide.js'

export { setupSdkMcpClients } from 'src/mcp/client/sdkClients.js'
