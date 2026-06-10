/**
 * Anthropic SDK-shaped client that adapts every call to the active
 * OpenAI-compatible provider.
 *
 * Three classes:
 *  - `OpenAIShimMessages` — implements the `.messages.create()` surface.
 *    Drives the request (`_doRequest` dispatcher → `_doOpenAIRequest`
 *    Chat Completions branch / `performCodexRequest` Responses branch),
 *    parses streaming vs non-streaming responses, and returns objects
 *    that duck-type the Anthropic SDK's Message / Stream return values.
 *  - `OpenAIShimBeta` — mirrors `beta.messages` on the Anthropic SDK.
 *  - `createOpenAIShimClient` — factory; the only export consumed
 *    outside this module (see `client.ts:189` dynamic import).
 *
 * `_doOpenAIRequest` is intentionally kept as a single ~570-line block:
 * future decomposition into `bodyBuilder` + `requestRunner` is tracked
 * as a follow-up PR (see plan §"Decomposição interna").
 */

import { APIError } from '@anthropic-ai/sdk'
import {
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
} from '../../../utils/codexCredentials.js'
import {
  readXaiCredentialsAsync,
  refreshXaiAccessTokenIfNeeded,
} from '../../../utils/xaiCredentials.js'
import { getXaiUserAgent } from '../../../utils/xaiUserAgent.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isBareMode } from '../../../utils/envUtils.js'
import { resolveGeminiCredential } from '../../../utils/geminiAuth.js'
import { hydrateGeminiAccessTokenFromSecureStorage } from '../../../utils/geminiCredentials.js'
import { hydrateGithubModelsTokenFromSecureStorage } from '../../../utils/githubModelsCredentials.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { redactSecretValueForDisplay } from '../../../utils/providerProfile.js'
import { logApiCallEnd, logApiCallStart } from '../../../utils/requestLogging.js'
import { stableStringify } from '../../../utils/stableStringify.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForContent,
} from '../../tokenEstimation.js'
import { applyStableStubs } from '../../compact/stableStubState.js'
import { tryGetActiveProvider } from '../activeProvider.js'
import { buildAnthropicUsageFromRawUsage } from '../cacheMetrics.js'
import {
  codexStreamToAnthropic,
  collectCodexCompletedResponse,
  convertAnthropicMessagesToResponsesInput,
  convertCodexResponseToAnthropicMessage,
  convertToolsToResponsesTools,
  performCodexRequest,
  type ShimCreateParams,
} from '../codexShim.js'
import { fetchWithProxyRetry } from '../fetchWithProxyRetry.js'
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
} from '../openaiErrorClassification.js'
import {
  getGithubEndpointType,
  getLocalProviderRetryBaseUrls,
  isLocalProviderUrl,
  isXaiOAuthBaseUrl,
  resolveProviderRequest,
  resolveRuntimeCodexCredentials,
  shouldAttemptLocalToollessRetry,
} from '../providerConfig.js'
import { stripThinkTags } from '../thinkTagSanitizer.js'
import { normalizeToolArguments } from '../toolArgumentNormalization.js'
import { getClaudinUserAgent } from '../../../utils/userAgent.js'
import {
  COPILOT_HEADERS,
  GITHUB_429_BASE_DELAY_SEC,
  GITHUB_429_MAX_DELAY_SEC,
  GITHUB_429_MAX_RETRIES,
} from './constants.js'
import { filterAnthropicHeaders, formatRetryAfterHint } from './headers.js'
import { makeMessageId, sleepMs } from './helpers.js'
import { convertMessages, convertSystemPrompt } from './messageConverter.js'
import {
  isDeepSeekBaseUrl,
  isGeminiMode,
  isGithubModelsMode,
  isGlmCompatibleBaseUrl,
  isMistralMode,
  isMoonshotCompatibleBaseUrl,
  normalizeDeepSeekReasoningEffort,
} from './providerModes.js'
import { extractReasoningMessage } from './reasoningNormalizer.js'
import { openaiStreamToAnthropic, OpenAIShimStream } from './streamParser.js'
import { getSessionId } from '../../../bootstrap/state.js'

// api.openai.com (and the chatgpt.com backend) honor prompt_cache_key /
// prompt_cache_retention; everything else gets the params withheld.
function isOfficialOpenAIUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).host
    return host === 'api.openai.com' || host.endsWith('.api.openai.com')
  } catch {
    return false
  }
}
import { convertTools } from './toolConverter.js'
import type { SecretValueSource } from './types.js'
import { redactUrlForDiagnostics } from './urlRedaction.js'

class OpenAIShimMessages {
  private defaultHeaders: Record<string, string>
  private reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh') {
    this.defaultHeaders = filterAnthropicHeaders(defaultHeaders)
    this.reasoningEffort = reasoningEffort
  }

  create(
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) {
    const self = this

    let httpResponse: Response | undefined

    const promise = (async () => {
      const request = resolveProviderRequest({ model: params.model, reasoningEffortOverride: self.reasoningEffort })
      const response = await self._doRequest(request, params, options)
      httpResponse = response

      if (params.stream) {
        const isResponsesStream = response.url?.includes('/responses')
        // Estimate input tokens from request messages + system prompt so the
        // fallback path (providers that don't emit usage) can report non-zero
        // input instead of 0. The messages may be in either the internal
        // Claudin format ({ type, message: { content } }) or the Anthropic
        // SDK format ({ role, content }) — extract content and delegate to
        // roughTokenCountEstimationForContent which handles all block types
        // (text, tool_use, tool_result, image, etc.).
        let estimatedInputTokens = 0
        for (const msg of params.messages) {
          const m = msg as Record<string, unknown>
          const content = m.message
            ? (m.message as Record<string, unknown>).content
            : m.content
          if (content != null && typeof content !== 'string' && !Array.isArray(content)) continue
          estimatedInputTokens += roughTokenCountEstimationForContent(content)
        }
        if (typeof params.system === 'string') {
          estimatedInputTokens += roughTokenCountEstimation(params.system)
        } else if (Array.isArray(params.system)) {
          estimatedInputTokens += roughTokenCountEstimationForContent(params.system)
        }
        return new OpenAIShimStream(
          (request.transport === 'codex_responses' || isResponsesStream)
            ? codexStreamToAnthropic(response, request.resolvedModel, options?.signal)
            : openaiStreamToAnthropic(response, request.resolvedModel, options?.signal, estimatedInputTokens),
        )
      }

      if (request.transport === 'codex_responses') {
        const data = await collectCodexCompletedResponse(response, options?.signal)
        return convertCodexResponseToAnthropicMessage(
          data,
          request.resolvedModel,
        )
      }

      const isResponsesNonStream = response.url?.includes('/responses')
      if (isResponsesNonStream || (request.transport === 'chat_completions' && isGithubModelsMode())) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const parsed = await response.json() as Record<string, unknown>
          if (
            parsed &&
            typeof parsed === 'object' &&
            ('output' in parsed || 'incomplete_details' in parsed)
          ) {
            return convertCodexResponseToAnthropicMessage(
              parsed,
              request.resolvedModel,
            )
          }
          return self._convertNonStreamingResponse(parsed, request.resolvedModel)
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await response.json()
        return self._convertNonStreamingResponse(data, request.resolvedModel)
      }

      const textBody = await response.text().catch(() => '')
      throw APIError.generate(
        response.status,
        undefined,
        `OpenAI API error ${response.status}: unexpected response: ${textBody.slice(0, 500)}`,
        response.headers as unknown as Headers,
      )
    })()

      ; (promise as unknown as Record<string, unknown>).withResponse =
        async () => {
          const data = await promise
          return {
            data,
            response: httpResponse ?? new Response(),
            request_id:
              httpResponse?.headers.get('x-request-id') ?? makeMessageId(),
          }
        }

    return promise
  }

  private async _doRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    const githubEndpointType = getGithubEndpointType(request.baseUrl)
    const isGithubMode = isGithubModelsMode()
    const isGithubWithCodexTransport = isGithubMode && request.transport === 'codex_responses'

    if (isGithubWithCodexTransport) {
      const profile = tryGetActiveProvider()
      const apiKey =
        profile?.extras?.githubToken ??
        profile?.apiKey ??
        ''
      if (!apiKey) {
        throw new Error(
          'GitHub Copilot auth is required. Run /provider and choose GitHub Copilot.',
        )
      }

      return performCodexRequest({
        request,
        credentials: {
          apiKey,
          source: 'env',
        },
        params,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...filterAnthropicHeaders(options?.headers),
          ...COPILOT_HEADERS,
        },
        signal: options?.signal,
      })
    }

    if (request.transport === 'codex_responses' && !isGithubMode) {
      const refreshResult = await refreshCodexAccessTokenIfNeeded().catch(
        async error => {
          logForDebugging(
            `[codex] access token refresh failed before request: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
          return {
            refreshed: false,
            credentials: await readCodexCredentialsAsync(),
          }
        },
      )
      const credentials = resolveRuntimeCodexCredentials({
        storedCredentials: refreshResult.credentials,
      })
      if (!credentials.apiKey) {
        const oauthHint = isBareMode() ? '' : ', choose Codex OAuth in /provider'
        const authHint = credentials.authPath
          ? `${oauthHint} or place a Codex auth.json at ${credentials.authPath}`
          : oauthHint
        const safeModel =
          redactSecretValueForDisplay(request.requestedModel, process.env as SecretValueSource) ??
          'the requested model'
        throw new Error(
          `Codex auth is required for ${safeModel}. Set CODEX_API_KEY${authHint}.`,
        )
      }
      if (!credentials.accountId) {
        throw new Error(
          'Codex auth is missing chatgpt_account_id. Re-login with Codex OAuth, the Codex CLI, or set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID.',
        )
      }

      return performCodexRequest({
        request,
        credentials,
        params,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...filterAnthropicHeaders(options?.headers),
        },
        signal: options?.signal,
      })
    }

    return this._doOpenAIRequest(request, params, options)
  }

  private async _doOpenAIRequest(
    request: ReturnType<typeof resolveProviderRequest>,
    params: ShimCreateParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    // applyStableStubs runs at the API boundary so the stable bytes are
    // what goes on the wire. No ensureToolResultPairing analogue exists
    // here — convertMessages handles orphan tool_results downstream.
    const compressedMessages = applyStableStubs(
      params.messages as Array<{
        role: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }>,
    )
    const openaiMessages = convertMessages(compressedMessages, params.system, {
      // Moonshot/Kimi Code requires every assistant tool-call message to carry
      // reasoning_content when its thinking feature is active. DeepSeek does
      // the same for tool-call turns in thinking mode. Echo it back from the
      // thinking block we captured on the inbound response.
      preserveReasoningContent:
        isMoonshotCompatibleBaseUrl(request.baseUrl) ||
        isDeepSeekBaseUrl(request.baseUrl) ||
        isGlmCompatibleBaseUrl(request.baseUrl),
    })

    const body: Record<string, unknown> = {
      model: request.resolvedModel,
      messages: openaiMessages,
      stream: params.stream ?? false,
      store: false,
      // Official OpenAI only: a session-stable prompt_cache_key improves
      // cache routing (~8.5% hit-rate per OpenAI's own benchmarks) and 24h
      // retention keeps the prefix warm across pauses — caching has no
      // write surcharge and cached input is up to 90% off, so warmer is
      // strictly cheaper. Third-party OpenAI-compatible backends (Azure,
      // routers, local) may reject unknown params, so gate hard.
      ...(isOfficialOpenAIUrl(request.baseUrl) && {
        prompt_cache_key: getSessionId(),
        prompt_cache_retention: '24h',
      }),
    }
    // Convert max_tokens to max_completion_tokens for OpenAI API compatibility.
    // Azure OpenAI requires max_completion_tokens and does not accept max_tokens.
    // Ensure max_tokens is a valid positive number before using it.
    const maxTokensValue = typeof params.max_tokens === 'number' && params.max_tokens > 0
      ? params.max_tokens
      : undefined
    const maxCompletionTokensValue = typeof (params as Record<string, unknown>).max_completion_tokens === 'number'
      ? (params as Record<string, unknown>).max_completion_tokens as number
      : undefined

    if (maxTokensValue !== undefined) {
      body.max_completion_tokens = maxTokensValue
    } else if (maxCompletionTokensValue !== undefined) {
      body.max_completion_tokens = maxCompletionTokensValue
    }

    if (params.stream && !isLocalProviderUrl(request.baseUrl)) {
      body.stream_options = { include_usage: true }
    }

    const isGithub = isGithubModelsMode()
    const isMistral = isMistralMode()
    const isLocal = isLocalProviderUrl(request.baseUrl)

    const githubEndpointType = getGithubEndpointType(request.baseUrl)
    const isGithubCopilot = isGithub && githubEndpointType === 'copilot'
    const isGithubModels = isGithub && (githubEndpointType === 'models' || githubEndpointType === 'custom')

    const isMoonshot = isMoonshotCompatibleBaseUrl(request.baseUrl)
    const isDeepSeek = isDeepSeekBaseUrl(request.baseUrl)

    const isGlm = isGlmCompatibleBaseUrl(request.baseUrl)

    if ((isGithub || isMistral || isLocal || isMoonshot || isDeepSeek || isGlm) && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens
      delete body.max_completion_tokens
    }

    // mistral and gemini don't recognize body.store — Gemini returns 400
    // "Invalid JSON payload received. Unknown name 'store': Cannot find field."
    // Moonshot direct API, Kimi Code's OpenAI-compatible coding endpoint,
    // and DeepSeek have not published support for the parameter either;
    // strip it preemptively to avoid the same class of error on strict-parse
    // providers.
    if (isMistral || isGeminiMode() || isMoonshot || isDeepSeek || isGlm) {
      delete body.store
    }

    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.top_p !== undefined) body.top_p = params.top_p

    if (isDeepSeek) {
      const requestedThinkingType = (params.thinking as { type?: string } | undefined)?.type
      const deepSeekThinkingType =
        requestedThinkingType === 'disabled'
          ? 'disabled'
          : requestedThinkingType === 'enabled' || requestedThinkingType === 'adaptive'
            ? 'enabled'
            : undefined

      if (deepSeekThinkingType) {
        body.thinking = { type: deepSeekThinkingType }
      }

      if (deepSeekThinkingType === 'enabled') {
        const effort = request.reasoning?.effort
        if (effort) {
          body.reasoning_effort = normalizeDeepSeekReasoningEffort(effort)
        }
      }
    }

    if (params.tools && params.tools.length > 0) {
      const converted = convertTools(
        params.tools as Array<{
          name: string
          description?: string
          input_schema?: Record<string, unknown>
          type?: string
        }>,
      )
      if (converted.length > 0) {
        body.tools = converted
        if (params.tool_choice) {
          const tc = params.tool_choice as { type?: string; name?: string }
          if (tc.type === 'auto') {
            body.tool_choice = 'auto'
          } else if (tc.type === 'tool' && tc.name) {
            body.tool_choice = {
              type: 'function',
              function: { name: tc.name },
            }
          } else if (tc.type === 'any') {
            body.tool_choice = 'required'
          } else if (tc.type === 'none') {
            body.tool_choice = 'none'
          }
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...filterAnthropicHeaders(options?.headers),
      // Override upstream "claude-cli" User-Agent with Claudin branding
      'User-Agent': getClaudinUserAgent(),
    }

    const isGemini = isGeminiMode()
    // Every provider preset (including MiniMax/Bankr/Github) flows through
    // the active profile resolver — no MINIMAX_API_KEY / BNKR_API_KEY /
    // GITHUB_TOKEN env escapes are needed here.
    const profileForKey = tryGetActiveProvider()

    // xAI / Grok OAuth: when the active profile points at api.x.ai and has
    // no static apiKey, swap in the rotated OAuth access token from secure
    // storage. Preflight refresh mirrors the Codex path above; a stale
    // access token here would 401, force-refresh via withRetry, and retry.
    let xaiOAuthAccessToken: string | undefined
    if (isXaiOAuthBaseUrl(profileForKey?.baseUrl) && !profileForKey?.apiKey) {
      const refreshResult = await refreshXaiAccessTokenIfNeeded().catch(
        async error => {
          logForDebugging(
            `[xai] access token refresh failed before request: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
          return {
            refreshed: false,
            credentials: await readXaiCredentialsAsync(),
          }
        },
      )
      xaiOAuthAccessToken = refreshResult.credentials?.accessToken
    }

    const apiKey =
      profileForKey?.apiKey ??
      profileForKey?.extras?.githubToken ??
      xaiOAuthAccessToken ??
      ''
    // Detect Azure endpoints by hostname (not raw URL) to prevent bypass via
    // path segments like https://evil.com/cognitiveservices.azure.com/
    let isAzure = false
    try {
      const { hostname } = new URL(request.baseUrl)
      isAzure = hostname.endsWith('.azure.com') &&
        (hostname.includes('cognitiveservices') || hostname.includes('openai') || hostname.includes('services.ai'))
    } catch { /* malformed URL — not Azure */ }

    let isBankr = false
    try {
      isBankr = request.baseUrl.toLowerCase().includes('bankr')
    } catch { /* malformed URL — not Bankr */ }

    if (apiKey) {
      if (isAzure) {
        // Azure uses api-key header instead of Bearer token
        headers['api-key'] = apiKey
      } else if (isBankr) {
        // Bankr uses X-API-Key header instead of Bearer token
        headers['X-API-Key'] = apiKey
      } else {
        headers.Authorization = `Bearer ${apiKey}`
      }
      // Send an honest Claudin/<version> UA to xAI so traffic isn't
      // misattributed to whatever client_id the OAuth flow reused.
      if (xaiOAuthAccessToken && apiKey === xaiOAuthAccessToken) {
        headers['User-Agent'] = getXaiUserAgent()
      }
    } else if (isGemini) {
      const geminiCredential = await resolveGeminiCredential(process.env)
      if (geminiCredential.kind !== 'none') {
        headers.Authorization = `Bearer ${geminiCredential.credential}`
        if (geminiCredential.kind !== 'api-key' && 'projectId' in geminiCredential && geminiCredential.projectId) {
          headers['x-goog-user-project'] = geminiCredential.projectId
        }
      }
    }

    if (isGithubCopilot) {
      Object.assign(headers, COPILOT_HEADERS)
    } else if (isGithubModels) {
      headers['Accept'] = 'application/vnd.github+json'
      headers['X-GitHub-Api-Version'] = '2022-11-28'
    }

    const buildChatCompletionsUrl = (baseUrl: string): string => {
      // Azure Cognitive Services / Azure OpenAI require a deployment-specific
      // path and an api-version query parameter.
      if (isAzure) {
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview'
        const deployment = request.resolvedModel ?? profileForKey?.model ?? 'gpt-4o'

        // If base URL already contains /deployments/, use it as-is with api-version.
        if (/\/deployments\//i.test(baseUrl)) {
          const normalizedBase = baseUrl.replace(/\/+$/, '')
          return `${normalizedBase}/chat/completions?api-version=${apiVersion}`
        }

        // Strip trailing /v1 or /openai/v1 if present, then build Azure path.
        const normalizedBase = baseUrl
          .replace(/\/(openai\/)?v1\/?$/, '')
          .replace(/\/+$/, '')

        return `${normalizedBase}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
      }

      return `${baseUrl}/chat/completions`
    }

    const localRetryBaseUrls = isLocal
      ? getLocalProviderRetryBaseUrls(request.baseUrl)
      : []

    let activeBaseUrl = request.baseUrl
    let chatCompletionsUrl = buildChatCompletionsUrl(activeBaseUrl)
    const attemptedLocalBaseUrls = new Set<string>([activeBaseUrl])
    let didRetryWithoutTools = false

    const promoteNextLocalBaseUrl = (
      reason: 'endpoint_not_found' | 'localhost_resolution_failed',
    ): boolean => {
      for (const candidateBaseUrl of localRetryBaseUrls) {
        if (attemptedLocalBaseUrls.has(candidateBaseUrl)) {
          continue
        }

        const previousUrl = chatCompletionsUrl
        attemptedLocalBaseUrls.add(candidateBaseUrl)
        activeBaseUrl = candidateBaseUrl
        chatCompletionsUrl = buildChatCompletionsUrl(activeBaseUrl)

        logForDebugging(
          `[OpenAIShim] self-heal retry reason=${reason} method=POST from=${redactUrlForDiagnostics(previousUrl)} to=${redactUrlForDiagnostics(chatCompletionsUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )

        return true
      }

      return false
    }

    // WHY: byte-identity required for implicit prefix caching in
    // OpenAI/Kimi/DeepSeek. stableStringify sorts object keys at every
    // depth so spurious insertion-order differences across rebuilds of
    // `body` (spread-merge, conditional assignments above) don't bust
    // the provider's prefix hash.
    let serializedBody = stableStringify(body)

    const refreshSerializedBody = (): void => {
      serializedBody = stableStringify(body)
    }

    const buildFetchInit = () => ({
      method: 'POST' as const,
      headers,
      body: serializedBody,
      signal: options?.signal,
    })

    const maxSelfHealAttempts = isLocal
      ? localRetryBaseUrls.length + 1
      : 0
    const maxAttempts = (isGithub ? GITHUB_429_MAX_RETRIES : 1) + maxSelfHealAttempts

    const throwClassifiedTransportError = (
      error: unknown,
      requestUrl: string,
      preclassifiedFailure?: ReturnType<typeof classifyOpenAINetworkFailure>,
    ): never => {
      if (options?.signal?.aborted) {
        throw error
      }

      const failure =
        preclassifiedFailure ??
        classifyOpenAINetworkFailure(error, {
          url: requestUrl,
        })
      const redactedUrl = redactUrlForDiagnostics(requestUrl)
      const safeMessage =
        redactSecretValueForDisplay(
          failure.message,
          process.env as SecretValueSource,
        ) || 'Request failed'

      logForDebugging(
        `[OpenAIShim] transport failure category=${failure.category} retryable=${failure.retryable} code=${failure.code ?? 'unknown'} method=POST url=${redactedUrl} model=${request.resolvedModel} message=${safeMessage}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        503,
        undefined,
        buildOpenAICompatibilityErrorMessage(
          `OpenAI API transport error: ${safeMessage}${failure.code ? ` (code=${failure.code})` : ''}`,
          failure,
        ),
        new Headers(),
      )
    }

    const throwClassifiedHttpError = (
      status: number,
      errorBody: string,
      parsedBody: object | undefined,
      responseHeaders: Headers,
      requestUrl: string,
      rateHint = '',
      preclassifiedFailure?: ReturnType<typeof classifyOpenAIHttpFailure>,
    ): never => {
      const failure =
        preclassifiedFailure ??
        classifyOpenAIHttpFailure({
          status,
          body: errorBody,
        })
      const redactedUrl = redactUrlForDiagnostics(requestUrl)

      logForDebugging(
        `[OpenAIShim] request failed category=${failure.category} retryable=${failure.retryable} status=${status} method=POST url=${redactedUrl} model=${request.resolvedModel}`,
        { level: 'warn' },
      )

      throw APIError.generate(
        status,
        parsedBody,
        buildOpenAICompatibilityErrorMessage(
          `OpenAI API error ${status}: ${errorBody}${rateHint}`,
          failure,
        ),
        responseHeaders,
      )
    }

    let response: Response | undefined
    // `logProvider` is the human-readable bucket for analytics/logging only.
    // `dispatcherProvider` MUST match the canonical APIProvider value used by
    // buildFetch() in client.ts so that disableKeepAlive/markProviderH1Only
    // invalidate the same per-provider Agent end-to-end (otherwise the shim
    // and the SDK paths would maintain divergent dispatcher buckets for the
    // same physical endpoint — invalidations from one path wouldn't reach
    // the other, breaking stale-pool eviction and h2-fallback stickiness).
    const logProvider = request.baseUrl.includes('nvidia') ? 'nvidia-nim'
      : request.baseUrl.includes('minimax') ? 'minimax'
      : request.baseUrl.includes('localhost:11434') || request.baseUrl.includes('localhost:11435') ? 'ollama'
      : request.baseUrl.includes('anthropic') ? 'anthropic'
      : 'openai'
    const dispatcherProvider = getAPIProvider()
    const { correlationId, startTime } = logApiCallStart(logProvider, request.resolvedModel)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        response = await fetchWithProxyRetry(
          chatCompletionsUrl,
          buildFetchInit(),
          { provider: dispatcherProvider },
        )
      } catch (error) {
        const isAbortError =
          options?.signal?.aborted === true ||
          (typeof DOMException !== 'undefined' &&
            error instanceof DOMException &&
            error.name === 'AbortError') ||
          (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')

        if (isAbortError) {
          throw error
        }

        const failure = classifyOpenAINetworkFailure(error, {
          url: chatCompletionsUrl,
        })

        if (
          isLocal &&
          failure.category === 'localhost_resolution_failed' &&
          promoteNextLocalBaseUrl('localhost_resolution_failed')
        ) {
          continue
        }

        throwClassifiedTransportError(error, chatCompletionsUrl, failure)
      }

      if (response.ok) {
        let tokensIn = 0
        let tokensOut = 0
        // Skip clone() for streaming responses - it blocks until full body is received,
        // defeating the purpose of streaming. Usage data is already sent via
        // stream_options: { include_usage: true } and can be extracted from the stream.
        if (!params.stream) {
          try {
            const clone = response.clone()
            const data = await clone.json()
            tokensIn = data.usage?.prompt_tokens ?? 0
            tokensOut = data.usage?.completion_tokens ?? 0
          } catch { /* ignore */ }
        }
        logApiCallEnd(correlationId, startTime, request.resolvedModel, 'success', tokensIn, tokensOut, false)
        return response
      }

      if (
        isGithub &&
        response.status === 429 &&
        attempt < maxAttempts - 1
      ) {
        await response.text().catch(() => {})
        const delaySec = Math.min(
          GITHUB_429_BASE_DELAY_SEC * 2 ** attempt,
          GITHUB_429_MAX_DELAY_SEC,
        )
        await sleepMs(delaySec * 1000)
        continue
      }
      // Read body exactly once here — Response body is a stream that can only
      // be consumed a single time.
      const errorBody = await response.text().catch(() => 'unknown error')
      const rateHint =
        isGithub && response.status === 429 ? formatRetryAfterHint(response) : ''

      // If GitHub Copilot returns error about /chat/completions,
      // try the /responses endpoint (needed for GPT-5+ models)
      if (isGithub && response.status === 400) {
        if (errorBody.includes('/chat/completions') || errorBody.includes('not accessible')) {
          const responsesUrl = `${request.baseUrl}/responses`
          const responsesBody: Record<string, unknown> = {
            model: request.resolvedModel,
            input: convertAnthropicMessagesToResponsesInput(
              params.messages as Array<{
                role?: string
                message?: { role?: string; content?: unknown }
                content?: unknown
              }>,
            ),
            stream: params.stream ?? false,
            store: false,
            // Same gating as the chat-completions body above.
            ...(isOfficialOpenAIUrl(request.baseUrl) && {
              prompt_cache_key: getSessionId(),
              prompt_cache_retention: '24h',
            }),
          }

          if (!Array.isArray(responsesBody.input) || responsesBody.input.length === 0) {
            responsesBody.input = [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '' }],
              },
            ]
          }

          const systemText = convertSystemPrompt(params.system)
          if (systemText) {
            responsesBody.instructions = systemText
          }

          if (body.max_tokens !== undefined) {
            responsesBody.max_output_tokens = body.max_tokens
          }

          if (params.tools && params.tools.length > 0) {
            const convertedTools = convertToolsToResponsesTools(
              params.tools as Array<{
                name?: string
                description?: string
                input_schema?: Record<string, unknown>
              }>,
            )
            if (convertedTools.length > 0) {
              responsesBody.tools = convertedTools
            }
          }

          let responsesResponse: Response
          try {
            responsesResponse = await fetchWithProxyRetry(responsesUrl, {
              method: 'POST',
              headers,
              body: stableStringify(responsesBody),
              signal: options?.signal,
            }, { provider: dispatcherProvider })
          } catch (error) {
            throwClassifiedTransportError(error, responsesUrl)
          }

          if (responsesResponse.ok) {
            return responsesResponse
          }
          const responsesErrorBody = await responsesResponse.text().catch(() => 'unknown error')
          const responsesFailure = classifyOpenAIHttpFailure({
            status: responsesResponse.status,
            body: responsesErrorBody,
          })
          let responsesErrorResponse: object | undefined
          try { responsesErrorResponse = JSON.parse(responsesErrorBody) } catch { /* raw text */ }
          throwClassifiedHttpError(
            responsesResponse.status,
            responsesErrorBody,
            responsesErrorResponse,
            responsesResponse.headers,
            responsesUrl,
            '',
            responsesFailure,
          )
        }
      }

      const failure = classifyOpenAIHttpFailure({
        status: response.status,
        body: errorBody,
      })

      if (
        isLocal &&
        failure.category === 'endpoint_not_found' &&
        promoteNextLocalBaseUrl('endpoint_not_found')
      ) {
        continue
      }

      const hasToolsPayload =
        Array.isArray(body.tools) &&
        body.tools.length > 0

      if (
        !didRetryWithoutTools &&
        failure.category === 'tool_call_incompatible' &&
        shouldAttemptLocalToollessRetry({
          baseUrl: activeBaseUrl,
          hasTools: hasToolsPayload,
        })
      ) {
        didRetryWithoutTools = true
        delete body.tools
        delete body.tool_choice
        refreshSerializedBody()

        logForDebugging(
          `[OpenAIShim] self-heal retry reason=tool_call_incompatible mode=toolless method=POST url=${redactUrlForDiagnostics(chatCompletionsUrl)} model=${request.resolvedModel}`,
          { level: 'warn' },
        )
        continue
      }

      let errorResponse: object | undefined
      try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
      throwClassifiedHttpError(
        response.status,
        errorBody,
        errorResponse,
        response.headers as unknown as Headers,
        chatCompletionsUrl,
        rateHint,
        failure,
      )
    }

    throw APIError.generate(
      500, undefined, 'OpenAI shim: request loop exited unexpectedly',
      new Headers(),
    )
  }

  private _convertNonStreamingResponse(
    data: {
      id?: string
      model?: string
      choices?: Array<{
        message?: {
          role?: string
          content?:
            | string
            | null
            | Array<{ type?: string; text?: string }>
          reasoning_content?: string | null
          // Aliases used by other OpenAI-compat providers (OpenRouter, etc.).
          reasoning?: string | null
          reasoning_text?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
            extra_content?: Record<string, unknown>
          }>
        }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: {
          cached_tokens?: number
        }
      }
    },
    model: string,
  ) {
    const choice = data.choices?.[0]
    const content: Array<Record<string, unknown>> = []

    // Some reasoning models (e.g. GLM-5) put their chain-of-thought in a
    // reasoning field while content stays null. Different providers use
    // different aliases (`reasoning_content`, `reasoning`, `reasoning_text`,
    // `thinking`) — normalize via extractReasoningMessage. Preserve it as a
    // thinking block; do not surface it as visible assistant text.
    const reasoningText = extractReasoningMessage(
      (choice?.message ?? {}) as Record<string, unknown>,
    )
    if (reasoningText) {
      content.push({ type: 'thinking', thinking: reasoningText })
    }
    const rawContent =
      choice?.message?.content !== '' && choice?.message?.content != null
        ? choice?.message?.content
        : null
    if (typeof rawContent === 'string' && rawContent) {
      content.push({
        type: 'text',
        text: stripThinkTags(rawContent),
      })
    } else if (Array.isArray(rawContent) && rawContent.length > 0) {
      const parts: string[] = []
      for (const part of rawContent) {
        if (
          part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
        ) {
          parts.push(part.text)
        }
      }
      const joined = parts.join('\n')
      if (joined) {
        content.push({
          type: 'text',
          text: stripThinkTags(joined),
        })
      }
    }

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const input = normalizeToolArguments(
          tc.function.name,
          tc.function.arguments,
        )
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
          // Extract Gemini signature from extra_content
          ...((tc.extra_content?.google as any)?.thought_signature
            ? { signature: (tc.extra_content.google as any).thought_signature }
            : {}),
        })
      }
    }

    const stopReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn'

    if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'safety') {
      content.push({
        type: 'text',
        text: '\n\n[Content blocked by provider safety filter]',
      })
    }

    return {
      id: data.id ?? makeMessageId(),
      type: 'message',
      role: 'assistant',
      content,
      model: data.model ?? model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: buildAnthropicUsageFromRawUsage(
        data.usage as unknown as Record<string, unknown> | undefined,
      ),
    }
  }
}

class OpenAIShimBeta {
  messages: OpenAIShimMessages
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'

  constructor(defaultHeaders: Record<string, string>, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh') {
    this.messages = new OpenAIShimMessages(defaultHeaders, reasoningEffort)
    this.reasoningEffort = reasoningEffort
  }
}

export function createOpenAIShimClient(options: {
  defaultHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}): unknown {
  hydrateGeminiAccessTokenFromSecureStorage()
  hydrateGithubModelsTokenFromSecureStorage()

  const beta = new OpenAIShimBeta({
    ...(options.defaultHeaders ?? {}),
  }, options.reasoningEffort)

  return {
    beta,
    messages: beta.messages,
  }
}
