import { chmod, open, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { isRecord, readMcpFile } from 'src/mcp/config/jsonFile.js'
import { parseMcpConfig } from 'src/mcp/config/parse.js'

/**
 * `.mcp.json` as it sits on disk, for editing. Entries are kept raw, before
 * expansion and validation, so a rewrite never bakes a `${TOKEN}` into the
 * file, and keys beside `mcpServers` survive.
 */
export type ProjectFileState =
  | { kind: 'usable'; document: Record<string, unknown>; servers: Record<string, unknown> }
  | { kind: 'broken'; problem: string }

const NEW_FILE_MODE = 0o644
const PERMISSION_BITS = 0o7777

export function projectFilePath(): string {
  return join(getCwd(), '.mcp.json')
}

export function loadProjectFile(path: string): ProjectFileState {
  const read = readMcpFile(path)
  switch (read.kind) {
    case 'missing':
      return { kind: 'usable', document: {}, servers: {} }
    case 'unreadable':
      return { kind: 'broken', problem: read.reason }
    case 'malformed':
      return { kind: 'broken', problem: 'it is not valid JSON' }
    case 'parsed':
      break
  }
  const check = parseMcpConfig({ configObject: read.value, expandVars: false, scope: 'project', filePath: path })
  const { value } = read
  if (!check.config || !isRecord(value) || !isRecord(value.mcpServers)) {
    const where = check.errors.map(error => error.path || '(root)').join(', ')
    return { kind: 'broken', problem: `it does not match the MCP config schema at ${where}` }
  }
  return { kind: 'usable', document: value, servers: value.mcpServers }
}

async function currentMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & PERMISSION_BITS
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function discard(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') logError(error)
  }
}

/**
 * Writes through a flushed sibling file renamed over the target, so a reader
 * never sees half a file. A new file gets 0644 less the umask; an existing
 * one keeps its exact mode. A symlink is replaced, and its target left alone.
 */
export async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const mode = await currentMode(path)
  const staging = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await open(staging, 'wx', mode ?? NEW_FILE_MODE)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (mode !== undefined) await chmod(staging, mode)
    await rename(staging, path)
  } catch (error) {
    await discard(staging)
    throw error
  }
}

export async function saveProjectFile(
  path: string,
  document: Record<string, unknown>,
  servers: Record<string, unknown>,
): Promise<void> {
  await writeFileAtomically(path, jsonStringify({ ...document, mcpServers: servers }, null, 2))
}
