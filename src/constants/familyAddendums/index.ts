import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import {
  isGlmCompatibleBaseUrl,
  isMoonshotCompatibleBaseUrl,
} from 'src/services/api/openaiShim/providerModes.js'
import { getAPIProvider, type APIProvider } from 'src/utils/model/providers.js'
import { getAnthropicAddendum } from './anthropic.js'
import { CODEX_ADDENDUM } from './codex.js'
import { DEFAULT_ADDENDUM } from './default.js'
import { GEMINI_ADDENDUM } from './gemini.js'
import { GLM_ADDENDUM } from './glm.js'
import { KIMI_ADDENDUM } from './kimi.js'
import { OPENAI_REASONING_ADDENDUM } from './openaiReasoning.js'

export type ModelFamily =
  | 'anthropic'
  | 'openai-reasoning'
  | 'gemini'
  | 'kimi'
  | 'glm'
  | 'codex'
  | 'default'

// Thunks, not strings: the anthropic entry has to be resolved per call so the
// CLAUDIN_ANTI_NARRATION killswitch is not frozen at module-eval time. The
// other six are constant, but they are wrapped too so the shape is uniform —
// a reader should not have to know which one is lazy. The Record still lists
// every ModelFamily, keeping the exhaustiveness guard.
const ADDENDUMS: Record<ModelFamily, () => string | null> = {
  anthropic: getAnthropicAddendum,
  'openai-reasoning': () => OPENAI_REASONING_ADDENDUM,
  gemini: () => GEMINI_ADDENDUM,
  kimi: () => KIMI_ADDENDUM,
  glm: () => GLM_ADDENDUM,
  codex: () => CODEX_ADDENDUM,
  default: () => DEFAULT_ADDENDUM,
}

const OPENAI_REASONING_MODEL_RE = /^(gpt-5|o1|o3|o4)/i
// Anchor at start-of-string or after a path separator so OpenRouter-style
// ids like "moonshotai/kimi-k2" still match, but stray substrings inside
// custom model names (e.g. "mygpt-glm-experiment") do NOT.
const KIMI_MODEL_RE = /(?:^|\/)(?:kimi|moonshot)/i
const GLM_MODEL_RE = /(?:^|\/)(?:glm|zhipu|bigmodel)/i

export function getModelFamily(
  provider: APIProvider,
  model: string,
  baseUrl: string | undefined,
): ModelFamily {
  const m = model.toLowerCase()

  switch (provider) {
    case 'firstParty':
    case 'bedrock':
    case 'vertex':
      // Bedrock namespaces the id ('anthropic.claude-opus-4-8-v1:0',
      // 'us.anthropic.claude-...', inference-profile ARNs); Vertex and 1P
      // ids start with 'claude-' directly. Anchor at start-of-string or
      // after a '.' so a custom id merely containing 'claude' elsewhere
      // does NOT match.
      return /(?:^|\.)claude-/.test(m) ? 'anthropic' : 'default'
    case 'codex':
      return 'codex'
    case 'gemini':
      return 'gemini'
    case 'openai': {
      if (isMoonshotCompatibleBaseUrl(baseUrl) || KIMI_MODEL_RE.test(m)) {
        return 'kimi'
      }
      if (isGlmCompatibleBaseUrl(baseUrl) || GLM_MODEL_RE.test(m)) {
        return 'glm'
      }
      if (OPENAI_REASONING_MODEL_RE.test(m)) return 'openai-reasoning'
      return 'default'
    }
    default:
      return 'default'
  }
}

export function getFamilyAddendum(model: string): string | null {
  const provider = getAPIProvider()
  const baseUrl = tryGetActiveProvider()?.baseUrl
  const family = getModelFamily(provider, model, baseUrl)
  return ADDENDUMS[family]()
}

export function getFamilyForLogging(model: string): ModelFamily {
  const provider = getAPIProvider()
  const baseUrl = tryGetActiveProvider()?.baseUrl
  return getModelFamily(provider, model, baseUrl)
}
