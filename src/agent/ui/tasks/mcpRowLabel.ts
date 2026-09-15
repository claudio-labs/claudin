// The one-line label for an MCP server row in the footer tree.
//
// Split into a glyph and a body on purpose. The tree paints each row as a
// single `<Text>`, and a coloured status glyph has to be a NESTED `<Text>`
// inside that one — a sibling would become an independently wrapping column
// (see .claudin/rules/ink-tui.md §10). So the tree takes the two halves and
// nests them, while the background-tasks dialog, which wants a plain string,
// takes `mcpRowLabel()` and gets the glyph uncoloured. The figure set is chosen
// so that shape alone still separates the states without any colour.

import figures from 'figures'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import { mcpTaskStatusInput } from 'src/agent/tasks/McpServerTask/types.js'
import { mcpBucket, mcpRowStatusText } from 'src/mcp/serverStatus.js'
import { plural } from 'src/shared/text/stringUtils.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'

const SEP = ' · '

/** How much of a failure message the row carries. The tree truncates to the
 * terminal width anyway; this is the cap that keeps a stack trace from pushing
 * the server's own name out of a narrow one. */
const ERROR_CHARS = 60

/** Theme colour names, so the caller can hand one straight to `<Text color>`. */
export type McpRowTone = 'success' | 'warning' | 'error'

/**
 * The status glyph. Same figure set the `/mcp` panel uses
 * (`src/mcp/ui/MCPListPanel.tsx`), so the two surfaces spell a state the same
 * way — including `needs-auth`, which gets its own shape rather than sharing
 * the idle one.
 */
export function mcpRowGlyph(task: DeepImmutable<McpServerTaskState>): string {
  switch (task.connectionType) {
    case 'connected':
      return figures.tick
    case 'failed':
      return figures.cross
    case 'needs-auth':
      return figures.triangleUpOutline
    case 'pending':
    case 'disabled':
      return figures.radioOff
  }
}

/**
 * The glyph's colour: green connected, amber anything waiting, red failed.
 *
 * Deliberately NOT the `/mcp` panel's mapping, which greys `pending` out as
 * inactive. In a footer the question is "does this need me?", and a server
 * stuck reconnecting does — so it gets the same amber as one waiting for a
 * login.
 */
export function mcpRowTone(task: DeepImmutable<McpServerTaskState>): McpRowTone {
  switch (mcpBucket(mcpTaskStatusInput(task))) {
    case 'active':
      return 'success'
    case 'inactive':
      return 'warning'
    case 'failed':
      return 'error'
  }
}

/** What the server contributes, when it contributes anything. Resources only
 * get a mention when there are no tools — a server is overwhelmingly its tools,
 * and printing both makes the common row twice as long for nothing. */
function contribution(task: DeepImmutable<McpServerTaskState>): string | null {
  if (task.connectionType !== 'connected') return null
  if (task.toolCount > 0) {
    return `${task.toolCount} ${plural(task.toolCount, 'tool')}`
  }
  if (task.resourceCount > 0) {
    return `${task.resourceCount} ${plural(task.resourceCount, 'resource')}`
  }
  return null
}

/** The row without its glyph: name, state, and whichever of the two details the
 * state makes worth saying. */
export function mcpRowBody(task: DeepImmutable<McpServerTaskState>): string {
  const parts = [task.serverName, mcpRowStatusText(mcpTaskStatusInput(task))]
  const extra = contribution(task)
  if (extra) parts.push(extra)
  if (task.connectionType === 'failed' && task.error) {
    // First line only: a failure message is often a whole stack, and every row
    // after this one would be painted over by the rest of it.
    const firstLine = task.error.split('\n')[0]?.trim() ?? ''
    if (firstLine !== '') {
      parts.push(
        firstLine.length > ERROR_CHARS
          ? `${firstLine.slice(0, ERROR_CHARS)}…`
          : firstLine,
      )
    }
  }
  return parts.join(SEP)
}

/** Glyph and body as one string, for the surfaces that cannot nest a `<Text>`. */
export function mcpRowLabel(task: DeepImmutable<McpServerTaskState>): string {
  return `${mcpRowGlyph(task)} ${mcpRowBody(task)}`
}
