import { unlinkSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

/** How long a server that asked for a login is left alone. */
const NEEDS_AUTH_TTL_MS = 15 * 60 * 1000
const CACHE_FILE_NAME = 'mcp-needs-auth-cache.json'

type NeedsAuthEntries = Record<string, { timestamp: number }>

function cacheFilePath(): string {
  return join(getClaudinConfigHomeDir(), CACHE_FILE_NAME)
}

function isEntry(value: unknown): value is { timestamp: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { timestamp?: unknown }).timestamp === 'number'
  )
}

/** The file's entries; a missing, unreadable or malformed file holds none. */
async function readEntriesFromDisk(): Promise<NeedsAuthEntries> {
  let parsed: unknown
  try {
    parsed = jsonParse(await readFile(cacheFilePath(), 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const entries: NeedsAuthEntries = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (isEntry(value)) entries[name] = { timestamp: value.timestamp }
  }
  return entries
}

/** Writes run one after another, so two of them cannot lose each other's entry. */
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Bumped by every clear. A write queued before a clear sees a newer
 * generation and does not bring the cleared entries back.
 */
let generation = 0

/** This process's view: loaded once, then kept current by every write. */
let known: Promise<NeedsAuthEntries> | null = null

function knownEntries(): Promise<NeedsAuthEntries> {
  known ??= readEntriesFromDisk()
  return known
}

export async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const entry = (await knownEntries())[serverId]
  return entry !== undefined && Date.now() - entry.timestamp < NEEDS_AUTH_TTL_MS
}

/**
 * Remembers that `serverId` needs a login. The entry counts in memory at once,
 * even if the file cannot be written (spec Finding 8).
 */
export function setMcpAuthCacheEntry(serverId: string): void {
  const entry = { timestamp: Date.now() }
  known = knownEntries().then(entries => ({ ...entries, [serverId]: entry }))
  const queuedIn = generation
  writeQueue = writeQueue
    .then(async () => {
      const path = cacheFilePath()
      const onDisk = await readEntriesFromDisk()
      await mkdir(dirname(path), { recursive: true })
      if (queuedIn !== generation) return
      await writeFile(path, jsonStringify({ ...onDisk, [serverId]: entry }))
    })
    .catch((error: unknown) => {
      logForDebugging(`MCP needs-auth cache: dropped a write: ${errorMessage(error)}`)
    })
}

/** Forgets every entry and deletes the file, before returning. */
export function clearMcpAuthCache(): void {
  generation += 1
  known = null
  try {
    unlinkSync(cacheFilePath())
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`MCP needs-auth cache: could not delete the file: ${errorMessage(error)}`)
    }
  }
}
