/**
 * The name to show a user for whatever provider is currently answering.
 *
 * Prefers the active profile's own name, because `getAPIProvider()` is a
 * transport tag rather than an identity: it returns `openai` for xAI, Kimi,
 * Ollama, MiniMax, NVIDIA and every other OpenAI-compatible endpoint alike.
 * The tag map is only the fallback for env-var-only setups that never created
 * a profile.
 */

import { getAPIProvider } from 'src/providers/model/providers.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'

const TRANSPORT_LABELS: Record<string, string> = {
  firstParty: 'Anthropic',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  openai: 'OpenAI-compatible',
  codex: 'Codex',
  gemini: 'Google Gemini',
  github: 'GitHub Copilot',
  mistral: 'Mistral',
  minimax: 'MiniMax',
  'nvidia-nim': 'NVIDIA NIM',
}

/**
 * Pure half, so the mapping is testable without a configured profile.
 * `src/platform/status/status.tsx` and `src/platform/settings/ui/Usage.tsx`
 * keep their own copies of this map on purpose — theirs are worded for the
 * sentences they appear in ("this OpenAI-compatible provider").
 */
export function resolveProviderLabel(
  profileName: string | undefined,
  transport: string,
): string {
  if (profileName !== undefined && profileName !== '') return profileName
  return TRANSPORT_LABELS[transport] ?? 'this provider'
}

export function getActiveProviderLabel(): string {
  return resolveProviderLabel(tryGetActiveProvider()?.name, getAPIProvider())
}
