/**
 * Feature-flag resolution.
 *
 * Upstream this module was a GrowthBook client: ~1000 lines that fetched flag
 * definitions from Anthropic, ran experiment assignment, reported exposures and
 * refreshed on a timer. None of it ran here — `scripts/build/no-telemetry-plugin.ts`
 * replaced the whole module with a local stub at build time. So the source in
 * this file and the code that actually shipped were two different programs, and
 * only the one nobody could read was under test.
 *
 * This file is now that stub, promoted to source. Same resolution, same
 * behaviour, but it is the thing that runs and the thing tests import.
 *
 * ## Resolution order
 *
 *   1. A security restriction (see `SECURITY_RESTRICTIONS`) — not settable.
 *   2. `~/.claudin/feature-flags.json`, if the user wrote one.
 *   3. `OPEN_BUILD_DEFAULTS` — the keys this fork deliberately flips.
 *   4. The `defaultValue` the call site passes.
 *
 * Nothing here reaches a network. A flag is whatever the local files say.
 *
 * ## Overriding a flag
 *
 * Write `~/.claudin/feature-flags.json` (or point `CLAUDE_FEATURE_FLAGS_FILE`
 * at another path):
 *
 *     { "tengu_some_flag": true }
 *
 * The file is read once per process and cached; `resetGrowthBook()` drops the
 * cache. `docs/tech/tengu-census/gate-audit.md` lists every key, what it gates,
 * and whether flipping it does anything in this fork.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Anything a flag file can legally hold. */
export type FlagValue = unknown

/**
 * Keys this fork deliberately resolves differently from upstream's default.
 *
 * Only keys that DIFFER belong here. Everything else takes the `defaultValue`
 * its call site passes, which keeps the override list short enough to read.
 */
const OPEN_BUILD_DEFAULTS: Record<string, FlagValue> = {
  // AWAY_SUMMARY — the "while you were away" recap (upstream: false).
  tengu_sedge_lantern: true,
  // EXTRACT_MEMORIES — memory extraction (upstream: false).
  tengu_passport_quail: true,
  // EXTRACT_MEMORIES — memory search over past context (upstream: false).
  tengu_coral_fern: true,
  // EXTRACT_MEMORIES throttle — fire every 15 eligible turns (upstream: null,
  // i.e. every turn). Per-fire cost is ~2-4k effective tokens, mostly cache_read
  // at 10%, so this amortizes to ~130-270 tokens/turn.
  tengu_bramble_lintel: 15,
  // Deferred-tools delta announcements (upstream: false). With it off,
  // claude/streaming.ts prepends an ephemeral <available-deferred-tools> block
  // at messages[0] on every request, so any pool change — an MCP connect, a
  // discovery — rewrites messages[0] and invalidates the whole cached prefix.
  // On, pool changes become appended, cache-safe attachments instead.
  tengu_glacier_2xr: true,
}

/**
 * Keys a user must NOT be able to set, with the value every reader gets.
 *
 * `tengu_disable_bypass_permissions_mode` is a remote killswitch upstream: set
 * it and `--dangerously-skip-permissions` stops working. There is no remote
 * here, so leaving it settable would only let someone lock themselves out of a
 * mode they explicitly asked for, with nothing explaining the refusal.
 *
 * The refusal lives in `getFlagValue`, not at one accessor, because the same key
 * is read through several: blanking `checkSecurityRestrictionGate` alone left
 * `checkStatsigFeatureGate_CACHED_MAY_BE_STALE` honouring the file.
 */
const SECURITY_RESTRICTIONS: Record<string, FlagValue> = {
  tengu_disable_bypass_permissions_mode: false,
}

/** `undefined` = not read yet, `null` = read and absent or unusable. */
let flags: Record<string, FlagValue> | null | undefined

function loadFlags(): void {
  if (flags !== undefined) return
  try {
    const flagsPath =
      process.env.CLAUDE_FEATURE_FLAGS_FILE ??
      join(homedir(), '.claudin', 'feature-flags.json')
    const parsed: unknown = JSON.parse(readFileSync(flagsPath, 'utf-8'))
    flags =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, FlagValue>)
        : null
  } catch {
    // No file, unreadable, or not JSON — all mean "no overrides", which is the
    // common case. Failing open here is deliberate: a malformed flag file must
    // not stop the CLI from starting.
    flags = null
  }
}

function getFlagValue<T>(key: string, defaultValue: T): T {
  loadFlags()
  if (Object.hasOwn(SECURITY_RESTRICTIONS, key)) {
    return SECURITY_RESTRICTIONS[key] as T
  }
  if (flags !== null && flags !== undefined && Object.hasOwn(flags, key)) {
    return flags[key] as T
  }
  if (Object.hasOwn(OPEN_BUILD_DEFAULTS, key)) {
    return OPEN_BUILD_DEFAULTS[key] as T
  }
  return defaultValue
}

// ── Reads ───────────────────────────────────────────────────────────────

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  return getFlagValue(feature, defaultValue)
}

export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  /**
   * Upstream re-fetched from the network when the cached value was older than
   * this. There is no network here and the file is read once per process, so
   * the interval is accepted and ignored — dropping the parameter would only
   * force five call sites to explain its absence.
   */
  _maxAgeMs?: number,
): T {
  return getFlagValue(feature, defaultValue)
}

export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return getFlagValue(feature, defaultValue)
}

export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  return Boolean(getFlagValue(gate, false))
}

export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  return Boolean(getFlagValue(gate, false))
}

/** Always false — see `SECURITY_RESTRICTIONS`. */
export async function checkSecurityRestrictionGate(
  _gate: string,
): Promise<boolean> {
  return false
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return getFlagValue(configName, defaultValue)
}

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFlagValue(configName, defaultValue)
}

/** Every override currently in effect, for `/doctor` and debugging. */
export function getAllGrowthBookFeatures(): Record<string, FlagValue> {
  loadFlags()
  return flags ?? {}
}

// ── Lifecycle ───────────────────────────────────────────────────────────
//
// Kept because callers still call them. With no remote there is nothing to
// initialize, refresh or subscribe to — resolution is a file read — so these
// are the honest no-ops rather than placeholders for something missing.

export const initializeGrowthBook = async (): Promise<null> => null

export function refreshGrowthBookAfterAuthChange(): void {}

/** Drops the cached file so the next read picks up an edit. */
export function resetGrowthBook(): void {
  flags = undefined
}

const NOOP_UNSUBSCRIBE = (): void => {}

/**
 * Subscribe to flag refreshes. Never fires: flags change only when the user
 * edits the file, and nothing watches it. Returns the unsubscribe so callers
 * can keep their cleanup path.
 */
export function onGrowthBookRefresh(
  _listener: () => void | Promise<void>,
): () => void {
  return NOOP_UNSUBSCRIBE
}
