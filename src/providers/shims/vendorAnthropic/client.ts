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
import { withWireFallback } from 'src/providers/presets/wireFallback.js'
import { apiPromise, overrideMembers, type ApiPromise, type ApiResult } from 'src/providers/shims/clientFacade.js'

const KEPT_BETAS: ReadonlySet<string> = new Set(['interleaved-thinking-2025-05-14'])

type Messages = { create: (params: Record<string, unknown>, options?: unknown) => ApiPromise }
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
  const pair = { wire: 'anthropic' as const, baseUrl: options.compatBaseUrl, model: options.model }

  function create(params: Record<string, unknown>, requestOptions?: unknown): ApiPromise {
    return apiPromise<unknown>(
      withWireFallback<ApiResult>(pair, {
        primary: () => native.create(vendorParams(params), requestOptions).withResponse(),
        chat: async () => (await fallback()).beta.messages.create(params, requestOptions).withResponse(),
      }),
    )
  }

  const messages = overrideMembers(native, { create, keepAlivePingParams: () => null, countTokens: undefined })
  return overrideMembers(sdk, { beta: overrideMembers(sdk.beta, { messages }) })
}
