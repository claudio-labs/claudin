/**
 * Per-provider cache profile (clip-frontier design doc, Phase 5).
 *
 * The age-prune knobs (keepTurns, immediate display-stub threshold) encode a
 * trade between token cost and RSS that depends entirely on the provider's
 * cache pricing:
 *
 *  - Anthropic-style pricing (write 1.25×, read 0.10× of plain input — a
 *    12.5:1 spread): once the clip-frontier marker kills the per-turn break,
 *    the only reason left to clip early is RSS, not tokens. Keeping
 *    tool_results full means paying the 1.25× write once and 0.10× per turn
 *    thereafter — strictly cheaper than re-billing clipped content at 1.0×
 *    when the model re-reads it. Profile: never age-clip; bound RSS with a
 *    byte-pressure guard (stub oldest-first past a high-water mark).
 *
 *  - Low-spread providers (OpenAI/Gemini automatic caching, ~2-4:1, or no
 *    caching at all): retained context is nearly full-price every turn, so
 *    aggressive age-clipping wins. Profile: current behavior (keepTurns=1,
 *    immediate display stub at 2k tokens).
 *
 * Resolution (CLAUDIN_CACHE_PROFILE):
 *   - unset / invalid → 'auto' (Phase 6 default)
 *   - 'aggressive' | 'retain' → forced
 *   - 'auto' → by active provider transport (anthropic/bedrock/vertex and
 *     DeepSeek → retain; everything else → aggressive)
 */

import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'

export type CacheProfileName = 'aggressive' | 'retain'

export type CacheProfile = {
  name: CacheProfileName
  /** Cache-write / cache-read cost as multiples of plain input. Rationale
   * fields: they justify the knobs below and feed future dynamic tuning;
   * no arithmetic uses them today. */
  writeMult: number
  readMult: number
  /** Age prune window (pruneOldToolResults). Infinity disables age clipping. */
  keepTurns: number
  /** Floor below which clipping is a net loss (the stub itself is ~10 tok). */
  minStubTokens: number
  /** Immediate display-stub threshold (stubToolResultForDisplay). Infinity
   * keeps full content in the display/seed array so the NEXT turn's API view
   * still has it — the display array seeds messagesIncludingNewMessages. */
  immediateStubTokens: number
  /** RSS guard (pruneToolResultsByBytes): when the estimated total tokens of
   * CLEARABLE full tool_results (older than the protected recent window)
   * exceed the high water, stub oldest-first down to the low water. Pressure
   * concentrated in the recent window is NOT counted — it cannot be cleared
   * here, so this bounds old-history growth, not instantaneous RSS. Infinity
   * disables the guard (age prune already bounds RSS in aggressive). */
  retainedHighWaterTokens: number
  retainedLowWaterTokens: number
  /** When stubbing, keep the first N chars of the original output above the
   * clip marker (single mutation, same break cost, model retains file
   * headers / top grep hits — fewer re-reads). 0 = pure 10-token stub.
   * Override per-run with CLAUDIN_STUB_HEAD_CHARS. */
  stubKeepHeadChars: number
  /** Time-based microcompact (timeBasedMCConfig.ts): clear old tool results
   * when the idle gap exceeds the cache TTL — the prefix will be rewritten
   * anyway, so the mutation is free. Claudin's GrowthBook is stubbed, so
   * these fields ARE the effective config. */
  timeBasedClipEnabled: boolean
  timeBasedGapMinutes: number
  timeBasedKeepRecent: number
  /** Fraction of the effective context window at which microCompact's
   * size-driven stable-stub trigger starts clipping old tool_results
   * (SIZE_BASED_THRESHOLD). Aggressive clips early (0.5) to save tokens on
   * low-spread providers; retain clips at 0.75 — late enough to use the
   * cheap cached window, early enough that the cheap clip (~30k re-write)
   * pre-empts autoCompact's expensive wipe-plus-re-reads (bench: the 0.85
   * setting fired too late and autocompact hit first). */
  sizeStubThresholdFraction: number
  /** Whether the thinking/narration history redactions
   * (stripOldThinkingBlocks / stripOldNarrationBlocks) run at the API
   * boundary. Under retain they are strictly losing trades: their keep
   * windows hold the last 2 assistant turns permanently mutable, which
   * pins the clip frontier ~2 turns behind the tail and re-bills every
   * big tool_result at 1.0× for 2 turns before it can freeze — to save
   * ~50-200 tokens of narration text. (Bench: claude's `in` column is ~1
   * token/request because it freezes immediately; ours was 19-45k.) */
  historyRedactionEnabled: boolean
  /** Server-side context_management clear_tool_uses (Anthropic first-party
   * beta). Under retain it replaces the client microcompact as the
   * near-ceiling context relief: triggers on real server token counts
   * instead of drift-prone client estimates. The clear itself is one
   * bounded cache break — same class as a client clip event. */
  serverToolClearEnabled: boolean
}

export const AGGRESSIVE_PROFILE: CacheProfile = {
  name: 'aggressive',
  writeMult: 1.25,
  readMult: 1.0, // assume no usable cache discount → clip early
  keepTurns: 1,
  minStubTokens: 100,
  immediateStubTokens: 2000,
  retainedHighWaterTokens: Infinity,
  retainedLowWaterTokens: Infinity,
  sizeStubThresholdFraction: 0.5,
  historyRedactionEnabled: true,
  serverToolClearEnabled: false,
  // ~250 tok per aged result. The bench's quality failure mode under this
  // profile (model summarizing files it could no longer see) came from pure
  // stubs; heads fix most of it at modest context cost.
  stubKeepHeadChars: 1000,
  // Age prune already stubs everything old; idle-gap clearing adds nothing.
  timeBasedClipEnabled: false,
  timeBasedGapMinutes: 60,
  timeBasedKeepRecent: 5,
}

export const RETAIN_PROFILE: CacheProfile = {
  name: 'retain',
  writeMult: 1.25,
  readMult: 0.1,
  keepTurns: Infinity,
  minStubTokens: 100,
  immediateStubTokens: Infinity,
  // ~250k estimated tokens of retained full tool_results ≈ ~1 MB of string
  // payload (plus JS overhead). Beyond any 200k context window — autocompact
  // bounds the live conversation first — so this fires only for 1M-window
  // models or pathological accumulation. Each firing is one deliberate clip
  // event: breaks the cache once, then stabilizes (stable-stub contract).
  retainedHighWaterTokens: 250_000,
  retainedLowWaterTokens: 125_000,
  sizeStubThresholdFraction: 0.75,
  historyRedactionEnabled: false,
  serverToolClearEnabled: true,
  stubKeepHeadChars: 2000,
  // After a 60-min gap even the 1h TTL is expired — the rewrite is happening
  // regardless, so clearing old results at that moment costs zero cache.
  timeBasedClipEnabled: true,
  timeBasedGapMinutes: 60,
  timeBasedKeepRecent: 5,
}

/** Pure resolver — exported for tests. Retain goes to every provider whose
 * cache pricing makes retention strictly cheaper than re-billing clipped
 * content:
 *  - Anthropic-style explicit caching (anthropic/bedrock/vertex): 12.5:1
 *    read spread.
 *  - DeepSeek: disk context caching, hits ~1/10 of input price.
 *  - Official OpenAI (api.openai.com) + Codex/ChatGPT OAuth (Responses
 *    API): automatic prefix caching with NO write surcharge and up to 90%
 *    cached-input discount on current models (24h retention requestable);
 *    Codex is additionally subscription-billed, so clipping saves nothing.
 *  - GitHub Copilot: token-based AI-Credits billing (2026-06) prices
 *    cached tokens at ~10% of input.
 * Generic OpenAI-compatible routers/local backends keep aggressive — their
 * caching behavior (if any) is unknown. */
export function resolveProfileForProvider(
  transport: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined,
): CacheProfile {
  if (
    transport === 'anthropic' ||
    transport === 'bedrock' ||
    transport === 'vertex' ||
    transport === 'codex_responses' ||
    transport === 'github_copilot'
  ) {
    return RETAIN_PROFILE
  }
  const haystack = `${baseUrl ?? ''} ${model ?? ''}`.toLowerCase()
  if (transport === 'openai_compat' && haystack.includes('deepseek')) {
    return RETAIN_PROFILE
  }
  if (transport === 'openai_compat' && baseUrl) {
    try {
      const host = new URL(baseUrl).host
      if (host === 'api.openai.com' || host.endsWith('.api.openai.com')) {
        return RETAIN_PROFILE
      }
    } catch {
      // unparsable base URL → conservative default below
    }
  }
  return AGGRESSIVE_PROFILE
}

type ProfileMode = 'aggressive' | 'retain' | 'auto'

function readProfileMode(): ProfileMode {
  const raw = process.env.CLAUDIN_CACHE_PROFILE?.toLowerCase()
  if (raw === 'retain' || raw === 'auto' || raw === 'aggressive') return raw
  // Phase 6 default: resolve by the active provider's cache pricing.
  // Anthropic-style spreads get 'retain', everything else 'aggressive'.
  return 'auto'
}

// Must stay comfortably under stableStubState's HEAD_STUB_MAX_PLAUSIBLE_CHARS
// (32k): a head-stub longer than that bound is no longer recognized as final
// and would be re-stubbed every pass — per-turn byte churn.
const MAX_STUB_HEAD_CHARS = 24_000

function readHeadCharsOverride(): number | undefined {
  const raw = process.env.CLAUDIN_STUB_HEAD_CHARS
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.min(parsed, MAX_STUB_HEAD_CHARS)
}

// Memoized at module load; tests that flip the env must call
// _resetCacheProfileForTesting (matches the CLAUDIN_CLIP_FRONTIER pattern).
let profileMode = readProfileMode()
let headCharsOverride = readHeadCharsOverride()

export function _resetCacheProfileForTesting(): void {
  profileMode = readProfileMode()
  headCharsOverride = readHeadCharsOverride()
}

export function getCacheProfile(): CacheProfile {
  let profile: CacheProfile
  if (profileMode === 'aggressive') {
    profile = AGGRESSIVE_PROFILE
  } else if (profileMode === 'retain') {
    profile = RETAIN_PROFILE
  } else {
    const provider = tryGetActiveProvider()
    profile = resolveProfileForProvider(
      provider?.transport,
      provider?.baseUrl,
      provider?.model,
    )
  }
  if (
    headCharsOverride !== undefined &&
    headCharsOverride !== profile.stubKeepHeadChars
  ) {
    return { ...profile, stubKeepHeadChars: headCharsOverride }
  }
  return profile
}
