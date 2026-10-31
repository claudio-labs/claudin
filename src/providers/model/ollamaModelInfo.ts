/**
 * What a local Ollama server says about a model, read once per model.
 *
 * `POST /api/show` carries the model's capabilities (`thinking` among them),
 * its family and the Modelfile parameters (`num_ctx`, `temperature`,
 * `top_p`); `GET /api/ps` the context the loaded runner actually uses. None of
 * it reaches the OpenAI-compatible `/v1` API, so without this Claudin treated
 * every Ollama model as unknown: a 128k window where the runner had 262k,
 * "Effort not supported" for a model that thinks on every request, and
 * `temperature`/`top_p` left out so `/v1` forced 1.0 over the Modelfile.
 *
 * Read lazily (the first request of an Ollama profile awaits it, 2 s at most)
 * and kept in memory; callers that must answer synchronously — the effort
 * picker, `getContextWindowForModel` — read the cache. A failed read is
 * remembered too, so a server that is not Ollama costs one probe per model.
 */
import { getOllamaApiBaseUrl } from 'src/providers/presets/providerDiscovery.js'
import { recordDiscoveredContextWindow } from 'src/providers/model/openaiModelDiscovery.js'
import { logForDebugging } from 'src/shared/debug.js'

export { isOllamaBaseUrl } from 'src/providers/model/ollamaBaseUrl.js'

const DEFAULT_LOAD_TIMEOUT_MS = 2000
// "num_ctx                        262144" — one parameter per line.
const NUMERIC_PARAMETER_RE = /^(\w+)\s+(-?\d+(?:\.\d+)?)\s*$/
// Families whose thinking takes a level; every other thinking model in Ollama
// only turns it on or off (`reasoning_effort: "none"`).
const LEVELED_THINKING_FAMILIES = new Set(['gptoss'])

export type OllamaModelInfo = {
  thinking: boolean
  /** True only where the level changes anything (gpt-oss). */
  thinkingLevels: boolean
  contextWindow?: number
  temperature?: number
  topP?: number
}

type ShowPayload = {
  capabilities?: unknown
  parameters?: unknown
  details?: { family?: unknown }
}

type PsPayload = {
  models?: Array<{ name?: unknown; model?: unknown; context_length?: unknown }>
}

export function parseModelfileParameters(parameters: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof parameters !== 'string') return out
  for (const line of parameters.split('\n')) {
    const match = NUMERIC_PARAMETER_RE.exec(line.trim())
    if (match) out[match[1]!] = Number(match[2])
  }
  return out
}

function stripLatest(model: string): string {
  return model.endsWith(':latest') ? model.slice(0, -':latest'.length) : model
}

function loadedContextLength(payload: PsPayload, model: string): number | undefined {
  const wanted = stripLatest(model)
  for (const entry of payload.models ?? []) {
    const names = [entry.name, entry.model].filter((n): n is string => typeof n === 'string')
    if (!names.some(n => stripLatest(n) === wanted)) continue
    return typeof entry.context_length === 'number' && entry.context_length > 0
      ? entry.context_length
      : undefined
  }
  return undefined
}

export function parseOllamaModelInfo(show: ShowPayload, loadedContext?: number): OllamaModelInfo {
  const capabilities = Array.isArray(show.capabilities) ? show.capabilities : []
  const thinking = capabilities.includes('thinking')
  const family = typeof show.details?.family === 'string' ? show.details.family : ''
  const params = parseModelfileParameters(show.parameters)
  const numCtx = params.num_ctx && params.num_ctx > 0 ? params.num_ctx : undefined
  return {
    thinking,
    thinkingLevels: thinking && LEVELED_THINKING_FAMILIES.has(family),
    contextWindow: loadedContext ?? numCtx,
    temperature: params.temperature,
    topP: params.top_p,
  }
}

const infoByModel = new Map<string, OllamaModelInfo | null>()
const inFlight = new Map<string, Promise<OllamaModelInfo | undefined>>()

export function getCachedOllamaModelInfo(model: string): OllamaModelInfo | undefined {
  return infoByModel.get(model) ?? undefined
}

/** Thinking that only turns on or off: the picker says so instead of "not supported". */
export function ollamaThinkingIsToggleOnly(model: string): boolean {
  const info = getCachedOllamaModelInfo(model)
  return info?.thinking === true && !info.thinkingLevels
}

async function readJson<T>(url: string, init: RequestInit): Promise<T | undefined> {
  const response = await fetch(url, init)
  if (!response.ok) return undefined
  return (await response.json()) as T
}

async function fetchInfo(baseUrl: string, model: string, timeoutMs: number): Promise<OllamaModelInfo | undefined> {
  const apiBase = getOllamaApiBaseUrl(baseUrl)
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const [show, ps] = await Promise.all([
      readJson<ShowPayload>(`${apiBase}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal,
      }),
      readJson<PsPayload>(`${apiBase}/api/ps`, { method: 'GET', signal }).catch(() => undefined),
    ])
    if (!show) {
      infoByModel.set(model, null)
      return undefined
    }
    const info = parseOllamaModelInfo(show, ps ? loadedContextLength(ps, model) : undefined)
    infoByModel.set(model, info)
    if (info.contextWindow) recordDiscoveredContextWindow(model, info.contextWindow)
    return info
  } catch (error) {
    logForDebugging(
      `[ollama] model info for ${model} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    infoByModel.set(model, null)
    return undefined
  }
}

/** The model's info, from cache or read once from the server. */
export function loadOllamaModelInfo(
  baseUrl: string,
  model: string,
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
): Promise<OllamaModelInfo | undefined> {
  if (infoByModel.has(model)) return Promise.resolve(getCachedOllamaModelInfo(model))
  const pending = inFlight.get(model)
  if (pending) return pending
  const promise = fetchInfo(baseUrl, model, timeoutMs).finally(() => inFlight.delete(model))
  inFlight.set(model, promise)
  return promise
}

/**
 * Once the runner has answered, `/api/ps` lists it with the context it was
 * started with. Called when the Modelfile had no `num_ctx` to go on.
 */
export async function refreshOllamaLoadedContext(baseUrl: string, model: string): Promise<void> {
  const info = getCachedOllamaModelInfo(model)
  if (!info || info.contextWindow) return
  try {
    const ps = await readJson<PsPayload>(`${getOllamaApiBaseUrl(baseUrl)}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(DEFAULT_LOAD_TIMEOUT_MS),
    })
    const loaded = ps ? loadedContextLength(ps, model) : undefined
    if (!loaded) return
    infoByModel.set(model, { ...info, contextWindow: loaded })
    recordDiscoveredContextWindow(model, loaded)
  } catch (error) {
    logForDebugging(
      `[ollama] loaded context for ${model} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
  }
}

export function _setOllamaModelInfoForTesting(model: string, info: OllamaModelInfo | null): void {
  infoByModel.set(model, info)
}

export function _resetOllamaModelInfoForTesting(): void {
  infoByModel.clear()
  inFlight.clear()
}
