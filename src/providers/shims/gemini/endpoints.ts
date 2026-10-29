/**
 * What a Gemini base URL is. A leaf module on purpose: the reasoning catalog
 * and the effort defaults ask these too, and the transport (backend.ts)
 * imports both of them.
 */
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

const GEMINI_API_HOST = 'generativelanguage.googleapis.com'
export const VERTEX_GLOBAL_HOST = 'aiplatform.googleapis.com'

const TRAILING_SLASHES = /\/+$/
// Anchored at both ends, as reasoningCatalog.ts explains for the same host.
const VERTEX_HOST_RE = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/
const GEMINI_VERSION_RE = /gemini-(\d+)(?:\.(\d+))?/i

/** A base URL that speaks Gemini's OpenAI-compatible surface. */
export function isGeminiCompatBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).pathname.replace(TRAILING_SLASHES, '').endsWith('/openai')
  } catch {
    return false
  }
}

export function isVertexGeminiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return VERTEX_HOST_RE.test(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** The Gemini API itself (not Vertex), on its native surface. */
export function isGeminiNativeApiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl || isGeminiCompatBaseUrl(baseUrl)) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() === GEMINI_API_HOST
  } catch {
    return false
  }
}

/**
 * Where the OpenAI-compatible path posts for a Gemini API base URL: under
 * `/openai`. Only reached for a native URL with CLAUDIN_GEMINI_NATIVE=0;
 * every other URL comes back as it was.
 */
export function geminiCompatBaseUrl(baseUrl: string): string {
  return isGeminiNativeApiBaseUrl(baseUrl)
    ? `${baseUrl.replace(TRAILING_SLASHES, '')}/openai`
    : baseUrl
}

/**
 * Whether a request on the active profile goes out on the native wire
 * (backend.ts): transport `gemini`, a Google endpoint that speaks it — the
 * Gemini API off `/openai`, or Vertex AI — and CLAUDIN_GEMINI_NATIVE not set
 * to 0. Any other base URL on a Gemini profile is a proxy set up for the
 * OpenAI-compatible wire (LiteLLM and the like) and stays on it.
 */
export function isGeminiNativeRequest(baseUrl: string | undefined): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDIN_GEMINI_NATIVE)) return false
  if (tryGetActiveProvider()?.transport !== 'gemini') return false
  return isGeminiNativeApiBaseUrl(baseUrl) || isVertexGeminiBaseUrl(baseUrl)
}

/** `gemini-3.1-pro-preview` → 3.1, `gemini-2.5-flash` → 2.5; undefined for anything else. */
export function geminiVersion(model: string): number | undefined {
  const match = GEMINI_VERSION_RE.exec(model)
  if (!match) return undefined
  return Number(`${match[1]}.${match[2] ?? '0'}`)
}

/**
 * The limits every Gemini text model from 2.5 on shares — 1,048,576 input
 * tokens, up to 65,536 out — for an id no table lists yet: Google ships new
 * ones every few weeks. The real per-model limits come first, from Google's
 * model list (models.ts records them as discovered).
 */
export function geminiFamilyLimits(
  model: string,
): { contextWindow: number; maxOutputTokens: number } | undefined {
  const version = geminiVersion(model)
  return version !== undefined && version >= 2.5
    ? { contextWindow: 1_048_576, maxOutputTokens: 65_536 }
    : undefined
}
