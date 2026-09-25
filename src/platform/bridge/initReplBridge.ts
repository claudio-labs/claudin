/**
 * REPL-specific wrapper around initBridgeCore. Owns the parts that read
 * bootstrap state — gates, cwd, session ID, git context, OAuth, title
 * derivation — then delegates to the bootstrap-free core.
 *
 * Split out of replBridge.ts because the sessionStorage import
 * (getCurrentSessionTitle) transitively pulls in src/commands/commands.ts → the
 * entire slash command + React component tree (~1300 modules). Keeping
 * initBridgeCore in a file that doesn't touch sessionStorage lets
 * daemonBridge.ts import the core without bloating the Agent SDK bundle.
 *
 * Called via dynamic import by useReplBridge (auto-start) and print.ts
 * (SDK -p mode via query.enableRemoteControl).
 */

import { feature } from 'bun:bundle'
import { hostname } from 'os'
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js'
import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type { SDKControlResponse } from 'src/platform/entrypoints/sdk/controlTypes.js'
import { getOrganizationUUID } from 'src/providers/oauth/client.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from 'src/platform/policyLimits/index.js'
import type { Message } from 'src/shared/types/message.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from 'src/providers/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { stripDisplayTagsAllowEmpty } from 'src/shared/text/displayTags.js'
import { errorMessage } from 'src/shared/errors.js'
import { getBranch, getRemoteUrl } from 'src/vcs/git/git.js'
import { toSDKMessages } from 'src/agent/messages/mappers.js'
import {
  getContentText,
  getMessagesAfterCompactBoundary,
  isSyntheticMessage,
} from 'src/agent/messages/messages.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import { getCurrentSessionTitle } from 'src/sessions/sessionStorage.js'
import {
  extractConversationText,
  generateSessionTitle,
} from 'src/sessions/sessionTitle.js'
import { generateShortWordSlug } from 'src/shared/text/words.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  getBridgeTokenOverride,
} from 'src/platform/bridge/bridgeConfig.js'
import { isBridgeEnabledBlocking } from 'src/platform/bridge/bridgeEnabled.js'
import {
  archiveBridgeSession,
  createBridgeSession,
  updateBridgeSessionTitle,
} from 'src/platform/bridge/createSession.js'
import { getPollIntervalConfig } from 'src/platform/bridge/pollConfig.js'
import type { BridgeState, ReplBridgeHandle } from 'src/platform/bridge/replBridge.js'
import { initBridgeCore } from 'src/platform/bridge/replBridge.js'
import type { BridgeWorkerType } from 'src/platform/bridge/types.js'

/** Max initial messages replayed into the bridge session on connect. */
const INITIAL_HISTORY_CAP = 200

export type InitBridgeOptions = {
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  initialMessages?: Message[]
  // Explicit session name from `/remote-control <name>`. When set, overrides
  // the title derived from the conversation or /rename.
  initialName?: string
  // Fresh view of the full conversation at call time. Used by onUserMessage's
  // count-3 derivation to call generateSessionTitle over the full conversation.
  // Optional — print.ts's SDK enableRemoteControl path has no REPL message
  // array; count-3 falls back to the single message text when absent.
  getMessages?: () => Message[]
  // UUIDs already flushed in a prior bridge session. Messages with these
  // UUIDs are excluded from the initial flush to avoid poisoning the
  // server (duplicate UUIDs across sessions cause the WS to be killed).
  // Mutated in place — newly flushed UUIDs are added after each flush.
  previouslyFlushedUUIDs?: Set<string>
  /** See BridgeCoreParams.perpetual. */
  perpetual?: boolean
}

export async function initReplBridge(
  options?: InitBridgeOptions,
): Promise<ReplBridgeHandle | null> {
  const {
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    initialMessages,
    getMessages,
    previouslyFlushedUUIDs,
    initialName,
    perpetual,
  } = options ?? {}

  // 1. Runtime gate
  if (!(await isBridgeEnabledBlocking())) {
    logForDebugging('[bridge:repl] Skipping: bridge not enabled')
    return null
  }

  // 2. Check OAuth — must be signed in with claude.ai. Runs before the
  // policy check so console-auth users get the actionable "/login" hint
  // instead of a misleading policy error from a stale/wrong-org cache.
  if (!getBridgeAccessToken()) {
    logForDebugging('[bridge:repl] Skipping: no OAuth tokens')
    onStateChange?.('failed', '/login')
    return null
  }

  // 3. Check organization policy — remote control may be disabled
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    logForDebugging(
      '[bridge:repl] Skipping: allow_remote_control policy not allowed',
    )
    onStateChange?.('failed', "disabled by your organization's policy")
    return null
  }

  // When CLAUDE_BRIDGE_OAUTH_TOKEN is set (internal-only local dev), the bridge
  // uses that token directly via getBridgeAccessToken() — keychain state is
  // irrelevant. Skip 2b/2c to preserve that decoupling: an expired keychain
  // token shouldn't block a bridge connection that doesn't use it.
  if (!getBridgeTokenOverride()) {
    // 2a. Cross-process backoff. If N prior processes already saw this exact
    // dead token (matched by expiresAt), skip silently — no event, no refresh
    // attempt. The count threshold tolerates transient refresh failures (auth
    // server 5xx, lockfile errors per auth.ts:1437/1444/1485): each process
    // independently retries until 3 consecutive failures prove the token dead.
    // Mirrors useReplBridge's MAX_CONSECUTIVE_INIT_FAILURES for in-process.
    // The expiresAt key is content-addressed: /login → new token → new expiresAt
    // → this stops matching without any explicit clear.
    const cfg = getGlobalConfig()
    if (
      cfg.bridgeOauthDeadExpiresAt != null &&
      (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
      getClaudeAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt
    ) {
      logForDebugging(
        `[bridge:repl] Skipping: cross-process backoff (dead token seen ${cfg.bridgeOauthDeadFailCount} times)`,
      )
      // The only other early return that stayed silent: with no state change
      // the REPL sits on "connecting…" and then quietly gives up, which is
      // indistinguishable from the bridge never having been asked.
      onStateChange?.('failed', 'sign-in expired — run /login')
      return null
    }

    // 2b. Proactively refresh if expired. Mirrors bridgeMain.ts:2096 — the REPL
    // bridge fires at useEffect mount BEFORE any v1/messages call, making this
    // usually the first OAuth request of the session. Without this, ~9% of
    // registrations hit the server with a >8h-expired token → 401 → withOAuthRetry
    // recovers, but the server logs a 401 we can avoid. VPN egress IPs observed
    // at 30:1 401:200 when many unrelated users cluster at the 8h TTL boundary.
    //
    // Fresh-token cost: one memoized read + one Date.now() comparison (~µs).
    // checkAndRefreshOAuthTokenIfNeeded clears its own cache in every path that
    // touches the keychain (refresh success, lockfile race, throw), so no
    // explicit clearOAuthTokenCache() here — that would force a blocking
    // keychain spawn on the 91%+ fresh-token path.
    await checkAndRefreshOAuthTokenIfNeeded()

    // 2c. Skip if token is still expired post-refresh-attempt. Env-var / FD
    // tokens (auth.ts:894-917) have expiresAt=null → never trip this. But a
    // keychain token whose refresh token is dead (password change, org left,
    // token GC'd) has expiresAt<now AND refresh just failed — the client would
    // otherwise loop 401 forever: withOAuthRetry → handleOAuth401Error →
    // refresh fails again → retry with same stale token → 401 again.
    // Datadog 2026-03-08: single IPs generating 2,879 such 401s/day. Skip the
    // guaranteed-fail API call; useReplBridge surfaces the failure.
    //
    // Intentionally NOT using isOAuthTokenExpired here — that has a 5-minute
    // proactive-refresh buffer, which is the right heuristic for "should
    // refresh soon" but wrong for "provably unusable". A token with 3min left
    // + transient refresh endpoint blip (5xx/timeout/wifi-reconnect) would
    // falsely trip a buffered check; the still-valid token would connect fine.
    // Check actual expiry instead: past-expiry AND refresh-failed → truly dead.
    const tokens = getClaudeAIOAuthTokens()
    if (tokens && tokens.expiresAt !== null && tokens.expiresAt <= Date.now()) {
      logForDebugging(
        '[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)',
      )
      onStateChange?.('failed', '/login')
      // Persist for the next process. Increments failCount when re-discovering
      // the same dead token (matched by expiresAt); resets to 1 for a different
      // token. Once count reaches 3, step 2a's early-return fires and this path
      // is never reached again — writes are capped at 3 per dead token.
      // Local const captures the narrowed type (closure loses !==null narrowing).
      const deadExpiresAt = tokens.expiresAt
      saveGlobalConfig(c => ({
        ...c,
        bridgeOauthDeadExpiresAt: deadExpiresAt,
        bridgeOauthDeadFailCount:
          c.bridgeOauthDeadExpiresAt === deadExpiresAt
            ? (c.bridgeOauthDeadFailCount ?? 0) + 1
            : 1,
      }))
      return null
    }
  }

  // 4. Compute baseUrl.
  const baseUrl = getBridgeBaseUrl()

  // 5. Derive session title. Precedence: explicit initialName → /rename
  // (session storage) → last meaningful user message → generated slug.
  // Cosmetic only (claude.ai session list); the model never sees it.
  // Two flags: `hasExplicitTitle` (initialName or /rename — never auto-
  // overwrite) vs. `hasTitle` (any title, including auto-derived — blocks
  // the count-1 re-derivation but not count-3). The onUserMessage callback
  // below derives from the 1st prompt and again from the 3rd so mobile/web
  // show a title that reflects more context.
  // The slug fallback (e.g. "remote-control-graceful-unicorn") makes
  // auto-started sessions distinguishable in the claude.ai list before the
  // first prompt.
  let title = `remote-control-${generateShortWordSlug()}`
  let hasTitle = false
  let hasExplicitTitle = false
  if (initialName) {
    title = initialName
    hasTitle = true
    hasExplicitTitle = true
  } else {
    const sessionId = getSessionId()
    const customTitle = sessionId
      ? getCurrentSessionTitle(sessionId)
      : undefined
    if (customTitle) {
      title = customTitle
      hasTitle = true
      hasExplicitTitle = true
    } else if (initialMessages && initialMessages.length > 0) {
      // Find the last user message that has meaningful content. Skip meta
      // (nudges), tool results, compact summaries ("This session is being
      // continued…"), non-human origins (task notifications, channel pushes),
      // and synthetic interrupts ([Request interrupted by user]) — none are
      // human-authored. Same filter as extractTitleText + isSyntheticMessage.
      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const msg = initialMessages[i]!
        if (
          msg.type !== 'user' ||
          msg.isMeta ||
          msg.toolUseResult ||
          msg.isCompactSummary ||
          (msg.origin && msg.origin.kind !== 'human') ||
          isSyntheticMessage(msg)
        )
          continue
        const rawContent = getContentText(msg.message.content)
        if (!rawContent) continue
        const derived = deriveTitle(rawContent)
        if (!derived) continue
        title = derived
        hasTitle = true
        break
      }
    }
  }

  // Fires on every title-worthy user message until it returns true. At
  // count 1: deriveTitle placeholder immediately, then
  // generateSessionTitle (Haiku, sentence-case) fire-and-forget upgrade. At
  // count 3: re-generate over the full conversation. Skips entirely if the
  // title is explicit (/remote-control <name> or /rename) — re-checks
  // sessionStorage at call time so /rename between messages isn't clobbered.
  // Skips count 1 if initialMessages already derived (that title is fresh);
  // still refreshes at count 3. updateBridgeSessionTitle retags cse_* ids
  // internally.
  let userMessageCount = 0
  let lastBridgeSessionId: string | undefined
  let genSeq = 0
  const patch = (
    derived: string,
    bridgeSessionId: string,
    atCount: number,
  ): void => {
    hasTitle = true
    title = derived
    logForDebugging(
      `[bridge:repl] derived title from message ${atCount}: ${derived}`,
    )
    void updateBridgeSessionTitle(bridgeSessionId, derived, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    }).catch(() => {})
  }
  // Fire-and-forget Haiku generation with post-await guards. Re-checks /rename
  // (sessionStorage), v1 env-lost (lastBridgeSessionId), and same-session
  // out-of-order resolution (genSeq — count-1's Haiku resolving after count-3
  // would clobber the richer title). generateSessionTitle never rejects.
  const generateAndPatch = (input: string, bridgeSessionId: string): void => {
    const gen = ++genSeq
    const atCount = userMessageCount
    void generateSessionTitle(input, AbortSignal.timeout(15_000)).then(
      generated => {
        if (
          generated &&
          gen === genSeq &&
          lastBridgeSessionId === bridgeSessionId &&
          !getCurrentSessionTitle(getSessionId())
        ) {
          patch(generated, bridgeSessionId, atCount)
        }
      },
    )
  }
  const onUserMessage = (text: string, bridgeSessionId: string): boolean => {
    if (hasExplicitTitle || getCurrentSessionTitle(getSessionId())) {
      return true
    }
    // v1 env-lost re-creates the session with a new ID. Reset the count so
    // the new session gets its own count-3 derivation; hasTitle stays true
    // (new session was created via getCurrentTitle(), which reads the count-1
    // title from this closure), so count-1 of the fresh cycle correctly skips.
    if (
      lastBridgeSessionId !== undefined &&
      lastBridgeSessionId !== bridgeSessionId
    ) {
      userMessageCount = 0
    }
    lastBridgeSessionId = bridgeSessionId
    userMessageCount++
    if (userMessageCount === 1 && !hasTitle) {
      const placeholder = deriveTitle(text)
      if (placeholder) patch(placeholder, bridgeSessionId, userMessageCount)
      generateAndPatch(text, bridgeSessionId)
    } else if (userMessageCount === 3) {
      const msgs = getMessages?.()
      const input = msgs
        ? extractConversationText(getMessagesAfterCompactBoundary(msgs))
        : text
      generateAndPatch(input, bridgeSessionId)
    }
    // Also re-latches if v1 env-lost resets the transport's done flag past 3.
    return userMessageCount >= 3
  }

  // Fetch orgUUID — environment registration needs it.
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge:repl] Skipping: no org UUID')
    onStateChange?.('failed', '/login')
    return null
  }

  // ── env-based bridge (register/poll/ack/heartbeat) ────────────────────

  // Gather git context — this is the bootstrap-read boundary.
  // Everything from here down is passed explicitly to bridgeCore.
  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const sessionIngressUrl =
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL || baseUrl

  // 6. Delegate. BridgeCoreHandle is a structural superset of
  // ReplBridgeHandle (adds writeSdkMessages which REPL callers don't use),
  // so no adapter needed — just the narrower type on the way out.
  return initBridgeCore({
    dir: getOriginalCwd(),
    machineName: hostname(),
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType: 'claude_code' satisfies BridgeWorkerType,
    getAccessToken: getBridgeAccessToken,
    createSession: opts =>
      createBridgeSession({
        ...opts,
        events: [],
        baseUrl,
        getAccessToken: getBridgeAccessToken,
      }),
    archiveSession: sessionId =>
      archiveBridgeSession(sessionId, {
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        // gracefulShutdown.ts:407 races runCleanupFunctions against 2s.
        // Teardown also does stopWork (parallel) + deregister (sequential),
        // so archive can't have the full budget. 1.5s matches v2's
        // teardown_archive_timeout_ms default.
        timeoutMs: 1500,
      }).catch((err: unknown) => {
        // archiveBridgeSession has no try/catch — 5xx/timeout/network throw
        // straight through. Previously swallowed silently, making archive
        // failures BQ-invisible and undiagnosable from debug logs.
        logForDebugging(
          `[bridge:repl] archiveBridgeSession threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }),
    // getCurrentTitle is read on reconnect-after-env-lost to re-title the new
    // session. /rename writes to session storage; onUserMessage mutates
    // `title` directly — both paths are picked up here.
    getCurrentTitle: () => getCurrentSessionTitle(getSessionId()) ?? title,
    onUserMessage,
    toSDKMessages,
    onAuth401: handleOAuth401Error,
    getPollIntervalConfig,
    initialHistoryCap: INITIAL_HISTORY_CAP,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    perpetual,
  })
}

const TITLE_MAX_LEN = 50

/**
 * Quick placeholder title: strip display tags, take the first sentence,
 * collapse whitespace, truncate to 50 chars. Returns undefined if the result
 * is empty (e.g. message was only <local-command-stdout>). Replaced by
 * generateSessionTitle once Haiku resolves (~1-15s).
 */
function deriveTitle(raw: string): string | undefined {
  // Strip <ide_opened_file>, <session-start-hook>, etc. — these appear in
  // user messages when IDE/hooks inject context. stripDisplayTagsAllowEmpty
  // returns '' (not the original) so pure-tag messages are skipped.
  const clean = stripDisplayTagsAllowEmpty(raw)
  // First sentence is usually the intent; rest is often context/detail.
  // Capture group instead of lookbehind — keeps YARR JIT happy.
  const firstSentence = /^(.*?[.!?])\s/.exec(clean)?.[1] ?? clean
  // Collapse newlines/tabs — titles are single-line in the claude.ai list.
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
    : flat
}
