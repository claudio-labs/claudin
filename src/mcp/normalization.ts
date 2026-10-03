
export const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * Returns true if the given MCP server name belongs to a claude.ai connector.
 */
export function isClaudeAIMcpServerName(name: string): boolean {
  return name.startsWith(CLAUDEAI_SERVER_PREFIX)
}

// No `u` flag on purpose: the match is per UTF-16 code unit, so each half of
// a surrogate pair is replaced on its own.
const OUTSIDE_API_ALPHABET = /[^0-9A-Za-z_-]/g

export function normalizeNameForMCP(name: string): string {
  const safe = name.replace(OUTSIDE_API_ALPHABET, '_')
  return isClaudeAIMcpServerName(name) ? squeezeUnderscores(safe) : safe
}

// Connector names must never carry `__`, which the qualified-name parser
// reads as the server/tool boundary.
function squeezeUnderscores(safe: string): string {
  return safe
    .split('_')
    .filter(segment => segment !== '')
    .join('_')
}
