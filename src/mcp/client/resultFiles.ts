// Names of the files this unit writes under the session's tool-results
// directory. Each name is built from normalized parts, so a server or tool
// name cannot carry a path, and ends in a random part, so two writes in the
// same millisecond never share a file.
import { randomUUID } from 'crypto'
import { normalizeNameForMCP } from 'src/mcp/normalization.js'

export type ToolResultFileParts =
  | { kind: 'output'; server: string; tool: string }
  | { kind: 'blob'; server: string }

const RANDOM_LENGTH = 6

function randomPart(): string {
  return randomUUID().replaceAll('-', '').slice(0, RANDOM_LENGTH)
}

/** A file id (no extension) for an MCP result written to disk. */
export function toolResultFile(parts: ToolResultFileParts, now: number = Date.now()): string {
  const subject = parts.kind === 'output' ? normalizeNameForMCP(parts.tool) : 'blob'
  return `mcp-${normalizeNameForMCP(parts.server)}-${subject}-${now}-${randomPart()}`
}

const PATH_SEPARATOR_RE = /[\\/]/

/** An id is safe when joining it under a directory cannot leave that directory. */
export function isSafeFileId(id: string): boolean {
  return id !== '' && !PATH_SEPARATOR_RE.test(id) && !id.includes('..')
}
