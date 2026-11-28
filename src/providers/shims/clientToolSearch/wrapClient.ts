/**
 * Puts client-side tool search in front of any client the factory builds for
 * a wire without server-side tool search (`clientDefersTools`): the params go
 * through `applyClientToolSearch`, and the answer — a stream or a whole
 * message — through `gatewayEvents` / `gatewayMessage`.
 *
 * Only `create` is replaced. Everything else on the client is the client's
 * own, bound to it, so a capability it has (`keepAlivePingParams`) or lacks
 * (`countTokens`) reads the same through the wrapper.
 */
import { applyClientToolSearch } from 'src/providers/shims/clientToolSearch/paramsTransform.js'
import { gatewayEvents, gatewayMessage } from 'src/providers/shims/clientToolSearch/eventTransform.js'
import { mapApiPromise, overrideMembers, type ApiPromise } from 'src/providers/shims/clientFacade.js'

type Create = (params: Record<string, unknown>, options?: unknown) => ApiPromise

/** A stream whose gateway calls come back as the tools they name. */
class GatewayStream {
  readonly controller: unknown

  constructor(private readonly inner: AsyncIterable<unknown> & { controller?: unknown }) {
    this.controller = inner.controller
  }

  async *[Symbol.asyncIterator]() {
    yield* gatewayEvents(this.inner)
  }
}

function unwrapResult(data: unknown): unknown {
  if (data && typeof data === 'object' && Symbol.asyncIterator in data) {
    return new GatewayStream(data as AsyncIterable<unknown> & { controller?: unknown })
  }
  return gatewayMessage(data)
}

function wrapCreate(create: Create): Create {
  return (params, options) => {
    const plan = applyClientToolSearch(params)
    const inner = create(plan.params, options)
    return plan.active ? mapApiPromise(inner, unwrapResult) : inner
  }
}

function wrapMessages<T extends object>(messages: T): T {
  const create = (messages as { create?: Create }).create
  if (typeof create !== 'function') return messages
  return overrideMembers(messages, { create: wrapCreate(create.bind(messages)) })
}

export function withClientToolSearch<T extends object>(client: T): T {
  const { beta, messages } = client as { beta?: { messages?: object }; messages?: object }
  const overrides: Record<PropertyKey, unknown> = {}
  if (beta && typeof beta === 'object' && beta.messages) {
    overrides.beta = overrideMembers(beta, { messages: wrapMessages(beta.messages) })
  }
  if (messages && typeof messages === 'object') overrides.messages = wrapMessages(messages)
  return overrideMembers(client, overrides)
}
