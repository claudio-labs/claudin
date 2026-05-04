import axios from 'axios'
import { tryGetActiveProvider } from '../../services/api/activeProvider.js'
import { getAdditionalModelOptionsCacheScope } from '../../services/api/providerConfig.js'
import { logForDebugging } from '../debug.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
import { setActiveOpenAIModelOptionsCache } from '../providerProfiles.js'

const DISCOVERY_TIMEOUT_MS = 5000

// Model id → context window (tokens), populated from the provider's /models API.
// Consulted by getOpenAIContextWindow() so auto-compact uses the real value
// instead of the 128k fallback for models not in the hardcoded table.
const discoveredContextWindows = new Map<string, number>()

export function getDiscoveredContextWindow(model: string): number | undefined {
  return discoveredContextWindows.get(model)
}

type OpenAIModelsResponse = {
  data?: Array<{
    id?: string | null
    name?: string | null
    context_length?: number | null
  }>
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: string | null
  }>
}

function getNormalizedOpenAIBaseUrl(): string {
  return (
    tryGetActiveProvider()?.baseUrl ?? 'https://api.openai.com/v1'
  ).replace(/\/+$/, '')
}

function isAzureOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return (
      hostname.endsWith('.openai.azure.com') ||
      hostname.endsWith('.cognitiveservices.azure.com')
    )
  } catch {
    return false
  }
}

function isBankrBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes('bankr')
  } catch {
    return false
  }
}

function getOpenAIAuthHeaders(baseUrl: string): Record<string, string> {
  const apiKey = tryGetActiveProvider()?.apiKey?.trim()
  if (!apiKey) {
    return {}
  }

  if (isBankrBaseUrl(baseUrl)) {
    return { 'X-API-Key': apiKey }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }

  if (isAzureOpenAIBaseUrl(baseUrl)) {
    headers['api-key'] = apiKey
  }

  return headers
}

function getModelListUrls(baseUrl: string): string[] {
  const primary = baseUrl.endsWith('/v1')
    ? `${baseUrl}/models`
    : `${baseUrl}/v1/models`
  const secondary = `${baseUrl}/models`

  const apiVersion = process.env.OPENAI_API_VERSION?.trim()
  const addApiVersion =
    apiVersion && isAzureOpenAIBaseUrl(baseUrl)
      ? (url: string): string => {
          try {
            const parsed = new URL(url)
            parsed.searchParams.set('api-version', apiVersion)
            return parsed.toString()
          } catch {
            return url
          }
        }
      : (url: string): string => url

  if (primary === secondary) {
    return [addApiVersion(primary)]
  }

  return [addApiVersion(primary), addApiVersion(secondary)]
}

function getOllamaTagsUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    const normalizedPath = parsed.pathname.replace(/\/+$/, '')
    const pathPrefix = normalizedPath.endsWith('/v1')
      ? normalizedPath.slice(0, -3)
      : normalizedPath
    const tagsPath = `${pathPrefix}/api/tags`.replace(/\/{2,}/g, '/')
    return `${parsed.origin}${tagsPath}`
  } catch {
    return null
  }
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`
  return `${tokens} ctx`
}

async function fetchOpenAIModels(
  urls: string[],
  headers: Record<string, string>,
): Promise<ModelOption[]> {
  const seen = new Set<string>()
  for (const url of urls) {
    try {
      const response = await axios.get<OpenAIModelsResponse>(url, {
        headers,
        timeout: DISCOVERY_TIMEOUT_MS,
      })
      const options: ModelOption[] = []
      for (const model of response.data?.data ?? []) {
        const id = model.id?.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const label = model.name?.trim() || id
        const ctx = model.context_length ?? null
        if (ctx && ctx > 0) discoveredContextWindows.set(id, ctx)
        const ctxPart = ctx ? ` · ${formatContextWindow(ctx)}` : ''
        options.push({
          value: id,
          label,
          description: `${id}${ctxPart}`,
        })
      }
      if (options.length > 0) {
        options.sort((a, b) => {
          const aProvider = String(a.value).split('/')[0] ?? ''
          const bProvider = String(b.value).split('/')[0] ?? ''
          const providerCmp = aProvider.localeCompare(bProvider)
          return providerCmp !== 0 ? providerCmp : String(a.value).localeCompare(String(b.value))
        })
        return options
      }
    } catch {
      logForDebugging(`[ModelDiscovery] Failed to fetch OpenAI models from ${url}`)
    }
  }
  return []
}

async function fetchOllamaModels(
  url: string,
  headers: Record<string, string>,
): Promise<ModelOption[]> {
  try {
    const response = await axios.get<OllamaTagsResponse>(url, {
      headers,
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const seen = new Set<string>()
    return (response.data?.models ?? [])
      .map(model => model.name?.trim() ?? '')
      .filter(name => {
        if (!name || seen.has(name)) return false
        seen.add(name)
        return true
      })
      .map(name => ({ value: name, label: name, description: 'Ollama model' }))
  } catch {
    logForDebugging(`[ModelDiscovery] Failed to fetch Ollama models from ${url}`)
    return []
  }
}

export async function discoverOpenAICompatibleModelOptions(): Promise<
  ModelOption[]
> {
  if (getAPIProvider() !== 'openai') {
    return []
  }

  const baseUrl = getNormalizedOpenAIBaseUrl()
  const headers = getOpenAIAuthHeaders(baseUrl)

  const discovered = await fetchOpenAIModels(getModelListUrls(baseUrl), headers)
  if (discovered.length > 0) return discovered

  const ollamaTagsUrl = getOllamaTagsUrl(baseUrl)
  if (ollamaTagsUrl) {
    return fetchOllamaModels(ollamaTagsUrl, headers)
  }

  return []
}

let prefetchPromise: Promise<void> | null = null

/**
 * Prefetch and cache model options for the active OpenAI-compat provider at
 * startup. No-ops for Ollama (handled separately), firstParty, and non-openai
 * providers. Safe to call multiple times — only one fetch runs at a time.
 */
export function prefetchOpenAICompatibleModels(): Promise<void> {
  if (prefetchPromise) return prefetchPromise
  prefetchPromise = (async () => {
    const scope = getAdditionalModelOptionsCacheScope()
    if (!scope?.startsWith('openai:')) return
    try {
      const options = await discoverOpenAICompatibleModelOptions()
      if (options.length > 0) {
        setActiveOpenAIModelOptionsCache(options)
      }
    } catch {
      // Non-fatal — /model will still work with profile-defined models
    } finally {
      prefetchPromise = null
    }
  })()
  return prefetchPromise
}