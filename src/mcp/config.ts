// Which MCP servers a session knows about, from every scope. Callers import
// this path (and tests mock it), so it stays the one entry point; the work
// lives in src/mcp/config/.
export { dedupClaudeAiMcpServers, dedupPluginMcpServers, getMcpServerSignature, unwrapCcrProxyUrl } from 'src/mcp/config/dedup.js'
export { getAllMcpConfigs, getClaudeCodeMcpConfigs } from 'src/mcp/config/merge.js'
export { parseMcpConfig, parseMcpConfigFromFilePath } from 'src/mcp/config/parse.js'
export { filterMcpServersByPolicy, shouldAllowManagedMcpServersOnly } from 'src/mcp/config/policySettings.js'
export {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  getEnterpriseMcpFilePath,
  getMcpConfigByName,
  getMcpConfigsByScope,
  getProjectMcpConfigsFromCwd,
} from 'src/mcp/config/scopes.js'
export { isMcpServerDisabled, setMcpServerEnabled } from 'src/mcp/config/toggles.js'
export { addMcpConfig, removeMcpConfig } from 'src/mcp/config/write.js'
