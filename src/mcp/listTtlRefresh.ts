/**
 * Re-reads the MCP lists whose TTL ran out, at the start of a user turn on
 * the main thread (useOnQuery). Which lists are due is listTtl.ts's call; this
 * reads them through the same fetchers connect and list_changed use, and
 * writes AppState only for a list whose entries changed — an unchanged tools
 * list must leave the pool's objects alone, or the next request rewrites the
 * cached prefix for nothing (cache.md §5).
 *
 * The turn waits at most LIST_TTL_REFRESH_BUDGET_MS. A read still running then
 * goes on and lands when it answers, as a list_changed refresh would; a read
 * that fails keeps the list AppState has and backs off (listTtl.ts).
 *
 * Sub-agents and headless `-p` do not refresh on TTL: a sub-agent reads the
 * fetchers' memo, which this refresh replaces, and a `-p` run is one turn.
 */
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchResourceTemplatesForClient,
  fetchSkillsForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import {
  dueLists,
  getListRecord,
  getListRecords,
  listKey,
  type ListTtlServer,
  markListRefreshFailed,
  type McpListKind,
} from 'src/mcp/client/listTtl.js'
import type { ConnectedMCPServer, MCPServerConnection } from 'src/mcp/types.js'
import { applyServerUpdate, type McpServerUpdate } from 'src/mcp/useManageMCPConnections.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import type { AppState } from 'src/terminal/state/AppState.js'

export const LIST_TTL_REFRESH_BUDGET_MS = 1500

type McpState = AppState['mcp']

export type ListTtlRefreshDeps = {
  getMcp: () => McpState
  /** Applied only when a list changed. */
  setMcp: (update: (mcp: McpState) => McpState) => void
  now?: () => number
  budgetMs?: number
}

type RefreshedLists = Pick<McpServerUpdate, 'tools' | 'commands' | 'resources'>

type ListRefresher = {
  read: (client: ConnectedMCPServer) => Promise<RefreshedLists>
  /** What else goes stale with the list, once it changed. */
  changed?: (client: ConnectedMCPServer) => void
}

const REFRESHERS: Readonly<Record<McpListKind, ListRefresher>> = {
  tools: {
    read: async client => {
      fetchToolsForClient.cache.delete(client.name)
      return { tools: await fetchToolsForClient(client) }
    },
  },
  prompts: {
    read: async client => {
      fetchCommandsForClient.cache.delete(client.name)
      // The server's skills share its slice of mcp.commands; they keep their memo.
      const [prompts, skills] = await Promise.all([fetchCommandsForClient(client), fetchSkillsForClient(client)])
      return { commands: [...prompts, ...skills] }
    },
  },
  resources: {
    read: async client => {
      fetchResourcesForClient.cache.delete(client.name)
      return { resources: await fetchResourcesForClient(client) }
    },
    changed: client => fetchResourceTemplatesForClient.cache.delete(client.name),
  },
}

// A read that outlived its turn's budget is not started again by the next turn.
const inFlight = new Set<string>()

function isConnected(client: MCPServerConnection): client is ConnectedMCPServer {
  return client.type === 'connected'
}

function ttlServer(client: ConnectedMCPServer): ListTtlServer {
  return {
    name: client.name,
    listChanged: {
      tools: client.capabilities?.tools?.listChanged === true,
      prompts: client.capabilities?.prompts?.listChanged === true,
      resources: client.capabilities?.resources?.listChanged === true,
    },
  }
}

async function refreshList(
  client: ConnectedMCPServer,
  kind: McpListKind,
  deps: ListTtlRefreshDeps,
  now: () => number,
): Promise<void> {
  const key = listKey(client.name, kind)
  inFlight.add(key)
  const before = getListRecord(client.name, kind)
  try {
    const refresher = REFRESHERS[kind]
    const lists = await refresher.read(client)
    const after = getListRecord(client.name, kind)
    // The fetchers answer a failed read with an empty list and record
    // nothing; the record not moving is the failure.
    if (after === before) {
      markListRefreshFailed(client.name, kind, now())
      logMCPDebug(client.name, `${kind} list refresh on TTL failed; keeping the list already loaded`)
      return
    }
    if (after?.hash === before?.hash) {
      logMCPDebug(client.name, `${kind} list refreshed on TTL, unchanged`)
      return
    }
    logMCPDebug(client.name, `${kind} list refreshed on TTL, changed`)
    refresher.changed?.(client)
    deps.setMcp(mcp => {
      // A reconnect in the meantime brought its own lists.
      const current = mcp.clients.find(c => c.name === client.name)
      return current === client ? applyServerUpdate(mcp, { ...client, ...lists }) : mcp
    })
  } catch (error) {
    markListRefreshFailed(client.name, kind, now())
    logMCPDebug(client.name, `${kind} list refresh on TTL failed: ${errorMessage(error)}`)
  } finally {
    inFlight.delete(key)
  }
}

/** Refreshes every due list; resolves when they are done or the budget ran out. */
export async function refreshExpiredMcpLists(deps: ListTtlRefreshDeps): Promise<void> {
  const now = deps.now ?? Date.now
  const clients = deps.getMcp().clients.filter(isConnected)
  const due = dueLists(now(), getListRecords(), clients.map(ttlServer)).filter(
    list => !inFlight.has(listKey(list.server, list.kind)),
  )
  if (due.length === 0) return

  const byName = new Map(clients.map(client => [client.name, client]))
  const work = Promise.all(due.map(list => refreshList(byName.get(list.server)!, list.kind, deps, now)))
  const budgetMs = deps.budgetMs ?? LIST_TTL_REFRESH_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>(resolve => {
    timer = setTimeout(resolve, budgetMs, 'expired')
  })
  try {
    if ((await Promise.race([work, expired])) === 'expired') {
      logMCPDebug('list-ttl', `List refresh still running after ${budgetMs}ms; the turn goes on without it`)
    }
  } finally {
    clearTimeout(timer)
  }
}
