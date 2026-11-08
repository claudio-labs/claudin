// The model the main loop falls back to when its own is overloaded, down or
// rate-limited for long. The triggers are in withRetry.ts and how long the
// switch lasts in fallbackHold.ts. Set by `--fallback-model` (interactive
// and `-p` alike) or the `fallbackModel` setting; the flag wins. `default`
// names the default main model, and a fallback equal to the model in use is
// no fallback. One outside the `availableModels` allowlist is ignored, the way
// a `model` setting outside it is (model.ts). Sub-agents get none.
import { getFallbackModelOverride } from 'src/platform/bootstrap/state.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import { isModelAllowed } from 'src/providers/model/modelAllowlist.js'

export type FallbackModelDeps = {
  flag: () => string | undefined
  setting: () => string | undefined
  defaultModel: () => string
  parse: (model: string) => string
  isAllowed: (model: string) => boolean
}

const defaultDeps: FallbackModelDeps = {
  flag: getFallbackModelOverride,
  setting: () => getInitialSettings()?.fallbackModel,
  defaultModel: getDefaultMainLoopModel,
  parse: parseUserSpecifiedModel,
  isAllowed: isModelAllowed,
}

/** The configured fallback, resolved to a model id, or `undefined` when none is set or it is not allowed. */
export function getConfiguredFallbackModel(
  deps: FallbackModelDeps = defaultDeps,
): string | undefined {
  const raw = (deps.flag() ?? deps.setting())?.trim()
  if (!raw) return undefined
  if (raw === 'default') return deps.defaultModel()
  return deps.isAllowed(raw) ? deps.parse(raw) : undefined
}

/** The fallback for a loop running on `primary`: none when it is `primary` itself. */
export function getFallbackModel(
  primary: string,
  deps: FallbackModelDeps = defaultDeps,
): string | undefined {
  const fallback = getConfiguredFallbackModel(deps)
  return fallback && fallback !== primary ? fallback : undefined
}
