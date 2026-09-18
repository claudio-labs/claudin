import type { OllamaModelDescriptor } from 'src/providers/presets/providerRecommendation.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { DEFAULT_OPENAI_BASE_URL } from 'src/providers/presets/providerConfig.js'

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
export const DEFAULT_ATOMIC_CHAT_BASE_URL = 'http://127.0.0.1:1337'

export type OllamaGenerationReadiness = {
  state: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
  models: OllamaModelDescriptor[]
  probeModel?: string
  detail?: string
}

function withTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal
  clear: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function compactDetail(value: string, maxLength = 180): string {
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!compact) {
    return ''
  }

  if (compact.length <= maxLength) {
    return compact
  }

  return `${compact.slice(0, maxLength)}...`
}

type OllamaTagsPayload = {
  models?: Array<{
    name?: string
    size?: number
    details?: {
      family?: string
      families?: string[]
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

function normalizeOllamaModels(
  payload: OllamaTagsPayload,
): OllamaModelDescriptor[] {
  return (payload.models ?? [])
    .filter(model => Boolean(model.name))
    .map(model => ({
      name: model.name!,
      sizeBytes: typeof model.size === 'number' ? model.size : null,
      family: model.details?.family ?? null,
      families: model.details?.families ?? [],
      parameterSize: model.details?.parameter_size ?? null,
      quantizationLevel: model.details?.quantization_level ?? null,
    }))
}

async function fetchOllamaModelsProbe(
  baseUrl?: string,
  timeoutMs = 5000,
): Promise<{
  reachable: boolean
  models: OllamaModelDescriptor[]
}> {
  const { signal, clear } = withTimeoutSignal(timeoutMs)
  try {
    const response = await fetch(`${getOllamaApiBaseUrl(baseUrl)}/api/tags`, {
      method: 'GET',
      signal,
    })

    if (!response.ok) {
      return {
        reachable: false,
        models: [],
      }
    }

    const payload = (await response.json().catch(() => ({}))) as OllamaTagsPayload
    return {
      reachable: true,
      models: normalizeOllamaModels(payload),
    }
  } catch {
    return {
      reachable: false,
      models: [],
    }
  } finally {
    clear()
  }
}

export function getOllamaApiBaseUrl(baseUrl?: string): string {
  const parsed = new URL(
    baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  )
  const pathname = trimTrailingSlash(parsed.pathname)
  parsed.pathname = pathname.endsWith('/v1')
    ? pathname.slice(0, -3) || '/'
    : pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return trimTrailingSlash(parsed.toString())
}

export function getAtomicChatApiBaseUrl(baseUrl?: string): string {
  const parsed = new URL(
    baseUrl || process.env.ATOMIC_CHAT_BASE_URL || DEFAULT_ATOMIC_CHAT_BASE_URL,
  )
  const pathname = trimTrailingSlash(parsed.pathname)
  parsed.pathname = pathname.endsWith('/v1')
    ? pathname.slice(0, -3) || '/'
    : pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return trimTrailingSlash(parsed.toString())
}

export function getAtomicChatChatBaseUrl(baseUrl?: string): string {
  return `${getAtomicChatApiBaseUrl(baseUrl)}/v1`
}

export function getOpenAICompatibleModelsBaseUrl(baseUrl?: string): string {
  return (
    baseUrl || tryGetActiveProvider()?.baseUrl || DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/, '')
}

export function getLocalOpenAICompatibleProviderLabel(baseUrl?: string): string {
  try {
    const parsed = new URL(getOpenAICompatibleModelsBaseUrl(baseUrl))
    const host = parsed.host.toLowerCase()
    const hostname = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    const haystack = `${hostname} ${path}`

    if (
      host.endsWith(':1234') ||
      haystack.includes('lmstudio') ||
      haystack.includes('lm-studio')
    ) {
      return 'LM Studio'
    }
    if (host.endsWith(':11434') || haystack.includes('ollama')) {
      return 'Ollama'
    }
    if (haystack.includes('localai')) {
      return 'LocalAI'
    }
    if (haystack.includes('jan')) {
      return 'Jan'
    }
    if (haystack.includes('kobold')) {
      return 'KoboldCpp'
    }
    if (haystack.includes('llama.cpp') || haystack.includes('llamacpp')) {
      return 'llama.cpp'
    }
    if (haystack.includes('vllm')) {
      return 'vLLM'
    }
    if (
      haystack.includes('open-webui') ||
      haystack.includes('openwebui')
    ) {
      return 'Open WebUI'
    }
    if (
      haystack.includes('text-generation-webui') ||
      haystack.includes('oobabooga')
    ) {
      return 'text-generation-webui'
    }
    // Check for NVIDIA NIM
    if (host.includes('nvidia') || haystack.includes('nvidia') || host.includes('integrate.api.nvidia')) {
      return 'NVIDIA NIM'
    }
    // Check for MiniMax (both api.minimax.io and api.minimax.chat)
    if (host.includes('minimax') || haystack.includes('minimax')) {
      return 'MiniMax'
    }
    // Kimi Code subscription API
    if (hostname === 'api.kimi.com' && path.includes('/coding')) {
      return 'Moonshot AI'
    }
    // Check for Bankr LLM gateway
    if (host.includes('bankr') || haystack.includes('bankr')) {
      return 'Bankr'
    }
    // Moonshot AI direct API
    if (
      host.includes('moonshot') ||
      haystack.includes('moonshot') ||
      haystack.includes('kimi')
    ) {
      return 'Moonshot AI - API'
    }
  } catch {
    // Fall back to the generic label when the base URL is malformed.
  }

  return 'Local OpenAI-compatible'
}

export type OpenAIModelDiscoveryResult =
  | { ok: true; ids: string[] }
  | {
      ok: false
      reason:
        | 'unauthorized'
        | 'forbidden'
        | 'not_found'
        | 'server_error'
        | 'invalid_response'
        | 'network'
      status?: number
    }

function getOpenAIModelListCandidates(baseUrl: string): string[] {
  const trimmed = trimTrailingSlash(baseUrl)
  // Mirror the boot-prefetch URL candidates (openaiModelDiscovery
  // getModelListUrls): a base that already ends in /v1 only needs /models;
  // a bare base tries /v1/models first, then /models.
  if (trimmed.endsWith('/v1')) {
    return [`${trimmed}/models`]
  }
  return [`${trimmed}/v1/models`, `${trimmed}/models`]
}

/**
 * Fetch the model list from an OpenAI-compatible provider AND report WHY the
 * fetch failed, so the /provider wizard can point at the API key vs the base
 * URL instead of a generic failure. Auth failures stop the URL walk — retrying
 * with a different path cannot fix a 401.
 */
export async function listOpenAICompatibleModelsDetailed(options?: {
  baseUrl?: string
  apiKey?: string
}): Promise<OpenAIModelDiscoveryResult> {
  const baseUrl = getOpenAICompatibleModelsBaseUrl(options?.baseUrl)
  const isBankr = baseUrl.toLowerCase().includes('bankr')
  const headers: Record<string, string> | undefined = options?.apiKey
    ? isBankr
      ? { 'X-API-Key': options.apiKey }
      : { Authorization: `Bearer ${options.apiKey}` }
    : undefined

  let lastStatus: number | undefined
  let sawNotFound = false

  for (const url of getOpenAIModelListCandidates(baseUrl)) {
    const { signal, clear } = withTimeoutSignal(5000)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal,
      })
      if (!response.ok) {
        lastStatus = response.status
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            reason:
              response.status === 401 ? 'unauthorized' : 'forbidden',
            status: response.status,
          }
        }
        if (response.status === 404) {
          sawNotFound = true
          continue
        }
        continue
      }

      const data = (await response.json()) as {
        data?: Array<{ id?: string }>
      }

      const ids = Array.from(
        new Set(
          (data.data ?? [])
            .filter(model => Boolean(model.id))
            .map(model => model.id!),
        ),
      )
      if (ids.length === 0) {
        return { ok: false, reason: 'invalid_response' }
      }
      return { ok: true, ids }
    } catch {
      lastStatus = undefined
      continue
    } finally {
      clear()
    }
  }

  if (sawNotFound) {
    return { ok: false, reason: 'not_found', status: lastStatus ?? 404 }
  }
  if (lastStatus !== undefined) {
    return { ok: false, reason: 'server_error', status: lastStatus }
  }
  return { ok: false, reason: 'network' }
}

export async function listOpenAICompatibleModels(options?: {
  baseUrl?: string
  apiKey?: string
}): Promise<string[] | null> {
  const result = await listOpenAICompatibleModelsDetailed(options)
  return result.ok ? result.ids : null
}

type DiscoveryFailure = Extract<
  OpenAIModelDiscoveryResult,
  { ok: false }
>

/**
 * Turn a failed discovery into one line the user can act on. Pure — no ink
 * imports — so it stays unit-testable like buildDiscoveredModelOptions.
 */
export function describeDiscoveryFailure(result: DiscoveryFailure): string {
  const retryHint =
    'Enter the model id manually, or go back to check the base URL and API key.'
  switch (result.reason) {
    case 'unauthorized':
      return `The provider rejected the API key (HTTP 401). ${retryHint}`
    case 'forbidden':
      return `The provider refused access for this API key (HTTP 403). ${retryHint}`
    case 'not_found':
      return `No /models endpoint at this base URL (HTTP 404). If your base URL is missing a /v1 suffix, add it and try again. ${retryHint}`
    case 'server_error':
      return `The provider's model list is failing server-side (HTTP ${result.status ?? 5}). ${retryHint}`
    case 'invalid_response':
      return `The provider answered, but returned no usable model list. ${retryHint}`
    case 'network':
      return `Could not reach the provider (network error or timeout). ${retryHint}`
  }
}

export type DiscoveredModelOptions = {
  options: Array<{ value: string; label: string }>
  defaultValue?: string
}

/**
 * Turn a raw list of discovered model ids into `Select`-ready options: deduped,
 * sorted alphabetically (case-insensitive), mapped to `{ value, label }`.
 *
 * `defaultValue` is set only when `currentModel` exactly matches one discovered
 * id. For an off-list id or a multi-model (";"/",") value it stays `undefined`,
 * so the caller can focus the manual-entry row and avoid overwriting the saved
 * value. Returns a plain `{ value, label }` shape (assignable to the
 * `OptionWithDescription` used by the picker) so this stays free of ink imports
 * and unit-testable.
 */
export function buildDiscoveredModelOptions(
  ids: string[],
  currentModel?: string,
): DiscoveredModelOptions {
  const options = Array.from(new Set(ids))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(id => ({ value: id, label: id }))
  const trimmed = currentModel?.trim()
  const defaultValue =
    trimmed && options.some(option => option.value === trimmed)
      ? trimmed
      : undefined
  return { options, defaultValue }
}

export async function hasLocalAtomicChat(baseUrl?: string): Promise<boolean> {
  const { signal, clear } = withTimeoutSignal(1200)
  try {
    const response = await fetch(`${getAtomicChatChatBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clear()
  }
}

export async function listAtomicChatModels(
  baseUrl?: string,
): Promise<string[]> {
  const { signal, clear } = withTimeoutSignal(5000)
  try {
    const response = await fetch(`${getAtomicChatChatBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      signal,
    })
    if (!response.ok) {
      return []
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>
    }

    return (data.data ?? [])
      .filter(model => Boolean(model.id))
      .map(model => model.id!)
  } catch {
    return []
  } finally {
    clear()
  }
}

export type AtomicChatReadiness =
  | { state: 'unreachable' }
  | { state: 'no_models' }
  | { state: 'ready'; models: string[] }

export async function probeAtomicChatReadiness(options?: {
  baseUrl?: string
}): Promise<AtomicChatReadiness> {
  if (!(await hasLocalAtomicChat(options?.baseUrl))) {
    return { state: 'unreachable' }
  }
  const models = await listAtomicChatModels(options?.baseUrl)
  if (models.length === 0) {
    return { state: 'no_models' }
  }
  return { state: 'ready', models }
}

export async function probeOllamaGenerationReadiness(options?: {
  baseUrl?: string
  model?: string
  timeoutMs?: number
}): Promise<OllamaGenerationReadiness> {
  const timeoutMs = options?.timeoutMs ?? 8000
  const { reachable, models } = await fetchOllamaModelsProbe(
    options?.baseUrl,
    timeoutMs,
  )
  if (!reachable) {
    return {
      state: 'unreachable',
      models: [],
    }
  }

  if (models.length === 0) {
    return {
      state: 'no_models',
      models: [],
    }
  }

  const requestedModel = options?.model?.trim() || undefined
  if (requestedModel && !models.some(model => model.name === requestedModel)) {
    return {
      state: 'generation_failed',
      models,
      probeModel: requestedModel,
      detail: `requested model not installed: ${requestedModel}`,
    }
  }

  const probeModel = requestedModel ?? models[0]!.name
  const { signal, clear } = withTimeoutSignal(timeoutMs)

  try {
    const response = await fetch(`${getOllamaApiBaseUrl(options?.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: probeModel,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        options: {
          temperature: 0,
          num_predict: 8,
        },
      }),
    })

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      const detailSuffix = compactDetail(responseBody)
      return {
        state: 'generation_failed',
        models,
        probeModel,
        detail: detailSuffix
          ? `status ${response.status}: ${detailSuffix}`
          : `status ${response.status}`,
      }
    }

    try {
      await response.json()
    } catch {
      return {
        state: 'generation_failed',
        models,
        probeModel,
        detail: 'invalid JSON response',
      }
    }

    return {
      state: 'ready',
      models,
      probeModel,
    }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'request timed out'
          : error.message
        : String(error)

    return {
      state: 'generation_failed',
      models,
      probeModel,
      detail,
    }
  } finally {
    clear()
  }
}
