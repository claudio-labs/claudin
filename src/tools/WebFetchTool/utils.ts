import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import { queryHaiku } from 'src/services/api/claude.js'
import { AbortError } from 'src/shared/errors.js'
import { getWebFetchUserAgent } from 'src/shared/http.js'
import { logError } from 'src/shared/log.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from 'src/services/mcp/mcpOutputStorage.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import { asSystemPrompt } from 'src/utils/systemPromptType.js'
import { ssrfGuardedLookup } from 'src/services/lifecycleHooks/ssrfGuard.js'
import { createTwoTierCache } from 'src/tools/shared/twoTierCache.js'
import { isPreapprovedHost } from 'src/tools/WebFetchTool/preapproved.js'
import { makeSecondaryModelPrompt } from 'src/tools/WebFetchTool/prompt.js'

// Custom error classes for domain blocking
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`Claude Code is unable to fetch from ${domain}`)
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// Cache for storing fetched URL content. The two-tier semantics, in-flight
// coalescing, and stats live in src/tools/shared/twoTierCache.ts — this
// module just wires the WebFetch-specific knobs and value type. See
// the T5.10 design plan.
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

const URL_CACHE = createTwoTierCache<string, CacheEntry | RedirectInfo>({
  name: 'WebFetch',
  // 5 min fresh / 60 min stale-while-revalidate. Resources behind a URL
  // are stable enough that serving a slightly old copy + background
  // refresh beats blocking the user on a re-fetch.
  softTtlMs: 5 * 60 * 1000,
  hardTtlMs: 60 * 60 * 1000,
  maxSize: 50 * 1024 * 1024, // 50MB
  sizeOf: v => (isRedirectInfo(v) ? 1 : v.bytes || 1),
})

export const getWebFetchCacheStats = URL_CACHE.getStats

// Separate cache for preflight domain checks. URL_CACHE is URL-keyed, so
// fetching two paths on the same domain triggers two identical preflight
// HTTP round-trips to api.anthropic.com. This hostname-keyed cache avoids
// that. Only 'allowed' is cached — blocked/failed re-check on next attempt.
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000,
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  DOMAIN_CHECK_CACHE.clear()
}

// Lazy singleton — defers the turndown → @mixmark-io/domino import (~1.4MB
// retained heap) until the first HTML fetch, and reuses one instance across
// calls (construction builds 15 rule objects; .turndown() is stateless).
// @types/turndown ships only `export =` (no .d.mts), so TS types the import
// as the class itself while Bun wraps CJS in { default } — hence the cast.
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// PSR requested limiting the length of URLs to 250 to lower the potential
// for a data exfiltration. However, this is too restrictive for some customers'
// legitimate use cases, such as JWT-signed URLs (e.g., cloud service signed URLs)
// that can be much longer. We already require user approval for each domain,
// which provides a primary security boundary. In addition, Claude Code has
// other data exfil channels, and this one does not seem relatively high risk,
// so I'm removing that length restriction. -ab
const MAX_URL_LENGTH = 2000

// Per PSR:
// "Implement resource consumption controls because setting limits on CPU,
// memory, and network usage for the Web Fetch tool can prevent a single
// request or user from overwhelming the system."
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// Timeout for the main HTTP fetch request (60 seconds).
// Prevents hanging indefinitely on slow/unresponsive servers.
const FETCH_TIMEOUT_MS = 60_000

// Timeout for the domain blocklist preflight check (10 seconds).
const DOMAIN_CHECK_TIMEOUT_MS = 10_000

// Cap same-host redirect hops. Without this a malicious server can return
// a redirect loop (/a → /b → /a …) and the per-request FETCH_TIMEOUT_MS
// resets on every hop, hanging the tool until user interrupt. 10 matches
// common client defaults (axios=5, follow-redirects=21, Chrome=20).
const MAX_REDIRECTS = 10

// Truncate to not spend too many tokens
export const MAX_MARKDOWN_LENGTH = 100_000

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // We don't need to check protocol here, as we'll upgrade http to https when making the request

  // As long as we aren't supporting aiming to cookies or internal domains,
  // we should block URLs with usernames/passwords too, even though these
  // seem exceedingly unlikely.
  if (parsed.username || parsed.password) {
    return false
  }

  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

export async function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult> {
  // Third-party providers should not consult the first-party domain policy.
  if (getAPIProvider() !== 'firstParty') {
    return { status: 'allowed' }
  }

  if (DOMAIN_CHECK_CACHE.has(domain)) {
    return { status: 'allowed' }
  }
  try {
    const response = await axios.get(
      `https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(domain)}`,
      { timeout: DOMAIN_CHECK_TIMEOUT_MS },
    )
    if (response.status === 200) {
      if (response.data.can_fetch === true) {
        DOMAIN_CHECK_CACHE.set(domain, true)
        return { status: 'allowed' }
      }
      return { status: 'blocked' }
    }
    // Non-200 status but didn't throw
    return {
      status: 'check_failed',
      error: new Error(`Domain check returned status ${response.status}`),
    }
  } catch (e) {
    logError(e)
    return { status: 'check_failed', error: e as Error }
  }
}

/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // Now check hostname conditions
    // 1. Adding www. is allowed: example.com -> www.example.com
    // 2. Removing www. is allowed: www.example.com -> example.com
    // 3. Same host (with or without www.) is allowed: paths can change
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Per PSR:
 * "Do not automatically follow redirects because following redirects could
 * allow for an attacker to exploit an open redirect vulnerability in a
 * trusted domain to force a user to make a request to a malicious domain
 * unknowingly"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }

  const axiosConfig = {
    signal,
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 0,
    responseType: 'arraybuffer' as const,
    maxContentLength: MAX_HTTP_CONTENT_LENGTH,
    lookup: ssrfGuardedLookup,
    headers: {
      Accept: 'text/markdown, text/html, */*',
      'User-Agent': getWebFetchUserAgent(),
    },
  }

  try {
    return await axios.get(url, axiosConfig)
  } catch (error) {
    // Try native fetch as a fallback for timeout / network errors
    // (Bun/Node bundled contexts occasionally hang with axios + custom lookup.)
    const isTimeoutLike =
      axios.isAxiosError(error) &&
      (!error.response &&
        (error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT' ||
          error.message?.toLowerCase().includes('timeout')))
    if (isTimeoutLike && !signal.aborted) {
      try {
        const fetchResponse = await fetch(url, {
          signal,
          redirect: 'manual',
          headers: axiosConfig.headers,
        })
        // Handle redirects manually
        if ([301, 302, 307, 308].includes(fetchResponse.status)) {
          const redirectLocation = fetchResponse.headers.get('location')
          if (!redirectLocation) {
            throw new Error('Redirect missing Location header')
          }
          const redirectUrl = new URL(redirectLocation, url).toString()
          if (redirectChecker(url, redirectUrl)) {
            return getWithPermittedRedirects(
              redirectUrl,
              signal,
              redirectChecker,
              depth + 1,
            )
          } else {
            return {
              type: 'redirect' as const,
              originalUrl: url,
              redirectUrl,
              statusCode: fetchResponse.status,
            }
          }
        }
        const arrayBuffer = await fetchResponse.arrayBuffer()
        // Build an AxiosResponse-like shape so downstream code stays happy
        return {
          data: new Uint8Array(arrayBuffer),
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          headers: Object.fromEntries(fetchResponse.headers.entries()),
          config: axiosConfig,
          request: undefined,
        } as unknown as AxiosResponse<ArrayBuffer>
      } catch {
        // Fall through to original error handling
      }
    }

    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header')
      }

      // Resolve relative URLs against the original URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // Recursively follow the permitted redirect
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // Return redirect information to the caller
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // Detect egress proxy blocks: the proxy returns 403 with
    // X-Proxy-Error: blocked-by-allowlist when egress is restricted
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo | CacheEntry,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }
  // URL_CACHE handles fresh/stale/miss, in-flight coalescing, background
  // refresh, and counters. We just hand it a fetcher.
  return URL_CACHE.getOrFetch(
    url,
    signal => doFetch(url, signal),
    abortController.signal,
  )
}

async function doFetch(
  url: string,
  signal: AbortSignal,
): Promise<FetchedContent | RedirectInfo> {
  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // Check if the user has opted to skip the blocklist check
    // This is for enterprise customers with restrictive security policies
    // that prevent outbound connections to claude.ai
    const settings = getInitialSettings()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname)
      switch (checkResult.status) {
        case 'allowed':
          // Continue with the fetch
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }

  } catch (e) {
    if (
      e instanceof DomainBlockedError ||
      e instanceof DomainCheckFailedError
    ) {
      // Expected user-facing failures - re-throw without logging as internal error
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  const contentTypeHeader = response.headers['content-type']
  const contentType =
    typeof contentTypeHeader === 'string' ? contentTypeHeader : ''

  // Binary content: save raw bytes to disk with a proper extension so Claude
  // can inspect the file later. We still fall through to the utf-8 decode +
  // Haiku path below — for PDFs in particular the decoded string has enough
  // ASCII structure (/Title, text streams) that Haiku can summarize it, and
  // the saved file is a supplement rather than a replacement.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  const markdownContent = contentType.includes('text/html')
    ? (await getTurndownService()).turndown(htmlContent)
    : htmlContent

  // URL_CACHE handles storage + sizing. sizeOf uses `bytes` (raw HTTP
  // response length) as a close-enough proxy for in-memory cost; the
  // Turndown-converted markdown is usually smaller than the source HTML.
  return {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
}

// Budget for the secondary-model summarization after fetch. If the small-
// fast model is slow (e.g. a 200k-context third-party running a reasoning
// pass over ~100KB of markdown), we'd rather fall back to raw truncated
// markdown than hang the tool. Also keeps the worst-case WebFetch bounded
// to FETCH_TIMEOUT_MS + SECONDARY_MODEL_TIMEOUT_MS regardless of provider.
const SECONDARY_MODEL_TIMEOUT_MS = 45_000

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Secondary-model summarization timed out after ${timeoutMs}ms`)
      ;(err as NodeJS.ErrnoException).code = 'SECONDARY_MODEL_TIMEOUT'
      reject(err)
    }, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortError())
    }
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new AbortError())
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function buildFallbackMarkdownSummary(truncatedContent: string): string {
  return [
    '[Secondary-model summarization unavailable — returning raw fetched content.',
    'This typically means the configured small-fast model took too long or errored.]',
    '',
    truncatedContent,
  ].join('\n')
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // Truncate content to avoid "Prompt is too long" errors from the secondary model
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    prompt,
    isPreapprovedDomain,
  )
  let assistantMessage
  try {
    assistantMessage = await raceWithTimeout(
      queryHaiku({
        systemPrompt: asSystemPrompt([]),
        userPrompt: modelPrompt,
        signal,
        options: {
          querySource: 'web_fetch_apply',
          agents: [],
          isNonInteractiveSession,
          hasAppendSystemPrompt: false,
          mcpTools: [],
        },
      }),
      SECONDARY_MODEL_TIMEOUT_MS,
      signal,
    )
  } catch (err) {
    // User interrupts and SIGINTs still propagate. Everything else (timeout,
    // provider-side error, unsupported model on third-party endpoint) falls
    // back to raw markdown so the user still gets usable content rather than
    // a hang. Log so it's visible in debug traces.
    if (err instanceof AbortError || (err as Error)?.name === 'AbortError') {
      throw err
    }
    logError(err)
    return buildFallbackMarkdownSummary(truncatedContent)
  }

  // We need to bubble this up, so that the tool call throws, causing us to return
  // an is_error tool_use block to the server, and render a red dot in the UI.
  if (signal.aborted) {
    throw new AbortError()
  }

  const { content } = assistantMessage.message
  if (content.length > 0) {
    const contentBlock = content[0]
    if ('text' in contentBlock!) {
      return contentBlock.text
    }
  }
  return buildFallbackMarkdownSummary(truncatedContent)
}
