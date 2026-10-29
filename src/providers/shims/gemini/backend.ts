/**
 * The native Gemini transport: `models/{m}:streamGenerateContent?alt=sse` and
 * `:generateContent`, the wire gemini-cli speaks, for the `gemini` provider.
 * It rides the OpenAI shim client the way the Codex backend does:
 * `_doRequest` hands the request here, and stream.ts / response.ts turn the
 * answer back into Anthropic events.
 *
 * Which profiles take it: transport `gemini` with any base URL that does not
 * end in `/openai`. A profile on the OpenAI-compatible endpoint
 * (`…/v1beta/openai`, or a proxy that speaks it) stays on the Chat
 * Completions path it always used.
 *
 * Auth: a profile API key goes out as `x-goog-api-key`; without one, Google
 * Application Default Credentials (`gcloud auth application-default login`)
 * as a Bearer token with `x-goog-user-project`. A base URL on
 * `aiplatform.googleapis.com` is Vertex AI: the project and region come from
 * the profile's `extras.gcpProject` / `extras.gcpRegion`. The Code Assist
 * endpoint gemini-cli signs in to with a Google account is not used — its
 * terms forbid third-party clients.
 *
 * CLAUDIN_GEMINI_NATIVE=0 sends every Gemini profile through the
 * OpenAI-compatible path again.
 */
import { APIError } from '@anthropic-ai/sdk'
import {
  resolveGeminiCredential,
  type GeminiResolvedCredential,
} from 'src/providers/oauth/geminiAuth.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { ResolvedProviderRequest } from 'src/providers/presets/providerConfig.js'
import { buildGeminiRequestBody } from 'src/providers/shims/gemini/request.js'
import {
  isVertexGeminiBaseUrl,
  VERTEX_GLOBAL_HOST,
} from 'src/providers/shims/gemini/endpoints.js'
import type { ShimCreateParams } from 'src/providers/shims/codexShim.js'
import { fetchWithProxyRetry } from 'src/providers/transport/fetchWithProxyRetry.js'
import { getClaudinUserAgent } from 'src/providers/transport/userAgent.js'
import { stableStringify } from 'src/shared/data/stableStringify.js'

export { isGeminiNativeRequest } from 'src/providers/shims/gemini/endpoints.js'

const TRAILING_SLASHES = /\/+$/
const MODELS_PREFIX = /^models\//

export type VertexLocation = { project: string; region: string }

export function buildGeminiUrl(options: {
  baseUrl: string
  model: string
  stream: boolean
  vertex?: VertexLocation
}): string {
  const model = options.model.replace(MODELS_PREFIX, '')
  const method = options.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  if (options.vertex) {
    const { project, region } = options.vertex
    const host = region === 'global' ? VERTEX_GLOBAL_HOST : `${region}-${VERTEX_GLOBAL_HOST}`
    return `https://${host}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:${method}`
  }
  return `${options.baseUrl.replace(TRAILING_SLASHES, '')}/models/${model}:${method}`
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** The auth headers for the active profile, and the project ADC resolved. */
async function resolveAuth(
  resolveCredential: () => Promise<GeminiResolvedCredential>,
): Promise<{
  headers: Record<string, string>
  adcProject?: string
}> {
  const credential = await resolveCredential()
  if (credential.kind === 'api-key') {
    return { headers: { 'x-goog-api-key': credential.credential } }
  }
  if (credential.kind === 'adc') {
    const project = firstNonEmpty(
      tryGetActiveProvider()?.extras?.gcpProject,
      credential.projectId,
    )
    return {
      headers: {
        Authorization: `Bearer ${credential.credential}`,
        ...(project && { 'x-goog-user-project': project }),
      },
      adcProject: credential.projectId,
    }
  }
  throw APIError.generate(
    401,
    undefined,
    'Gemini auth is missing: add an API key in /provider, or sign in with `gcloud auth application-default login`.',
    new Headers(),
  )
}

function resolveVertexLocation(adcProject: string | undefined): VertexLocation {
  const extras = tryGetActiveProvider()?.extras
  const project = firstNonEmpty(
    extras?.gcpProject,
    process.env.GOOGLE_CLOUD_PROJECT,
    adcProject,
  )
  if (!project) {
    throw APIError.generate(
      400,
      undefined,
      'Gemini on Vertex AI needs a GCP project: set it in /provider or GOOGLE_CLOUD_PROJECT.',
      new Headers(),
    )
  }
  const region =
    firstNonEmpty(extras?.gcpRegion, process.env.GOOGLE_CLOUD_LOCATION) ?? 'global'
  return { project, region }
}

export async function performGeminiRequest(options: {
  request: ResolvedProviderRequest
  params: ShimCreateParams
  defaultHeaders: Record<string, string>
  signal?: AbortSignal
  /** Tests stand in for Google ADC here. */
  resolveCredential?: () => Promise<GeminiResolvedCredential>
}): Promise<Response> {
  const { request, params } = options
  const auth = await resolveAuth(
    options.resolveCredential ?? (() => resolveGeminiCredential(process.env)),
  )
  const stream = params.stream ?? false
  const url = buildGeminiUrl({
    baseUrl: request.baseUrl,
    model: request.resolvedModel,
    stream,
    ...(isVertexGeminiBaseUrl(request.baseUrl) && {
      vertex: resolveVertexLocation(auth.adcProject),
    }),
  })
  const body = buildGeminiRequestBody(params, {
    model: request.resolvedModel,
    baseUrl: request.baseUrl,
    effort: request.reasoning?.effort,
  })

  const response = await fetchWithProxyRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.defaultHeaders,
        'User-Agent': getClaudinUserAgent(),
        ...auth.headers,
      },
      // WHY: byte-identity required for Gemini's implicit prefix caching.
      // See src/shared/data/stableStringify.ts.
      body: stableStringify(body),
      signal: options.signal,
    },
    { provider: 'gemini' },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown error')
    let errorResponse: object | undefined
    try {
      errorResponse = JSON.parse(errorBody)
    } catch {
      // raw text
    }
    throw APIError.generate(
      response.status,
      errorResponse,
      `Gemini API error ${response.status}: ${errorBody}`,
      response.headers as unknown as Headers,
    )
  }
  return response
}
