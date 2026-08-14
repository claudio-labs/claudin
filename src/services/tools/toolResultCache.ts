/**
 * Local LRU cache for read-only tool results.
 *
 * Goal: cut redundant disk IO and tool execution latency in long sessions
 * (Read/Glob/Grep/LSP repeated on unchanged state). This is NOT a token
 * optimization — tool_results still flow to the model. Anthropic-native
 * providers already dedupe byte-identical tool_results via prompt caching;
 * implicit-prefix providers (OpenAI/DeepSeek/Codex/Gemini) cache full
 * prefix bytes; Ollama/self-hosted have no server-side cache. This module
 * targets latency + IO across all of them.
 *
 * Whitelisted by tool.name (not by isReadOnly) because tools like
 * AskUserQuestion / EnterPlanMode / AgentTool are isReadOnly=true but
 * have UI/spawn side effects that must not be replayed.
 */

import { LRUCache } from 'lru-cache'
import { statSync } from 'fs'
import { normalize } from 'path'
import { stableStringify } from 'src/utils/stableStringify'

export type ToolResultCacheEntry = {
  data: unknown
  mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }
  storedAt: number
  paths: string[]
  sizeBytes: number
}

export type ToolResultCacheStats = {
  hits: number
  misses: number
  evictions: number
  bytesStored: number
}

const MAX_ENTRIES = 500
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB total

const TTL_MS: Record<string, number> = {
  Read: 60_000,
  Glob: 30_000,
  Grep: 30_000,
  LSP: 15_000,
}

export const CACHE_WHITELIST: ReadonlySet<string> = new Set(Object.keys(TTL_MS))

export function isCacheableTool(toolName: string): boolean {
  return CACHE_WHITELIST.has(toolName)
}

export function isCacheDisabled(): boolean {
  return process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE === '1'
}

const counters = {
  hits: 0,
  misses: 0,
  evictions: 0,
}

const cache = new LRUCache<string, ToolResultCacheEntry>({
  max: MAX_ENTRIES,
  maxSize: MAX_BYTES,
  sizeCalculation: e => Math.max(1, e.sizeBytes),
  dispose: () => {
    counters.evictions++
  },
})

function makeKey(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`
}

function pathsFromInput(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  switch (toolName) {
    case 'Read':
      return typeof o.file_path === 'string' ? [normalize(o.file_path)] : []
    case 'LSP':
      return typeof o.filePath === 'string' ? [normalize(o.filePath)] : []
    case 'Glob':
    case 'Grep':
      return typeof o.path === 'string' ? [normalize(o.path)] : []
    default:
      return []
  }
}

function isFreshOnDisk(toolName: string, paths: string[], storedAt: number): boolean {
  if (toolName !== 'Read') return true
  const target = paths[0]
  if (!target) return true
  try {
    // mtimeMs can carry sub-millisecond fractions while storedAt (Date.now())
    // is an integer. Floor so a file written in the same ms as setCached
    // is still considered fresh.
    const mtime = Math.floor(statSync(target).mtimeMs)
    return mtime <= storedAt
  } catch {
    return false
  }
}

export function getCached(
  toolName: string,
  input: unknown,
): ToolResultCacheEntry | undefined {
  const key = makeKey(toolName, input)
  const entry = cache.get(key)
  if (!entry) {
    counters.misses++
    return undefined
  }
  if (!isFreshOnDisk(toolName, entry.paths, entry.storedAt)) {
    cache.delete(key)
    counters.misses++
    return undefined
  }
  counters.hits++
  return entry
}

export function setCached(
  toolName: string,
  input: unknown,
  data: unknown,
  mcpMeta?: ToolResultCacheEntry['mcpMeta'],
): void {
  const key = makeKey(toolName, input)
  let sizeBytes = 1
  try {
    sizeBytes = Math.max(1, Buffer.byteLength(stableStringify(data)))
  } catch {
    sizeBytes = 1
  }
  const entry: ToolResultCacheEntry = {
    data,
    mcpMeta,
    storedAt: Date.now(),
    paths: pathsFromInput(toolName, input),
    sizeBytes,
  }
  const ttl = TTL_MS[toolName]
  cache.set(key, entry, ttl ? { ttl } : undefined)
}

export function invalidateForPath(absPath: string): number {
  const target = normalize(absPath)
  // Collect keys first; mutating the LRU cache while iterating it can
  // corrupt the iterator and accidentally evict unrelated entries.
  const toDelete: string[] = []
  for (const [key, entry] of cache.entries()) {
    if (
      entry.paths.some(p => p === target || p.startsWith(`${target}/`) || target.startsWith(`${p}/`))
    ) {
      toDelete.push(key)
    }
  }
  for (const key of toDelete) cache.delete(key)
  return toDelete.length
}

export function invalidateAll(): number {
  const n = cache.size
  cache.clear()
  return n
}

export function getStats(): ToolResultCacheStats {
  return {
    hits: counters.hits,
    misses: counters.misses,
    evictions: counters.evictions,
    bytesStored: cache.calculatedSize,
  }
}

/** Test-only: reset cache + counters. Not exported through index. */
export function __resetForTests(): void {
  cache.clear()
  counters.hits = 0
  counters.misses = 0
  counters.evictions = 0
}
