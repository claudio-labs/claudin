/**
 * Values for an MCP prompt's arguments while the user types them, through the
 * server's `completion/complete` (same request in both protocol eras). A
 * server that does not declare `completions` gets no request at all.
 *
 * The prompt input asks on a debounce, and one keystroke can re-ask for the
 * same slot, so identical requests share one round trip while in flight and a
 * small cache answers repeats. The cache lives as long as this completer,
 * which is one connection's command list: a reconnect re-lists the prompts and
 * starts empty. Failures are not cached, and never reach the UI as anything
 * but "no values".
 */
import { recursivelySanitizeUnicode } from 'src/shared/data/sanitization.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import type { PromptArgumentValues } from 'src/shared/types/command.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'

const CACHE_SIZE = 64
const REQUEST_TIMEOUT_MS = 5000
// The spec caps a response at 100 values
const MAX_VALUES = 100
// A value is inserted into the one-line prompt input; an empty one offers nothing
const LINE_BREAK_RE = /[\r\n]/

type ResolveConnection = (
  connection: ConnectedMCPServer,
) => Promise<ConnectedMCPServer>

export function createPromptArgumentCompleter(
  connection: ConnectedMCPServer,
  promptName: string,
  resolveConnection: ResolveConnection = async current => current,
): PromptArgumentValues {
  const cache = new Map<string, string[]>()
  const inFlight = new Map<string, Promise<string[]>>()

  async function request(
    argName: string,
    partial: string,
    filledArgs: Readonly<Record<string, string>>,
  ): Promise<string[] | undefined> {
    try {
      const current = await resolveConnection(connection)
      if (!current.capabilities?.completions) return []
      const hasContext = Object.keys(filledArgs).length > 0
      const { completion } = await current.client.complete(
        {
          ref: { type: 'ref/prompt', name: promptName },
          argument: { name: argName, value: partial },
          ...(hasContext && { context: { arguments: { ...filledArgs } } }),
        },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      const values = recursivelySanitizeUnicode(completion.values)
      return [...new Set(values)]
        .filter(value => value !== '' && !LINE_BREAK_RE.test(value))
        .slice(0, MAX_VALUES)
    } catch (error) {
      logMCPDebug(
        connection.name,
        `Completing argument '${argName}' of prompt '${promptName}' failed: ${errorMessage(error)}`,
      )
      return undefined
    }
  }

  return async (argName, partial, filledArgs) => {
    const key = JSON.stringify([
      promptName,
      argName,
      partial,
      Object.entries(filledArgs).sort(([a], [b]) => a.localeCompare(b)),
    ])
    const cached = cache.get(key)
    if (cached) {
      // Refresh its place in the LRU order
      cache.delete(key)
      cache.set(key, cached)
      return cached
    }
    const pending = inFlight.get(key)
    if (pending) return pending

    const promise = request(argName, partial, filledArgs).then(values => {
      inFlight.delete(key)
      if (!values) return []
      cache.set(key, values)
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
      return values
    })
    inFlight.set(key, promise)
    return promise
  }
}
