import { feature } from 'bun:bundle'
import {
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
// Namespace import breaks the bridgeEnabled → auth → config → bridgeEnabled
// cycle — authModule.foo is a live binding, so by the time the helpers below
// call it, auth.js is fully loaded. Previously used require() for the same
// deferral, but require() hits a CJS cache that diverges from the ESM
// namespace after mock.module() (daemon/auth.test.ts), breaking spyOn.
import * as authModule from '../utils/auth.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { lt } from '../utils/semver.js'

/**
 * Whether this build has a usable bridge credential.
 *
 * On the EXPERIMENT branch (`BRIDGE_MODE: true`) the bridge is gated purely on
 * having a token CCR will accept — no extra env opt-in. That is either a
 * claude.ai web-login OAuth token (`claudeAiOauth`) with the `user:profile`
 * scope, or the internal-only `CLAUDE_BRIDGE_OAUTH_TOKEN` dev override. These
 * are exactly the two sources `getBridgeAccessToken()` (bridgeConfig.ts) sends
 * to CCR, so the gate stays consistent with what the bridge authenticates with.
 *
 * We deliberately do NOT use upstream's `isClaudeAISubscriber()`: it also
 * requires the *inference* provider to be claude.ai-auth and returns false when
 * an env `ANTHROPIC_API_KEY` (or other external key) is present. The bridge
 * token is independent of which provider runs inference, so this decouples them.
 *
 * Safety: `BRIDGE_MODE` is false in the release build, so every caller below is
 * tree-shaken there — this path is only ever live on the experiment branch.
 */
function hasBridgeCredential(): boolean {
  return hasProfileScope() || !!process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
}

/**
 * Runtime check for bridge mode entitlement: BRIDGE_MODE built in AND a usable
 * bridge credential present (see hasBridgeCredential).
 */
export function isBridgeEnabled(): boolean {
  // Positive ternary pattern (not `if (!feature(...)) return`) so the bridge
  // entitlement path is only referenced when BRIDGE_MODE is built in.
  return feature('BRIDGE_MODE') ? hasBridgeCredential() : false
}

/**
 * Async-shaped alias of isBridgeEnabled() for the call sites that await an
 * entitlement check. Upstream awaited a GrowthBook server round-trip; the
 * claudin gate is purely local, so there is nothing to await.
 */
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  return isBridgeEnabled()
}

/**
 * Diagnostic message for why Remote Control is unavailable, or null if it's
 * enabled. Call this (instead of a bare `isBridgeEnabled()`) when you need to
 * show the user an actionable error.
 */
export async function getBridgeDisabledReason(): Promise<string | null> {
  if (feature('BRIDGE_MODE')) {
    if (!hasBridgeCredential()) {
      return 'Remote Control needs an Anthropic web login (a claude.ai OAuth token with the user:profile scope). Run `/provider` and sign in with your claude.ai account. Note: an inference API key alone is not enough — the bridge token is separate.'
    }
    return null
  }
  return 'Remote Control is not available in this build.'
}

// try/catch: main.tsx:5698 calls isBridgeEnabled() while defining the Commander
// program, before enableConfigs() runs. hasProfileScope() → getClaudeAIOAuthTokens()
// → getGlobalConfig() can throw "Config accessed before allowed" there. Pre-config,
// no OAuth token can exist anyway — false is correct.
function hasProfileScope(): boolean {
  try {
    return authModule.hasProfileScope()
  } catch {
    return false
  }
}

/**
 * Runtime check for the env-less (v2) REPL bridge path.
 * Returns true when the GrowthBook flag `tengu_bridge_repl_v2` is enabled.
 *
 * This gates which implementation initReplBridge uses — NOT whether bridge
 * is available at all (see isBridgeEnabled above). Daemon/print paths stay
 * on the env-based implementation regardless of this gate.
 */
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}

/**
 * Kill-switch for the `cse_*` → `session_*` client-side retag shim.
 *
 * The shim exists because compat/convert.go:27 validates TagSession and the
 * claude.ai frontend routes on `session_*`, while v2 worker endpoints hand out
 * `cse_*`. Once the server tags by environment_kind and the frontend accepts
 * `cse_*` directly, flip this to false to make toCompatSessionId a no-op.
 * Defaults to true — the shim stays active until explicitly disabled.
 */
export function isCseShimEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_bridge_repl_v2_cse_shim_enabled',
        true,
      )
    : true
}

/**
 * Returns an error message if the current CLI version is below the
 * minimum required for the v1 (env-based) Remote Control path, or null if the
 * version is fine. The v2 (env-less) path uses checkEnvLessBridgeMinVersion()
 * in envLessBridgeConfig.ts instead — the two implementations have independent
 * version floors.
 *
 * Uses cached (non-blocking) GrowthBook config. If GrowthBook hasn't
 * loaded yet, the default '0.0.0' means the check passes — a safe fallback.
 */
export function checkBridgeMinVersion(): string | null {
  // Positive pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  if (feature('BRIDGE_MODE')) {
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<{
      minVersion: string
    }>('tengu_bridge_min_version', { minVersion: '0.0.0' })
    if (config.minVersion && lt(MACRO.VERSION, config.minVersion)) {
      return `Your version of Claudin (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claudin update\` to update.`
    }
  }
  return null
}

/**
 * Default for remoteControlAtStartup when the user hasn't explicitly set it.
 * When the CCR_AUTO_CONNECT build flag is present (internal-only) and the
 * tengu_cobalt_harbor GrowthBook gate is on, all sessions connect to CCR by
 * default — the user can still opt out by setting remoteControlAtStartup=false
 * in config (explicit settings always win over this default).
 *
 * Defined here rather than in config.ts to avoid a direct
 * config.ts → growthbook.ts import cycle (growthbook.ts → user.ts → config.ts).
 */
export function getCcrAutoConnectDefault(): boolean {
  return feature('CCR_AUTO_CONNECT')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_harbor', false)
    : false
}

/**
 * Opt-in CCR mirror mode — every local session spawns an outbound-only
 * Remote Control session that receives forwarded events. Separate from
 * getCcrAutoConnectDefault (bidirectional Remote Control). Env var wins for
 * local opt-in; GrowthBook controls rollout.
 */
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) ||
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false)
    : false
}
