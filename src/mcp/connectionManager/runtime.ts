import { reconnectMcpServerImpl } from 'src/mcp/client.js'
import { isLocalMcpServer } from 'src/mcp/client/connection.js'
import { isMcpServerDisabled } from 'src/mcp/config.js'
import { registerElicitationHandler } from 'src/mcp/elicitationHandler.js'
import { isSessionDisconnected } from 'src/mcp/sessionDisconnects.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { logMCPDebug } from 'src/shared/log.js'
import type { AppState, AppStateStore } from 'src/terminal/state/AppState.js'
import { createBatcher } from 'src/mcp/connectionManager/batcher.js'
import { followListChanges } from 'src/mcp/connectionManager/listRefresh.js'
import { applyServerUpdate } from 'src/mcp/connectionManager/poolUpdate.js'
import { createRedialer, type Redialer, type Wait } from 'src/mcp/connectionManager/redial.js'
import type { ConnectionResult, RedialSchedule, ServerUpdate } from 'src/mcp/connectionManager/types.js'

/** Read from disk and from the session set, never from app state, which lags. */
export function isServerOff(name: string): boolean {
  return isMcpServerDisabled(name) || isSessionDisconnected(name)
}

/**
 * A connected result says everything about its lists, so a missing resource
 * list means none; the client leaves it out when it is empty.
 */
export function updateFrom(result: ConnectionResult): ServerUpdate {
  const resources = result.client.type === 'connected' ? (result.resources ?? []) : result.resources
  return { ...result.client, tools: result.tools, commands: result.commands, resources }
}

type RuntimeDeps = {
  dial: (name: string, config: ScopedMcpServerConfig) => Promise<ConnectionResult>
  schedule?: RedialSchedule
  wait?: Wait
}

/** Everything one mounted manager owns outside React. */
export type ConnectionRuntime = {
  store: AppStateStore
  redial: Redialer
  dial: (name: string, config: ScopedMcpServerConfig) => Promise<ConnectionResult>
  /** Puts a dial result in app state, and watches the connection if there is one. */
  adopt: (result: ConnectionResult) => void
  report: (update: ServerUpdate) => void
  /** Forgets the server's live connection, so closing it starts nothing. */
  retire: (name: string) => void
  /** Applies the updates still waiting for their batch. */
  flush: () => void
  isDisposed: () => boolean
  dispose: () => void
}

export function createConnectionRuntime(
  store: AppStateStore,
  deps: RuntimeDeps = { dial: reconnectMcpServerImpl },
): ConnectionRuntime {
  let disposed = false
  /** The connection each server's close handler answers for. */
  const live = new Map<string, ConnectedMCPServer>()
  const watched = new WeakSet<object>()

  const batcher = createBatcher<ServerUpdate>(updates =>
    store.setState(prev => ({
      ...prev,
      mcp: updates.reduce(applyServerUpdate, prev.mcp),
    })),
  )
  const report = (update: ServerUpdate) => batcher.push(update)

  const adopt = (result: ConnectionResult) => {
    if (disposed) return
    if (result.client.type === 'connected') watch(result.client)
    report(updateFrom(result))
  }

  const redial = createRedialer({
    dial: deps.dial,
    shouldStop: isServerOff,
    report,
    settle: adopt,
    schedule: deps.schedule,
    wait: deps.wait,
  })

  /** `forget` drops the dead connection from the client's caches. */
  const onClosed = (server: ConnectedMCPServer, forget: () => void) => {
    if (live.get(server.name)?.client !== server.client) return
    live.delete(server.name)
    const { name, config } = server
    if (isServerOff(name)) {
      forget()
      report({ name, type: 'disabled', config })
      return
    }
    if (isLocalMcpServer(config)) {
      logMCPDebug(name, 'Local server closed; not respawning it')
      forget()
      report({ name, type: 'failed', config, error: 'Connection closed' })
      return
    }
    // Still cached, the dead connection is what the redial closes first,
    // instead of opening a throw-away session in order to close it.
    logMCPDebug(name, 'Connection closed; redialling')
    void redial.start(name, config)
  }

  function watch(server: ConnectedMCPServer) {
    live.set(server.name, server)
    // Every dial of a cached connection hands it back. Wrapping it twice
    // would put this runtime's handler where the client's own should be.
    if (watched.has(server.client)) return
    watched.add(server.client)
    // The client's own handler only clears its caches; onClosed decides when.
    const clientOwn = server.client.onclose
    const forget = () => clientOwn?.()
    server.client.onclose = () => {
      if (disposed) forget()
      else onClosed(server, forget)
    }
    followListChanges(server, { isCurrent: () => live.get(server.name)?.client === server.client, report })
    const setAppState = (update: (prev: AppState) => AppState) => store.setState(update)
    registerElicitationHandler(server.client, server.name, setAppState)
  }

  return {
    store,
    redial,
    dial: deps.dial,
    adopt,
    report,
    retire: name => {
      live.delete(name)
    },
    flush: batcher.flush,
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) return
      disposed = true
      redial.cancelAll()
      batcher.dispose()
      live.clear()
    },
  }
}
