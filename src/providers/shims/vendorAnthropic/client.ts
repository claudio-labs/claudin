/**
 * The Anthropic Messages client for a vendor's own `/anthropic` endpoint
 * (MiniMax, Moonshot, DashScope — compatWires.ts `anthropic` rows), with what
 * Claudin's native path sends cut down to what such an endpoint takes.
 *
 * The profile stays an openai_compat one, so `getAPIProvider()` keeps its
 * tag and every first-party gate stays off (thinking and effort params,
 * the 1h cache tier, adopted betas, native web search). What the native
 * path sends anyway, and the vendor must not get, goes here:
 *  - `metadata.user_id` (device, account and session ids);
 *  - every beta but interleaved thinking, the one the recordings carry;
 *  - the keep-alive ping: `keepAlivePingParams` answers null, since nothing
 *    says a vendor's cache reads a 1-token ping as a read;
 *  - count_tokens: the client has no `countTokens`, so the estimate is local.
 * The vendor's own default decides thinking, and its thinking blocks are sent
 * back as it wrote them.
 *
 * A first request the endpoint rejects (wireFallback.ts) is answered by the
 * Chat Completions shim instead, and so is every later one for that model.
 */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import type { CompatWireRow } from 'src/providers/presets/compatWires.js'
import {
  isWireRejected,
  noteWireSuccess,
  rejectWireOnFailure,
} from 'src/providers/presets/wireFallback.js'
import { isSdkApiError } from 'src/shared/errors.js'

const KEPT_BETAS: ReadonlySet<string> = new Set(['interleaved-thinking-2025-05-14'])

type CreateResult = Promise<unknown> & { withResponse: () => Promise<{ data: unknown; [key: string]: unknown }> }
type Messages = { create: (params: Record<string, unknown>, options?: unknown) => CreateResult }
type ShimClient = { beta: { messages: Messages } }

export type VendorAnthropicClientOptions = {
  /** The factory's shared SDK options (headers, retries, timeout, fetch). */
  sdkOptions: ClientOptions
  /** The vendor's Anthropic base URL, from the row. */
  baseUrl: string
  apiKey: string
  row: CompatWireRow
  /** The profile's own base URL and model: the pair the fallback is keyed on. */
  compatBaseUrl: string
  model: string
  /** The Chat Completions client the fallback answers with. */
  fallback: () => Promise<ShimClient>
}

/** The params as the vendor gets them. */
export function vendorParams(params: Record<string, unknown>): Record<string, unknown> {
  const { metadata: _metadata, betas, ...rest } = params
  const kept = Array.isArray(betas) ? betas.filter(beta => KEPT_BETAS.has(String(beta))) : []
  return kept.length > 0 ? { ...rest, betas: kept } : rest
}

function failureBody(error: { error?: unknown; message?: string }): string {
  return `${JSON.stringify(error.error ?? {})} ${error.message ?? ''}`
}

export function createVendorAnthropicClient(options: VendorAnthropicClientOptions): Anthropic {
  const { defaultHeaders, ...sdkOptions } = options.sdkOptions
  // Betas, and any credential meant for Anthropic, stay off the vendor's wire.
  const {
    'anthropic-beta': _beta,
    Authorization: _authorization,
    'x-api-key': _apiKey,
    ...headers
  } = (defaultHeaders ?? {}) as Record<string, string>
  const sdk = new Anthropic({
    ...sdkOptions,
    defaultHeaders: headers,
    baseURL: options.baseUrl,
    // The vendors read the key as a bearer token.
    authToken: options.apiKey,
    apiKey: null,
  })
  const native = sdk.beta.messages as unknown as Messages
  let shim: Promise<ShimClient> | undefined
  const fallback = () => (shim ??= options.fallback())

  function create(params: Record<string, unknown>, requestOptions?: unknown): CreateResult {
    const onChat = isWireRejected('anthropic', options.compatBaseUrl, options.model)
    const answered = (async () => {
      if (onChat) return (await fallback()).beta.messages.create(params, requestOptions).withResponse()
      try {
        const result = await native.create(vendorParams(params), requestOptions).withResponse()
        noteWireSuccess('anthropic', options.compatBaseUrl, options.model)
        return result
      } catch (error) {
        if (
          isSdkApiError(error) &&
          typeof error.status === 'number' &&
          rejectWireOnFailure('anthropic', options.compatBaseUrl, options.model, {
            status: error.status,
            body: failureBody(error),
          })
        ) {
          return (await fallback()).beta.messages.create(params, requestOptions).withResponse()
        }
        throw error
      }
    })()
    const out = answered.then(result => result.data) as CreateResult
    // A caller that only takes withResponse() never awaits `out` itself.
    out.catch(() => {})
    out.withResponse = () => answered
    return out
  }

  const messages = new Proxy(native, {
    get(target, prop) {
      if (prop === 'create') return create
      if (prop === 'keepAlivePingParams') return () => null
      if (prop === 'countTokens') return undefined
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(target, prop) {
      return prop === 'countTokens' ? false : Reflect.has(target, prop)
    },
  })
  const beta = new Proxy(sdk.beta, {
    get(target, prop) {
      if (prop === 'messages') return messages
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(sdk, {
    get(target, prop) {
      if (prop === 'beta') return beta
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
