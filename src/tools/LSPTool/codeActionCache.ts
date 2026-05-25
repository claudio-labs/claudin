/**
 * Short-TTL cache for CodeAction objects returned by the LSP server.
 *
 * `LSPTool codeActions` lists actions; the agent picks one by title; then
 * `LSPTool applyCodeAction` resolves and applies it. Between those two
 * calls we need to keep the original CodeAction object so we can:
 *   1. Pass it back to `codeAction/resolve` if `edit` was lazy
 *   2. Recover the file path / kind / title
 *
 * Cache key is a synthetic `actionId` we return alongside each action in
 * the list. TTL is short (5 minutes) so stale references after a refactor
 * don't accumulate.
 */

import { randomUUID } from 'node:crypto'
import type { CodeAction } from 'vscode-languageserver-types'

const TTL_MS = 5 * 60 * 1000
const MAX_ENTRIES = 200

export type CachedCodeAction = {
  actionId: string
  action: CodeAction
  filePath: string
  /** Server name responsible for resolve/apply — needed for mutex routing. */
  serverName: string
  storedAt: number
}

const cache = new Map<string, CachedCodeAction>()

function evictExpired(now: number): void {
  for (const [id, entry] of cache) {
    if (now - entry.storedAt > TTL_MS) cache.delete(id)
  }
}

function evictOldestIfFull(): void {
  if (cache.size < MAX_ENTRIES) return
  // Map iteration order is insertion order — first entry is the oldest.
  const firstKey = cache.keys().next().value
  if (firstKey !== undefined) cache.delete(firstKey)
}

export function cacheCodeAction(
  action: CodeAction,
  filePath: string,
  serverName: string,
): string {
  const now = Date.now()
  evictExpired(now)
  evictOldestIfFull()
  const actionId = `ca_${randomUUID()}`
  cache.set(actionId, {
    actionId,
    action,
    filePath,
    serverName,
    storedAt: now,
  })
  return actionId
}

export function getCachedCodeAction(
  actionId: string,
): CachedCodeAction | undefined {
  const entry = cache.get(actionId)
  if (!entry) return undefined
  if (Date.now() - entry.storedAt > TTL_MS) {
    cache.delete(actionId)
    return undefined
  }
  return entry
}

/** Test-only. */
export function __resetCodeActionCacheForTests(): void {
  cache.clear()
}
