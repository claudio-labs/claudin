// @aws-sdk/credential-provider-node and @smithy/node-http-handler are imported
// dynamically in getAWSClientProxyConfig() to defer ~929KB of AWS SDK.
// undici is lazy-required inside getProxyAgent/configureGlobalAgents to defer
// ~1.5MB when no HTTPS_PROXY/mTLS env vars are set (the common case).
import axios, { type AxiosInstance } from 'axios'
import type { LookupOptions } from 'dns'
import type { Agent } from 'http'
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from 'https-proxy-agent'
import memoize from 'lodash-es/memoize.js'
import type * as undici from 'undici'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getMTLSAgent,
  getMTLSConfig,
  getTLSFetchOptions,
  type TLSConfig,
} from './mtls.js'

// Disable fetch keep-alive after a stale-pool ECONNRESET so retries open a
// fresh TCP connection instead of reusing the dead pooled socket. Sticky for
// the process lifetime — once the pool is known-bad, don't trust it again.
// Works under Bun (native fetch respects keepalive:false for pooling).
// Under Node/undici, keepalive is a no-op for pooling, but undici
// naturally evicts dead sockets from the pool on ECONNRESET.
//
// Keyed by provider so an ECONNRESET from DeepSeek/OpenAI-compat providers
// does not disable keep-alive for the Anthropic client in the same session.
const keepAliveDisabled = new Map<string, boolean>()

export function disableKeepAlive(provider: string): void {
  keepAliveDisabled.set(provider, true)
  // Invalidate cached per-provider dispatcher so the next request rebuilds
  // an Agent with keepAliveTimeout collapsed to its minimum, evicting any
  // dead pooled sockets that triggered the original ECONNRESET.
  invalidateProviderDispatcher(provider)
}

// Evict the cached undici Agent for a provider so the next request rebuilds
// it. We intentionally DO NOT call `.close()` here: invalidation can race
// with concurrent in-flight requests still holding the same Agent reference
// (e.g. a coordinator with sub-agents on one provider), and eagerly closing
// would surface ClientDestroyedError on those siblings. Sockets owned by
// the discarded Agent close on their own once keepAliveTimeout idles them
// (or sooner if the underlying error already invalidated them); GC reclaims
// the Agent once the last in-flight request resolves.
function invalidateProviderDispatcher(provider: string): void {
  getProviderDispatcher.cache.delete?.(provider)
}

export function _resetKeepAliveForTesting(provider?: string): void {
  if (provider !== undefined) {
    keepAliveDisabled.delete(provider)
    invalidateProviderDispatcher(provider)
  } else {
    keepAliveDisabled.clear()
    getProviderDispatcher.cache.clear?.()
  }
}

// Providers marked as h1-only after a failed h2 negotiation. Sticky for the
// process lifetime — once we know a provider's gateway rejects h2, don't try
// it again this session. Set by withH2Fallback() in services/api/h2Fallback.ts.
const h1OnlyProviders = new Map<string, boolean>()

export function markProviderH1Only(provider: string): void {
  h1OnlyProviders.set(provider, true)
  invalidateProviderDispatcher(provider)
}

export function isProviderH1Only(provider: string): boolean {
  return h1OnlyProviders.get(provider) === true
}

export function _resetH1OnlyForTesting(provider?: string): void {
  if (provider !== undefined) {
    h1OnlyProviders.delete(provider)
    invalidateProviderDispatcher(provider)
  } else {
    h1OnlyProviders.clear()
    getProviderDispatcher.cache.clear?.()
  }
}

/**
 * Convert dns.LookupOptions.family to a numeric address family value
 * Handles: 0 | 4 | 6 | 'IPv4' | 'IPv6' | undefined
 */
export function getAddressFamily(options: LookupOptions): 0 | 4 | 6 {
  switch (options.family) {
    case 0:
    case 4:
    case 6:
      return options.family
    case 'IPv6':
      return 6
    case 'IPv4':
    case undefined:
      return 4
    default:
      throw new Error(`Unsupported address family: ${options.family}`)
  }
}

type EnvLike = Record<string, string | undefined>

/**
 * Get the active proxy URL if one is configured
 * Prefers lowercase variants over uppercase (https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY)
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
}

/**
 * Get the NO_PROXY environment variable value
 * Prefers lowercase over uppercase (no_proxy > NO_PROXY)
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getNoProxy(env: EnvLike = process.env): string | undefined {
  return env.no_proxy || env.NO_PROXY
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY environment variable
 * Supports:
 * - Exact hostname matches (e.g., "localhost")
 * - Domain suffix matches with leading dot (e.g., ".example.com")
 * - Wildcard "*" to bypass all
 * - Port-specific matches (e.g., "example.com:8080")
 * - IP addresses (e.g., "127.0.0.1")
 * @param urlString URL to check
 * @param noProxy NO_PROXY value (defaults to getNoProxy() for production use)
 */
export function shouldBypassProxy(
  urlString: string,
  noProxy: string | undefined = getNoProxy(),
): boolean {
  if (!noProxy) return false

  // Handle wildcard
  if (noProxy === '*') return true

  try {
    const url = new URL(urlString)
    const hostname = url.hostname.toLowerCase()
    const port = url.port || (
      url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
    )
    const hostWithPort = `${hostname}:${port}`

    // Split by comma or space and trim each entry
    const noProxyList = noProxy.split(/[,\s]+/).filter(Boolean)

    return noProxyList.some(pattern => {
      pattern = pattern.toLowerCase().trim()

      // Check for port-specific match
      if (pattern.includes(':')) {
        return hostWithPort === pattern
      }

      // Check for domain suffix match (with or without leading dot)
      if (pattern.startsWith('.')) {
        // Pattern ".example.com" should match "sub.example.com" and "example.com"
        // but NOT "notexample.com"
        const suffix = pattern
        return hostname === pattern.substring(1) || hostname.endsWith(suffix)
      }

      // Check for exact hostname match or IP address
      return hostname === pattern
    })
  } catch {
    // If URL parsing fails, don't bypass proxy
    return false
  }
}

/**
 * Create an HttpsProxyAgent with optional mTLS configuration
 * Skips local DNS resolution to let the proxy handle it
 */
function createHttpsProxyAgent(
  proxyUrl: string,
  extra: HttpsProxyAgentOptions<string> = {},
): HttpsProxyAgent<string> {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  const agentOptions: HttpsProxyAgentOptions<string> = {
    ...(mtlsConfig && {
      cert: mtlsConfig.cert,
      key: mtlsConfig.key,
      passphrase: mtlsConfig.passphrase,
    }),
    ...(caCerts && { ca: caCerts }),
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS)) {
    // Skip local DNS resolution - let the proxy resolve hostnames
    // This is needed for environments where DNS is not configured locally
    // and instead handled by the proxy (as in sandboxes)
    agentOptions.lookup = (hostname, options, callback) => {
      callback(null, hostname, getAddressFamily(options))
    }
  }

  return new HttpsProxyAgent(proxyUrl, { ...agentOptions, ...extra })
}

/**
 * Axios instance with its own proxy agent. Same NO_PROXY/mTLS/CA
 * resolution as the global interceptor, but agent options stay
 * scoped to this instance.
 */
export function createAxiosInstance(
  extra: HttpsProxyAgentOptions<string> = {},
): AxiosInstance {
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()
  const instance = axios.create({ proxy: false })

  if (!proxyUrl) {
    if (mtlsAgent) instance.defaults.httpsAgent = mtlsAgent
    return instance
  }

  const proxyAgent = createHttpsProxyAgent(proxyUrl, extra)
  instance.interceptors.request.use(config => {
    if (config.url && shouldBypassProxy(config.url)) {
      config.httpsAgent = mtlsAgent
      config.httpAgent = mtlsAgent
    } else {
      config.httpsAgent = proxyAgent
      config.httpAgent = proxyAgent
    }
    return config
  })
  return instance
}

/**
 * Get or create a memoized proxy agent for the given URI
 * Now respects NO_PROXY environment variable
 */
export const getProxyAgent = memoize((uri: string): undici.Dispatcher => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  // Use EnvHttpProxyAgent to respect NO_PROXY
  // This agent automatically checks NO_PROXY for each request
  const proxyOptions: undici.EnvHttpProxyAgent.Options & {
    requestTls?: {
      cert?: string | Buffer
      key?: string | Buffer
      passphrase?: string
      ca?: string | string[] | Buffer
    }
  } = {
    // Override both HTTP and HTTPS proxy with the provided URI
    httpProxy: uri,
    httpsProxy: uri,
    noProxy: process.env.NO_PROXY || process.env.no_proxy,
  }

  // Set both connect and requestTls so TLS options apply to both paths:
  // - requestTls: used by ProxyAgent for the TLS connection through CONNECT tunnels
  // - connect: used by Agent for direct (no-proxy) connections
  if (mtlsConfig || caCerts) {
    const tlsOpts = {
      ...(mtlsConfig && {
        cert: mtlsConfig.cert,
        key: mtlsConfig.key,
        passphrase: mtlsConfig.passphrase,
      }),
      ...(caCerts && { ca: caCerts }),
    }
    proxyOptions.connect = tlsOpts
    proxyOptions.requestTls = tlsOpts
  }

  return new undiciMod.EnvHttpProxyAgent(proxyOptions)
})

// Per-provider undici Agent profile. undici 8 enabled HTTP/2 by default; we
// opt-in optimistically and let withH2Fallback() flip a provider to h1-only
// on protocol errors (markProviderH1Only). `connections` is a lazy ceiling —
// undici opens sockets on demand and closes them after keepAliveTimeout idle.
type ProviderPoolConfig = {
  allowH2: boolean
  connections: number
  keepAliveTimeout: number
  pipelining: number
}

const BASE_PROVIDER_POOL: Omit<ProviderPoolConfig, 'allowH2'> = {
  connections: 12,
  keepAliveTimeout: 30_000,
  pipelining: 1,
}

// Keys must match the canonical values returned by getAPIProvider() in
// src/utils/model/providers.ts. Adding a new APIProvider variant? Add it here
// (or accept the optimistic default below).
//
// Intentionally absent: 'bedrock', 'vertex', 'foundry'. These transports use
// AWS/GCP/Azure SDKs that bypass our `fetchOptions.dispatcher`, so a custom
// undici Agent would be ignored. They fall through to DEFAULT_PROVIDER_PROFILE
// as a no-op (cached but never consulted by the underlying client).
const PROVIDER_DISPATCHER_PROFILES: Record<string, ProviderPoolConfig> = {
  firstParty: { ...BASE_PROVIDER_POOL, allowH2: true },
  openai: { ...BASE_PROVIDER_POOL, allowH2: true },
  gemini: { ...BASE_PROVIDER_POOL, allowH2: true },
  mistral: { ...BASE_PROVIDER_POOL, allowH2: true },
  github: { ...BASE_PROVIDER_POOL, allowH2: true },
  codex: { ...BASE_PROVIDER_POOL, allowH2: true },
  'nvidia-nim': { ...BASE_PROVIDER_POOL, allowH2: true },
  minimax: { ...BASE_PROVIDER_POOL, allowH2: true },
}

// Unknown providers (custom OpenAI-compatible bases, self-hosted gateways)
// get the optimistic h2 profile. If the gateway can't speak h2,
// withH2Fallback() flips them to h1-only after the first failure.
const DEFAULT_PROVIDER_PROFILE: ProviderPoolConfig =
  PROVIDER_DISPATCHER_PROFILES.openai

/**
 * Per-provider undici dispatcher with tuned pool config. Used by direct API
 * fetches (no proxy). When a proxy is configured, getProxyAgent takes
 * precedence and this is bypassed because EnvHttpProxyAgent owns the
 * dispatcher for proxied requests.
 *
 * Memoized per provider. Cache is invalidated by:
 *   - disableKeepAlive(provider) — after stale-pool ECONNRESET
 *   - markProviderH1Only(provider) — after h2 negotiation failure
 */
export const getProviderDispatcher = memoize(
  (provider: string): undici.Dispatcher => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undiciMod = require('undici') as typeof undici
    const baseProfile =
      PROVIDER_DISPATCHER_PROFILES[provider] ?? DEFAULT_PROVIDER_PROFILE
    const profile: ProviderPoolConfig = {
      ...baseProfile,
      allowH2: baseProfile.allowH2 && !isProviderH1Only(provider),
      // Collapse keep-alive when the pool was just evicted to force a fresh
      // TCP connection on the next request. 100ms is the smallest value
      // undici's pool semantics document as honored — sub-second timeouts
      // below that are undefined behavior. The path is recovery-only, so
      // the exact value barely matters; what matters is "much smaller than
      // the default 30s" so the rebuilt Agent doesn't re-pool dead sockets.
      keepAliveTimeout: keepAliveDisabled.get(provider)
        ? 100
        : baseProfile.keepAliveTimeout,
    }
    return new undiciMod.Agent(profile)
  },
)

/**
 * Get an HTTP agent configured for WebSocket proxy support
 * Returns undefined if no proxy is configured or URL should bypass proxy
 */
export function getWebSocketProxyAgent(url: string): Agent | undefined {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return undefined
  }

  // Check if URL should bypass proxy
  if (shouldBypassProxy(url)) {
    return undefined
  }

  return createHttpsProxyAgent(proxyUrl)
}

/**
 * Get the proxy URL for WebSocket connections under Bun.
 * Bun's native WebSocket supports a `proxy` string option instead of Node's `agent`.
 * Returns undefined if no proxy is configured or URL should bypass proxy.
 */
export function getWebSocketProxyUrl(url: string): string | undefined {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return undefined
  }

  if (shouldBypassProxy(url)) {
    return undefined
  }

  return proxyUrl
}

/**
 * Get fetch options for the Anthropic SDK with proxy and mTLS configuration
 * Returns fetch options with appropriate dispatcher for proxy and/or mTLS
 *
 * @param opts.forAnthropicAPI - Enables ANTHROPIC_UNIX_SOCKET tunneling. This
 *   env var is set by `claude ssh` on the remote CLI to route API calls through
 *   an ssh -R forwarded unix socket to a local auth proxy. It MUST NOT leak
 *   into non-Anthropic-API fetch paths (MCP HTTP/SSE transports, etc.) or those
 *   requests get misrouted to api.anthropic.com. Only the Anthropic SDK client
 *   should pass `true` here.
 */
export function getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean; provider?: string }): {
  tls?: TLSConfig
  dispatcher?: undici.Dispatcher
  proxy?: string
  unix?: string
  keepalive?: false
} {
  // Only consult the keep-alive bucket when we have a real provider key.
  // Provider-less callers (WebSearch, etc.) manage their own per-call
  // keep-alive override in fetchWithProxyRetry to avoid leaking a single
  // ECONNRESET across all anonymous callers for the process lifetime.
  const base =
    opts?.provider && keepAliveDisabled.get(opts.provider)
      ? ({ keepalive: false } as const)
      : {}

  // ANTHROPIC_UNIX_SOCKET tunnels through the `claude ssh` auth proxy, which
  // hardcodes the upstream to the Anthropic API. Scope to the Anthropic API
  // client so MCP/SSE/other callers don't get their requests misrouted.
  if (opts?.forAnthropicAPI) {
    const unixSocket = process.env.ANTHROPIC_UNIX_SOCKET
    if (unixSocket && typeof Bun !== 'undefined') {
      return { ...base, unix: unixSocket }
    }
  }

  const proxyUrl = getProxyUrl()

  // If we have a proxy, use the proxy agent (which includes mTLS config)
  if (proxyUrl) {
    if (typeof Bun !== 'undefined') {
      return { ...base, proxy: proxyUrl, ...getTLSFetchOptions() }
    }
    return { ...base, dispatcher: getProxyAgent(proxyUrl) }
  }

  // No proxy: attach per-provider tuned dispatcher when we know which
  // provider this fetch is for. Bedrock/Vertex use their own SDK transport
  // and ignore fetchOptions.dispatcher, so this is a no-op there.
  //
  // If mTLS is configured WITHOUT a proxy, getTLSFetchOptions() returns its
  // own dispatcher carrying the client cert/key. Replacing it with our
  // per-provider Agent would silently drop the cert and break mTLS auth.
  // In that case we cede the dispatcher slot to the mTLS Agent — we lose
  // the per-provider tuning, but correctness (mTLS handshake) wins.
  const tlsOptions = getTLSFetchOptions()
  if (opts?.provider && !tlsOptions.dispatcher) {
    return {
      ...base,
      ...tlsOptions,
      dispatcher: getProviderDispatcher(opts.provider),
    }
  }

  // Otherwise, use TLS options directly if available
  return { ...base, ...tlsOptions }
}

/**
 * Configure global HTTP agents for both axios and undici
 * This ensures all HTTP requests use the proxy and/or mTLS if configured
 */
let proxyInterceptorId: number | undefined

export function configureGlobalAgents(): void {
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()

  // Eject previous interceptor to avoid stacking on repeated calls
  if (proxyInterceptorId !== undefined) {
    axios.interceptors.request.eject(proxyInterceptorId)
    proxyInterceptorId = undefined
  }

  // Reset proxy-related defaults so reconfiguration is clean
  axios.defaults.proxy = undefined
  axios.defaults.httpAgent = undefined
  axios.defaults.httpsAgent = undefined

  if (proxyUrl) {
    // workaround for https://github.com/axios/axios/issues/4531
    axios.defaults.proxy = false

    // Create proxy agent with mTLS options if available
    const proxyAgent = createHttpsProxyAgent(proxyUrl)

    // Add axios request interceptor to handle NO_PROXY
    proxyInterceptorId = axios.interceptors.request.use(config => {
      // Check if URL should bypass proxy based on NO_PROXY
      if (config.url && shouldBypassProxy(config.url)) {
        // Bypass proxy - use mTLS agent if configured, otherwise undefined
        if (mtlsAgent) {
          config.httpsAgent = mtlsAgent
          config.httpAgent = mtlsAgent
        } else {
          // Remove any proxy agents to use direct connection
          delete config.httpsAgent
          delete config.httpAgent
        }
      } else {
        // Use proxy agent
        config.httpsAgent = proxyAgent
        config.httpAgent = proxyAgent
      }
      return config
    })

    // Set global dispatcher that now respects NO_PROXY via EnvHttpProxyAgent
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;(require('undici') as typeof undici).setGlobalDispatcher(
      getProxyAgent(proxyUrl),
    )
  } else if (mtlsAgent) {
    // No proxy but mTLS is configured
    axios.defaults.httpsAgent = mtlsAgent

    // Set undici global dispatcher with mTLS
    const mtlsOptions = getTLSFetchOptions()
    if (mtlsOptions.dispatcher) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ;(require('undici') as typeof undici).setGlobalDispatcher(
        mtlsOptions.dispatcher,
      )
    }
  }
}

/**
 * Get AWS SDK client configuration with proxy support
 * Returns configuration object that can be spread into AWS service client constructors
 */
export async function getAWSClientProxyConfig(): Promise<object> {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return {}
  }

  const [{ NodeHttpHandler }, { defaultProvider }] = await Promise.all([
    import('@smithy/node-http-handler'),
    import('@aws-sdk/credential-provider-node'),
  ])

  const agent = createHttpsProxyAgent(proxyUrl)
  const requestHandler = new NodeHttpHandler({
    httpAgent: agent,
    httpsAgent: agent,
  })

  return {
    requestHandler,
    credentials: defaultProvider({
      clientConfig: { requestHandler },
    }),
  }
}

/**
 * Clear proxy agent cache.
 */
export function clearProxyCache(): void {
  getProxyAgent.cache.clear?.()
  logForDebugging('Cleared proxy agent cache')
}
