// The words and the verdict behind an MCP server's connection state.
//
// Lifted out of MCPListPanel (`src/mcp/ui/MCPListPanel.tsx`) so the footer's MCP
// rows and the `/mcp` panel spell a server the same way — the same job
// `src/containers/format.ts` does between the Container tool and the container
// row.
//
// Pure on purpose: no React, no theme, no `figures`. The two surfaces pick their
// own glyph and colour because they deliberately disagree about `pending` — the
// panel greys it out as inactive, while the footer shows it amber, a row that is
// reconnecting being something the user may want to act on.

import type { MCPServerConnection } from 'src/mcp/types.js'

/**
 * The fields the wording actually reads. Narrower than `MCPServerConnection` so
 * a footer row — which keeps its own flattened copy rather than holding on to a
 * live client — can be passed straight in.
 */
export type McpStatusInput = {
  type: MCPServerConnection['type']
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

/** Which sub-group of the footer's MCP group a server belongs to. */
export type McpBucket = 'active' | 'inactive' | 'failed'

/**
 * `/mcp`'s wording, where `disabled` means "turned off in settings.json".
 */
export function mcpStatusText(input: McpStatusInput): string {
  switch (input.type) {
    case 'connected':
      return 'connected'
    case 'disabled':
      return 'disabled'
    case 'needs-auth':
      return 'needs authentication'
    case 'failed':
      return 'failed'
    case 'pending': {
      const { reconnectAttempt, maxReconnectAttempts } = input
      return reconnectAttempt && maxReconnectAttempts
        ? `reconnecting (${reconnectAttempt}/${maxReconnectAttempts})\u2026`
        : 'connecting\u2026'
    }
  }
}

/**
 * The footer's wording. Identical except for `disabled`: a server that was
 * already disabled when the session started never gets a row at all, so a row
 * that reached `disabled` was disconnected from the panel during this session —
 * and "disconnected" is what actually happened to it.
 */
export function mcpRowStatusText(input: McpStatusInput): string {
  return input.type === 'disabled' ? 'disconnected' : mcpStatusText(input)
}

/**
 * The sub-group a row belongs under, and — since the partition is the same one —
 * what its colour is derived from: active is green, inactive amber, failed red.
 *
 * `needs-auth` counts as inactive rather than failed: nothing is broken, the
 * server is waiting on the user. `disabled` is inactive for the reason above.
 */
export function mcpBucket(input: McpStatusInput): McpBucket {
  switch (input.type) {
    case 'connected':
      return 'active'
    case 'failed':
      return 'failed'
    case 'pending':
    case 'needs-auth':
    case 'disabled':
      return 'inactive'
  }
}
