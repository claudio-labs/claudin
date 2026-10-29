/**
 * The model list of the native Gemini API: `GET {base}/models`, which answers
 * in its own shape — `models[].name` as `models/<id>`, a display name, the
 * methods each model supports and its token limits — and takes the key as
 * `x-goog-api-key` (a Bearer API key is refused). Without a key, Application
 * Default Credentials.
 *
 * Two readers: the /provider wizard (`listGeminiModelsDetailed`, the ids) and
 * the /model picker (`refreshGeminiModelOptions`, at startup and on /model,
 * cached per profile like an OpenAI-compatible provider's list). Both record
 * each model's input and output limits as discovered, so the context window
 * and the output cap follow what Google reports, not a table. Vertex AI lists
 * no models this way; its profiles keep the models they name.
 */
import type { ModelOption } from 'src/providers/model/modelOptions.js'
import {
  recordDiscoveredContextWindow,
  recordDiscoveredMaxOutputTokens,
} from 'src/providers/model/openaiModelDiscovery.js'
import {
  resolveGeminiCredential,
  type GeminiResolvedCredential,
} from 'src/providers/oauth/geminiAuth.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { OpenAIModelDiscoveryResult } from 'src/providers/presets/providerDiscovery.js'
import {
  getActiveOpenAIModelOptionsCache,
  setActiveOpenAIModelOptionsCache,
} from 'src/providers/presets/providerProfiles.js'
import {
  geminiVersion,
  isGeminiNativeApiBaseUrl,
  isGeminiNativeRequest,
} from 'src/providers/shims/gemini/endpoints.js'
import { logForDebugging } from 'src/shared/debug.js'

const TRAILING_SLASHES = /\/+$/
const MODELS_PREFIX = /^models\//
// generateContent models that are not a chat model to run a session on.
const NOT_FOR_CHAT_RE =
  /(?:tts|image|audio|live|transcribe|translate|robotics|computer-use|embedding|aqa|nano-banana|omni)/i

export type GeminiModelInfo = {
  id: string
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
}

type ListFailure = Extract<OpenAIModelDiscoveryResult, { ok: false }>

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

export function parseGeminiModelList(data: unknown): GeminiModelInfo[] {
  const models = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  const result: GeminiModelInfo[] = []
  for (const model of models as Array<Record<string, unknown>>) {
    const id = typeof model.name === 'string' ? model.name.replace(MODELS_PREFIX, '').trim() : ''
    const methods = model.supportedGenerationMethods
    if (!id || seen.has(id)) continue
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue
    seen.add(id)
    const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : ''
    const input = positive(model.inputTokenLimit)
    const output = positive(model.outputTokenLimit)
    result.push({
      id,
      ...(displayName && { displayName }),
      ...(input && { inputTokenLimit: input }),
      ...(output && { outputTokenLimit: output }),
    })
  }
  return result
}

function recordLimits(model: GeminiModelInfo): void {
  if (model.inputTokenLimit) recordDiscoveredContextWindow(model.id, model.inputTokenLimit)
  if (model.outputTokenLimit) recordDiscoveredMaxOutputTokens(model.id, model.outputTokenLimit)
}

async function authHeaders(
  apiKey: string | undefined,
  resolveCredential: () => Promise<GeminiResolvedCredential>,
): Promise<Record<string, string> | undefined> {
  if (apiKey) return { 'x-goog-api-key': apiKey }
  const credential = await resolveCredential()
  if (credential.kind !== 'adc') return undefined
  return {
    Authorization: `Bearer ${credential.credential}`,
    ...(credential.projectId && { 'x-goog-user-project': credential.projectId }),
  }
}

type ListOptions = {
  baseUrl: string
  apiKey?: string
  resolveCredential?: () => Promise<GeminiResolvedCredential>
  recordLimits?: (model: GeminiModelInfo) => void
}

async function fetchGeminiModels(
  options: ListOptions,
): Promise<{ ok: true; models: GeminiModelInfo[] } | ListFailure> {
  const headers = await authHeaders(
    options.apiKey,
    options.resolveCredential ?? (() => resolveGeminiCredential(process.env)),
  )
  if (!headers) return { ok: false, reason: 'unauthorized' }

  const url = `${options.baseUrl.replace(TRAILING_SLASHES, '')}/models?pageSize=1000`
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(5000) })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      // Gemini answers a bad key with 400 API_KEY_INVALID.
      return { ok: false, reason: 'unauthorized', status: response.status }
    }
    if (response.status === 403) return { ok: false, reason: 'forbidden', status: 403 }
    if (response.status === 404) return { ok: false, reason: 'not_found', status: 404 }
    return { ok: false, reason: 'server_error', status: response.status }
  }

  const models = parseGeminiModelList(await response.json().catch(() => null))
  if (models.length === 0) return { ok: false, reason: 'invalid_response' }
  models.forEach(options.recordLimits ?? recordLimits)
  return { ok: true, models }
}

/** The ids, for the /provider wizard. */
export async function listGeminiModelsDetailed(options: ListOptions): Promise<OpenAIModelDiscoveryResult> {
  const result = await fetchGeminiModels(options)
  return result.ok ? { ok: true, ids: result.models.map(model => model.id) } : result
}

function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M ctx` : `${Math.round(tokens / 1_000)}K ctx`
}

/** The chat models, newest family first, as /model picker entries. */
export function geminiModelOptions(models: readonly GeminiModelInfo[]): ModelOption[] {
  return models
    .filter(model => !NOT_FOR_CHAT_RE.test(model.id))
    .sort((a, b) => (geminiVersion(b.id) ?? 0) - (geminiVersion(a.id) ?? 0) || a.id.localeCompare(b.id))
    .map(model => ({
      value: model.id,
      label: model.displayName ?? model.id,
      description: model.inputTokenLimit ? `${model.id} · ${formatWindow(model.inputTokenLimit)}` : model.id,
    }))
}

function sameOptions(left: readonly ModelOption[], right: readonly ModelOption[]): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const other = right[index]
      return other?.value === option.value && other.label === option.label && other.description === option.description
    })
  )
}

/**
 * Read Google's list for the active native Gemini profile and keep it as the
 * profile's /model options. Fire-and-forget at startup and on /model: a
 * failure keeps the last list, and the limits fall back to the family's
 * (endpoints.ts).
 */
export async function refreshGeminiModelOptions(
  deps: Pick<ListOptions, 'resolveCredential' | 'recordLimits'> = {},
): Promise<void> {
  const profile = tryGetActiveProvider()
  if (!profile || !isGeminiNativeRequest(profile.baseUrl) || !isGeminiNativeApiBaseUrl(profile.baseUrl)) {
    return
  }
  try {
    const result = await fetchGeminiModels({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, ...deps })
    if (!result.ok) {
      logForDebugging(`[ModelDiscovery] Gemini model list unavailable: ${result.reason}`)
      return
    }
    const options = geminiModelOptions(result.models)
    if (options.length > 0 && !sameOptions(options, getActiveOpenAIModelOptionsCache())) {
      setActiveOpenAIModelOptionsCache(options)
    }
  } catch (error) {
    logForDebugging(`[ModelDiscovery] Gemini model list failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
