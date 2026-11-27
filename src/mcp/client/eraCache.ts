/**
 * The protocol era each MCP server was last found to speak (negotiation.ts),
 * kept across sessions in `<config home>/mcp-era-cache.json` so a connect can
 * skip the `server/discover` probe.
 *
 * An entry is keyed by the server's name and a hash of the config fields that
 * decide who answers (transport, URL, headers, command, args, env, cwd): an
 * edited config is a server never seen. A write goes to a temp file renamed
 * over the cache, and writes in this process are serialized, so concurrent
 * connects do not lose each other's entries. Expired entries are dropped on
 * every write.
 *
 * Under `bun test` the cache is off — nothing is read or written — unless a
 * test points it at a directory with setEraCacheDirForTests, so a suite that
 * connects to a server never touches the developer's own config home.
 */
import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { DiscoverResult } from '@modelcontextprotocol/client'
import { z } from 'zod/v4'
import { isENOENT } from 'src/shared/errors.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { logMCPDebug } from 'src/shared/log.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { McpServerConfig } from 'src/mcp/types.js'
import { type EraVerdict, isVerdictFresh } from 'src/mcp/client/negotiation.js'

const CACHE_FILENAME = 'mcp-era-cache.json'

const VerdictSchema = z.union([
  z.object({
    kind: z.literal('modern'),
    discover: z.looseObject({
      supportedVersions: z.array(z.string()),
      capabilities: z.record(z.string(), z.unknown()),
    }),
    savedAt: z.number(),
    ttlMs: z.number(),
  }),
  z.object({ kind: z.literal('legacy'), savedAt: z.number(), ttlMs: z.number() }),
])

type CacheFile = Record<string, EraVerdict>

let testDir: string | undefined

/** @internal Points the cache at `dir` (a temp dir); undefined turns it back off under test. */
export function setEraCacheDirForTests(dir: string | undefined): void {
  testDir = dir
}

function cachePath(): string | undefined {
  if (testDir !== undefined) return join(testDir, CACHE_FILENAME)
  if (process.env.NODE_ENV === 'test') return undefined
  return join(getClaudinConfigHomeDir(), CACHE_FILENAME)
}

export function getEraCacheKey(name: string, config: McpServerConfig): string {
  const fields = {
    type: config.type ?? 'stdio',
    url: 'url' in config ? config.url : undefined,
    headers: 'headers' in config ? (config.headers ?? {}) : undefined,
    command: 'command' in config ? config.command : undefined,
    args: 'args' in config ? config.args : undefined,
    env: 'env' in config ? (config.env ?? {}) : undefined,
    cwd: 'cwd' in config ? config.cwd : undefined,
  }
  const hash = createHash('sha256').update(jsonStringify(fields)).digest('hex').substring(0, 16)
  return `${name}|${hash}`
}

async function readCacheFile(path: string): Promise<CacheFile> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (!isENOENT(error)) logMCPDebug('era-cache', `Ignoring an unreadable ${path}: ${error}`)
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries: CacheFile = {}
  for (const [key, value] of Object.entries(raw)) {
    const parsed = VerdictSchema.safeParse(value)
    if (!parsed.success) continue
    entries[key] =
      parsed.data.kind === 'modern'
        ? { ...parsed.data, discover: parsed.data.discover as DiscoverResult }
        : parsed.data
  }
  return entries
}

export async function readEraVerdict(key: string): Promise<EraVerdict | undefined> {
  const path = cachePath()
  if (path === undefined) return undefined
  return (await readCacheFile(path))[key]
}

let writeChain: Promise<void> = Promise.resolve()

function updateCache(edit: (entries: CacheFile) => void): Promise<void> {
  const path = cachePath()
  if (path === undefined) return Promise.resolve()
  const next = writeChain.then(async () => {
    const entries = await readCacheFile(path)
    edit(entries)
    const now = Date.now()
    for (const [key, verdict] of Object.entries(entries)) {
      if (!isVerdictFresh(verdict, now)) delete entries[key]
    }
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, jsonStringify(entries), 'utf8')
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  })
  // The cache only saves a probe: a failed write is logged and the next
  // connect probes again.
  writeChain = next.catch(error => {
    logMCPDebug('era-cache', `Failed to write ${path}: ${error}`)
  })
  return writeChain
}

export function saveEraVerdict(key: string, verdict: EraVerdict): Promise<void> {
  return updateCache(entries => {
    entries[key] = verdict
  })
}

export function dropEraVerdict(key: string): Promise<void> {
  return updateCache(entries => {
    delete entries[key]
  })
}
