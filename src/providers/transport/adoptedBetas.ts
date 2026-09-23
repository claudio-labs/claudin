/**
 * The Anthropic betas Claudin adopted from Claude Code on 2026-09-22, one at a
 * time. Each was captured on Claude Code's wire and accepted by the real API
 * before it shipped: docs/tech/anthropic-betas/wire-matrix.md, reproduced by
 * scripts/bench/tokens/beta-acceptance-probe.ts.
 *
 * None of them sits behind CLAUDIN_DISABLE_EXPERIMENTAL_BETAS. cli.tsx turns
 * that switch on by default, and it keeps guarding what nobody has measured —
 * strict tool schemas, task budgets, token-efficient-tools, and
 * `scope:"global"`, which the API rejects for Claudin's request shape. Each
 * adopted beta has its own killswitch instead, and all of them stop at the
 * real first-party endpoint.
 */

import {
  AFK_MODE_BETA_HEADER,
  CACHE_DIAGNOSIS_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  THINKING_DISPLAY_UPDATES_BETA_HEADER,
  THINKING_TOKEN_COUNT_BETA_HEADER,
} from 'src/shared/constants/betas.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/providers/model/providers.js'

export const ADOPTED_BETAS = {
  /** Interactive `thinking.display: "updates"`; off, the TUI gets "omitted". */
  thinkingDisplayUpdates: {
    header: THINKING_DISPLAY_UPDATES_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_THINKING_DISPLAY_UPDATES',
  },
  thinkingTokenCount: {
    header: THINKING_TOKEN_COUNT_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_THINKING_TOKEN_COUNT',
  },
  contextManagement: {
    header: CONTEXT_MANAGEMENT_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_CONTEXT_MANAGEMENT',
  },
  promptCachingScope: {
    header: PROMPT_CACHING_SCOPE_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_PROMPT_CACHING_SCOPE',
  },
  cacheDiagnosis: {
    header: CACHE_DIAGNOSIS_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_CACHE_DIAGNOSIS',
  },
  afkMode: {
    header: AFK_MODE_BETA_HEADER,
    killswitch: 'CLAUDIN_DISABLE_AFK_MODE_BETA',
  },
} as const

export type AdoptedBeta = keyof typeof ADOPTED_BETAS

const ANTHROPIC_API_HOST = 'api.anthropic.com'

export type EndpointFacts = {
  provider: string
  /** isFirstPartyAnthropicBaseUrl(): the active profile, not the env. */
  profileIsFirstParty: boolean
  envBaseUrl: string | undefined
  /** CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL. */
  assumeFirstParty: boolean
}

/**
 * Pure core of isRealFirstPartyEndpoint. A proxy or a gateway answers an
 * unknown beta with a 400, so a request only counts as first-party when:
 * - the provider is first-party
 * - the active profile points at api.anthropic.com, or nowhere
 * - ANTHROPIC_BASE_URL does not send the request elsewhere
 *
 * That is the line Claude Code draws with its own host allowlist.
 * `assumeFirstParty` waives only the env condition: the wire harnesses point a
 * real session at a localhost mock and need to see what the endpoint would
 * get.
 */
export function decideRealFirstPartyEndpoint(f: EndpointFacts): boolean {
  if (f.provider !== 'firstParty' || !f.profileIsFirstParty) return false
  if (!f.envBaseUrl || f.assumeFirstParty) return true
  try {
    return new URL(f.envBaseUrl).host === ANTHROPIC_API_HOST
  } catch {
    return false
  }
}

export function isRealFirstPartyEndpoint(): boolean {
  return decideRealFirstPartyEndpoint({
    provider: getAPIProvider(),
    profileIsFirstParty: isFirstPartyAnthropicBaseUrl(),
    envBaseUrl: process.env.ANTHROPIC_BASE_URL,
    assumeFirstParty: isEnvTruthy(
      process.env.CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL,
    ),
  })
}

// Betas the API turned down in this process. Once one 400s it stays off,
// because every later request would get the same answer.
const rejected = new Set<AdoptedBeta>()

export function isAdoptedBetaEnabled(beta: AdoptedBeta): boolean {
  return (
    !rejected.has(beta) &&
    !isEnvTruthy(process.env[ADOPTED_BETAS[beta].killswitch]) &&
    isRealFirstPartyEndpoint()
  )
}

export function isAdoptedBetaRejected(beta: AdoptedBeta): boolean {
  return rejected.has(beta)
}

export function markAdoptedBetaRejected(beta: AdoptedBeta): void {
  rejected.add(beta)
}

/**
 * A beta list without the rejected headers. The per-model lists are memoized,
 * so the list a request starts from can predate the rejection.
 */
export function withoutRejectedBetas(betas: readonly string[]): string[] {
  if (rejected.size === 0) return [...betas]
  const dropped = new Set<string>(
    [...rejected].map(b => ADOPTED_BETAS[b].header),
  )
  return betas.filter(b => !dropped.has(b))
}

/** @internal - test-only */
export function _resetAdoptedBetaRejectionsForTesting(): void {
  rejected.clear()
}

const UNEXPECTED_BETA_RE =
  /Unexpected value\(s\) (.+?) for the `anthropic-beta` header/
// A field error reads `<path>: <reason>`, so each pattern is anchored on the
// path and its colon — a bare word would also match an unrelated message.
const THINKING_DISPLAY_FIELD_RE = /\bthinking\.(?:adaptive|enabled)\.display:/
const DIAGNOSTICS_FIELD_RE = /\bdiagnostics(?:\.[a-z_]+)*:/
const CONTEXT_MANAGEMENT_FIELD_RE = /\bcontext_management(?:\.[a-z_0-9]+)*:/

/**
 * Which adopted beta a 400 is about, if any. Recovery is to drop it and send
 * the request again, which is what Claude Code does for each of these.
 *
 * Two shapes are recognized, the two beta-acceptance-probe.ts saw:
 * - the anthropic-beta error that names a header
 * - a field the beta opens (`display`, `diagnostics`, `context_management`)
 *   rejected on its own
 */
export function adoptedBetaFromRejection(
  status: number | undefined,
  message: string | undefined,
): AdoptedBeta | null {
  if (status !== 400 || !message) return null
  const unexpected = UNEXPECTED_BETA_RE.exec(message)?.[1]
  if (unexpected !== undefined) {
    for (const [name, { header }] of Object.entries(ADOPTED_BETAS)) {
      if (header && unexpected.includes(header)) return name as AdoptedBeta
    }
    return null
  }
  if (THINKING_DISPLAY_FIELD_RE.test(message)) return 'thinkingDisplayUpdates'
  if (DIAGNOSTICS_FIELD_RE.test(message)) return 'cacheDiagnosis'
  if (CONTEXT_MANAGEMENT_FIELD_RE.test(message)) return 'contextManagement'
  return null
}
