import { feature } from 'bun:bundle'
// Namespace import breaks the bridgeEnabled → auth → config → bridgeEnabled
// cycle — authModule.foo is a live binding, so by the time the helpers below
// call it, auth.js is fully loaded. Previously used require() for the same
// deferral, but require() hits a CJS cache that diverges from the ESM
// namespace after mock.module() (daemon/auth.test.ts), breaking spyOn.
import * as authModule from 'src/providers/auth/auth.js'

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
