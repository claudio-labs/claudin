const OLLAMA_PORT = '11434'

/**
 * Ollama by its default port, on any host. Dependency-free on purpose: the
 * cache-metrics bucket resolver needs it and must not pull in the model-info
 * reader (ollamaModelInfo.ts) and its discovery imports.
 */
export function isOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).port === OLLAMA_PORT
  } catch {
    return false
  }
}
