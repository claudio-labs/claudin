/**
 * The MCP resources that changed after the model read them, waiting to be
 * told. A read (ReadMcpResource, or an @-mention) records which thread read a
 * resource; a `notifications/resources/updated` for it then queues one notice
 * for the main thread and one for each sub-agent that read it itself, and the
 * next request of that thread carries them as an `mcp_resource_changed`
 * attachment. Only the fact is told, never the content: the model reads the
 * resource again if it needs it.
 *
 * Who is told:
 * - the main thread, of every resource read in the session by any thread —
 *   a sub-agent's report rests on what it read;
 * - a sub-agent, only of what it read itself;
 * - nobody, for a read by a sub-agent whose definition strips re-injected
 *   context (`omitClaudeMd`: Plan, WebResearcher), which is not recorded.
 *
 * A notice for a resource nobody read in this session (a URI the server
 * names that was never read, or anything after /clear) is dropped. Pending
 * notices are deduplicated per (server, uri) and keep their arrival order.
 * Kept in memory only: the attachment renders from its own payload, so a
 * resumed session re-sends the bytes it sent, and a new process starts with
 * no subscriptions to be told about.
 */
import type { ToolUseContext } from 'src/tools/Tool.js'

export type McpResourceChange = { server: string; uri: string }

/** The thread key of the main conversation; a sub-agent's is its agentId. */
export const MAIN_THREAD = 'main'

export function resourceNoticeThread(
  context: Pick<ToolUseContext, 'agentId' | 'omitClaudeMdAttachments'>,
): string | undefined {
  if (!context.agentId) return MAIN_THREAD
  return context.omitClaudeMdAttachments === true ? undefined : context.agentId
}

function keyOf(change: McpResourceChange): string {
  return JSON.stringify([change.server, change.uri])
}

export class McpResourceChanges {
  /** Resource key → the resource and the threads that read it. */
  private readonly readers = new Map<string, { change: McpResourceChange; threads: Set<string> }>()
  /** Thread → its pending notices, by resource key, in arrival order. */
  private readonly pending = new Map<string, Map<string, McpResourceChange>>()

  noteRead(thread: string, change: McpResourceChange): void {
    const key = keyOf(change)
    const entry = this.readers.get(key) ?? { change: { server: change.server, uri: change.uri }, threads: new Set() }
    entry.threads.add(thread)
    this.readers.set(key, entry)
  }

  /** The resource is no longer subscribed: later notices for it are dropped. */
  forget(change: McpResourceChange): void {
    this.readers.delete(keyOf(change))
  }

  /** The URIs of `server` read in this conversation and still watched, oldest first. */
  watchedUris(server: string): string[] {
    return [...this.readers.values()].filter(({ change }) => change.server === server).map(({ change }) => change.uri)
  }

  record(change: McpResourceChange): void {
    const key = keyOf(change)
    const threads = this.readers.get(key)?.threads
    if (!threads) return
    for (const thread of new Set([MAIN_THREAD, ...threads])) {
      const queue = this.pending.get(thread) ?? new Map<string, McpResourceChange>()
      if (!queue.has(key)) queue.set(key, { server: change.server, uri: change.uri })
      this.pending.set(thread, queue)
    }
  }

  /** The thread's pending notices, oldest first; they are not handed out again. */
  take(thread: string): McpResourceChange[] {
    const queue = this.pending.get(thread)
    if (!queue) return []
    this.pending.delete(thread)
    return [...queue.values()]
  }

  /** A new conversation (/clear, a resume): what the old one read is forgotten. */
  clear(preservedThreads: ReadonlySet<string> = new Set()): void {
    for (const [key, { threads }] of this.readers) {
      for (const thread of threads) if (!preservedThreads.has(thread)) threads.delete(thread)
      if (threads.size === 0) this.readers.delete(key)
    }
    for (const thread of [...this.pending.keys()]) {
      if (!preservedThreads.has(thread)) this.pending.delete(thread)
    }
  }
}

const sessionChanges = new McpResourceChanges()

export function getMcpResourceChanges(): McpResourceChanges {
  return sessionChanges
}

export function renderMcpResourceChanges(changes: readonly McpResourceChange[]): string {
  return changes
    .map(
      ({ server, uri }) =>
        `The MCP resource ${uri} on server "${server}" changed since you read it. Read it again if you need its current content.`,
    )
    .join('\n')
}
