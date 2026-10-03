import { readFileSync } from 'fs'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, getErrnoCode } from 'src/shared/errors.js'

/** What reading an MCP JSON file gave, before any schema check. */
export type McpFileRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'malformed' }
  | { kind: 'parsed'; value: unknown }

const BYTE_ORDER_MARK = '\uFEFF'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decode(path: string, text: string): McpFileRead {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    logForDebugging(`MCP config ${path} is not JSON: ${errorMessage(error)}`)
    return { kind: 'malformed' }
  }
  // These literals parse, but they hold no config at all: report them the
  // way a syntax error is reported.
  if (value === null || value === false) return { kind: 'malformed' }
  return { kind: 'parsed', value }
}

export function readMcpFile(path: string): McpFileRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', reason: errorMessage(error) }
  }
  return decode(path, text)
}
