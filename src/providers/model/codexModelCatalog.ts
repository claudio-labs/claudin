/**
 * codexModelCatalog.ts
 * Single source of truth for the Codex (ChatGPT/Codex OAuth) model picker.
 *
 * Ported from opencode's dynamic-filter approach
 * (packages/opencode/src/plugin/openai/codex.ts:285-291): instead of a
 * hand-enumerated picker list, we keep a curated candidate catalog and apply a
 * predicate so that future `gpt-X.Y > 5.4` models show up without editing an
 * enumeration, and `pro` variants are hidden by rule rather than by list.
 *
 * Two intentional divergences from opencode:
 *  - `gpt-5.6` is ENABLED (opencode currently excludes it).
 *  - The allowlist is extended to every catalog id, so the older codex-branded
 *    models (5.1/5.2/5.3) the numeric `>5.4` rule would drop stay in the picker.
 *
 * The filter governs only the DISPLAYED list. Alias/transport resolution still
 * lives in CODEX_ALIAS_MODELS (src/providers/presets/providerConfig.ts) — a model
 * hidden from the picker still resolves if typed, exactly like opencode.
 *
 * A ChatGPT account on the Codex backend offers far less than the API: three
 * models, which its own catalog lists (`GET /backend-api/codex/models
 * ?client_version=…`, 2026-10-16), each with a 272k window (the Codex CLI
 * compacts at 95% of it) and 128k of output. Every other id here answers 400
 * "not supported when using Codex with a ChatGPT account" there and stays for
 * API-key use. Those three carry an `account` record, read only when the
 * session is on the Codex backend: the picker, the context window and the
 * effort levels. The 128k of output is the API's too, so `contextOutput` covers it.
 */
import type { ReasoningEffort } from 'src/providers/presets/providerConfig.js'

/** What the model gets on the Codex backend under a ChatGPT account. */
export type CodexAccountLimits = {
  contextWindow: number
  /**
   * The effort levels the account's catalog lists for it. `ultra` (gpt-5.6-terra)
   * is left out: Codex CLI 0.162.1 does not send it either — set to ultra, it
   * sends `reasoning: {effort: "high", context: "all_turns"}` (captured 2026-10-16).
   */
  effortLevels: readonly ReasoningEffort[]
}

export type CodexModelEntry = {
  id: string
  label: string
  description: string
  /** Default reasoning effort; mirrors CODEX_ALIAS_MODELS in providerConfig. */
  reasoningEffort?: ReasoningEffort
  /** Input/context window in tokens (feeds OPENAI_CONTEXT_WINDOWS). */
  contextInput?: number
  /** Max output tokens (feeds OPENAI_MAX_OUTPUT_TOKENS). */
  contextOutput?: number
  /** `pro`-tier variant — always excluded from the picker (opencode parity). */
  isPro?: boolean
  /** Offered to a ChatGPT account on the Codex backend, with these limits. */
  account?: CodexAccountLimits
  /** Offered only there: kept out of the API picker. */
  accountOnly?: boolean
}

const CHATGPT_ACCOUNT: CodexAccountLimits = {
  contextWindow: 272_000,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
}

/** What `codexplan` names, and the Codex default when a profile names nothing: the Codex CLI's own default. */
export const CODEX_DEFAULT_MODEL = 'gpt-6-luna'

// Curated candidate catalog. Order = picker order.
export const CODEX_MODEL_CATALOG: readonly CodexModelEntry[] = [
  {
    id: CODEX_DEFAULT_MODEL,
    label: CODEX_DEFAULT_MODEL,
    description: 'GPT-6 Luna - the Codex CLI default',
    reasoningEffort: 'medium',
    // Off the Codex backend (a relay in front of it, an API key) the same
    // limits stand in, rather than the 128k fallback for unknown models.
    contextInput: 272_000,
    contextOutput: 128_000,
    account: CHATGPT_ACCOUNT,
    accountOnly: true,
  },
  // GPT-5.6 ships as three tiers (sol/terra/luna); the bare `gpt-5.6` alias
  // resolves to the flagship Sol in CODEX_ALIAS_MODELS. Context windows match
  // the official OpenAI model descriptors (developers.openai.com/api/docs/models):
  // 1.05M input / 128k output.
  {
    id: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    description: 'GPT-5.6 Sol - flagship, high reasoning',
    reasoningEffort: 'high',
    contextInput: 1_050_000,
    contextOutput: 128_000,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    description: 'GPT-5.6 Terra with high reasoning',
    reasoningEffort: 'high',
    contextInput: 1_050_000,
    contextOutput: 128_000,
    account: CHATGPT_ACCOUNT,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    description: 'GPT-5.6 Luna with high reasoning',
    reasoningEffort: 'high',
    contextInput: 1_050_000,
    contextOutput: 128_000,
    account: CHATGPT_ACCOUNT,
  },
  {
    id: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'GPT-5.5 with high reasoning',
    reasoningEffort: 'high',
    contextInput: 1_050_000,
    contextOutput: 128_000,
  },
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'GPT-5.4 with high reasoning',
    reasoningEffort: 'high',
    contextInput: 1_050_000,
    contextOutput: 128_000,
  },
  {
    id: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'GPT-5.3 Codex with high reasoning',
    reasoningEffort: 'high',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'GPT-5.3 Codex Spark for fast tool loops',
  },
  {
    id: 'codexspark',
    label: 'codexspark',
    description: 'GPT-5.3 Codex Spark alias for fast tool loops',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    description: 'GPT-5.2 Codex with high reasoning',
    reasoningEffort: 'high',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'gpt-5.1-codex-max',
    description: 'GPT-5.1 Codex Max for deep reasoning',
    reasoningEffort: 'high',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'gpt-5.1-codex-mini',
    description: 'GPT-5.1 Codex Mini - faster, cheaper',
  },
  {
    id: 'gpt-5.5-mini',
    label: 'gpt-5.5-mini',
    description: 'GPT-5.5 Mini - faster, cheaper',
    reasoningEffort: 'medium',
    contextInput: 400_000,
    contextOutput: 128_000,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    description: 'GPT-5.4 Mini - faster, cheaper',
    reasoningEffort: 'medium',
    contextInput: 400_000,
    contextOutput: 128_000,
  },
] as const

// Mirrors opencode's ALLOWED_MODELS, extended to every catalog id so the older
// codex-branded models survive the numeric rule below.
export const CODEX_ALLOWLIST: ReadonlySet<string> = new Set(
  CODEX_MODEL_CATALOG.filter(entry => !entry.isPro).map(entry => entry.id),
)

// Mirrors opencode's DISALLOWED_MODELS.
export const CODEX_DISALLOWLIST: ReadonlySet<string> = new Set(['gpt-5.5-pro'])

// opencode: `model.api.id.match(/^gpt-(\d+\.\d+)/)` then `parseFloat > 5.4`.
const CODEX_VERSION_RE = /^gpt-(\d+\.\d+)/
const CODEX_PRO_RE = /-pro$/
export const CODEX_MIN_DYNAMIC_VERSION = 5.4

/**
 * The opencode predicate (codex.ts:285-291), minus the `gpt-5.6` exclusion.
 * `isPro` mirrors opencode's `reasoningMode === "pro"` check; when filtering
 * bare ids it is inferred from a `-pro` suffix or the disallowlist.
 */
export function isCodexModelAllowed(
  id: string,
  opts: { isPro?: boolean } = {},
): boolean {
  const isPro = opts.isPro ?? (CODEX_PRO_RE.test(id) || CODEX_DISALLOWLIST.has(id))
  if (isPro) return false
  if (CODEX_ALLOWLIST.has(id)) return true
  if (CODEX_DISALLOWLIST.has(id)) return false
  const match = id.match(CODEX_VERSION_RE)
  return match ? Number.parseFloat(match[1]) > CODEX_MIN_DYNAMIC_VERSION : false
}

/** Filter a list of bare model ids through the Codex predicate. */
export function filterCodexModels(ids: readonly string[]): string[] {
  return ids.filter(id => isCodexModelAllowed(id))
}

/** Catalog entries that pass the filter, in picker order: the API's list. */
export function getFilteredCodexCatalog(): CodexModelEntry[] {
  return CODEX_MODEL_CATALOG.filter(entry =>
    !entry.accountOnly && isCodexModelAllowed(entry.id, { isPro: entry.isPro }),
  )
}

/** What a ChatGPT account offers on the Codex backend, in picker order. */
export function getCodexAccountCatalog(): CodexModelEntry[] {
  return CODEX_MODEL_CATALOG.filter(entry => entry.account !== undefined)
}

/** The limits a ChatGPT account gives this model on the Codex backend, if it offers it. */
export function getCodexAccountLimits(model: string): CodexAccountLimits | undefined {
  return CODEX_MODEL_CATALOG.find(entry => entry.id === model)?.account
}


// Context-window records derived from the catalog, spread into the OpenAI maps
// in openaiContextWindows.ts so the two never drift.
export const CODEX_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  CODEX_MODEL_CATALOG.filter(entry => entry.contextInput !== undefined).map(
    entry => [entry.id, entry.contextInput as number],
  ),
)

export const CODEX_MAX_OUTPUT_TOKENS: Record<string, number> = Object.fromEntries(
  CODEX_MODEL_CATALOG.filter(entry => entry.contextOutput !== undefined).map(
    entry => [entry.id, entry.contextOutput as number],
  ),
)
