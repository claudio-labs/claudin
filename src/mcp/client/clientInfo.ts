import type { Implementation } from '@modelcontextprotocol/client'

/**
 * How Claudin introduces itself to every MCP server it connects to.
 *
 * `name` stays `claude-code` on purpose: a server may key behavior or an
 * allowlist on it, so it is a compatibility value. The description and the
 * site are Claudin's own.
 */
export function getMcpClientInfo(): Implementation {
  return {
    name: 'claude-code',
    title: 'Claudin',
    version: MACRO.VERSION ?? 'unknown',
    description: 'Claudin, an open-source coding agent',
    websiteUrl: 'https://claudiolabs.ai',
  }
}
