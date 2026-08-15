/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}

export function getClaudinUserAgent(): string {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'
  const agentSdk = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  return `claudin/${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (${entrypoint}${agentSdk}${clientApp})`
}
