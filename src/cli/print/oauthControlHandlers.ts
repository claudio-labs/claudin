// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
// Anthropic-OAuth control-request handlers for the headless stdin loop,
// extracted from `runHeadlessStreaming` (`src/cli/print/runHeadless.ts`) as the
// deferred half of ROADMAP 11b.
//
// The flow is single-slot: `ctx.claudeOAuth` holds at most one in-flight
// service+promise pair, and a second `claude_authenticate` cleans up the first.
//
// Two ordering invariants live here and are easy to break by "simplifying":
//   * `handleClaudeOauthCallback` injects the manual code SYNCHRONOUSLY, before
//     any await, so a subsequent `claude_authenticate` cannot swap the service
//     out from under the code that is landing.
//   * It then DETACHES the await on `flow`. The stdin reader is serial, so
//     blocking here deadlocks `claude_oauth_wait_for_completion`: `flow` may
//     only resolve via a future `claude_oauth_callback` arriving on stdin,
//     which cannot be read while we are parked on it.

import { logEvent } from 'src/services/analytics/index.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { OAuthService } from 'src/services/oauth/index.js'
import { installOAuthTokens } from 'src/cli/handlers/auth.js'
import { getAccountInformation } from 'src/utils/auth.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type {
  HeadlessStreamingContext,
  ControlRequestWith,
} from 'src/cli/print/streamingContext.js'

export type ClaudeAuthenticateRequest = ControlRequestWith<{
  subtype: string
  loginWithClaudeAi?: boolean
}>

export type ClaudeOauthCallbackRequest = ControlRequestWith<{
  subtype: 'claude_oauth_callback' | 'claude_oauth_wait_for_completion'
  authorizationCode: string
  state: string
}>

export async function handleClaudeAuthenticate(
  ctx: HeadlessStreamingContext,
  message: ClaudeAuthenticateRequest,
): Promise<void> {
  // Anthropic OAuth over the control channel. The SDK client owns
  // the user's browser (we're headless in -p mode); we hand back
  // both URLs and wait. Automatic URL → localhost listener catches
  // the redirect if the browser is on this host; manual URL → the
  // success page shows "code#state" for claude_oauth_callback.
  const { loginWithClaudeAi } = message.request

  // Clean up any prior flow. cleanup() closes the localhost listener
  // and nulls the manual resolver. The prior `flow` promise is left
  // pending (AuthCodeListener.close() does not reject) but its object
  // graph becomes unreachable once the server handle is released and
  // is GC'd — no fd or port is held.
  ctx.claudeOAuth?.service.cleanup()

  logEvent('tengu_oauth_flow_start', {
    loginWithClaudeAi: loginWithClaudeAi ?? true,
  })

  const service = new OAuthService()
  let urlResolver!: (urls: {
    manualUrl: string
    automaticUrl: string
  }) => void
  const urlPromise = new Promise<{
    manualUrl: string
    automaticUrl: string
  }>(resolve => {
    urlResolver = resolve
  })

  const flow = service
    .startOAuthFlow(
      async (manualUrl, automaticUrl) => {
        // automaticUrl is always defined when skipBrowserOpen is set;
        // the signature is optional only for the existing single-arg callers.
        urlResolver({ manualUrl, automaticUrl: automaticUrl! })
      },
      {
        loginWithClaudeAi: loginWithClaudeAi ?? true,
        skipBrowserOpen: true,
      },
    )
    .then(async tokens => {
      // installOAuthTokens: performLogout (clear stale state) →
      // store profile → saveOAuthTokensIfNeeded → clearOAuthTokenCache
      // → clearAuthRelatedCaches. After this resolves, the memoized
      // getClaudeAIOAuthTokens in this process is invalidated; the
      // next API call re-reads keychain/file and works. No respawn.
      await installOAuthTokens(tokens)
      logEvent('tengu_oauth_success', {
        loginWithClaudeAi: loginWithClaudeAi ?? true,
      })
    })
    .finally(() => {
      service.cleanup()
      if (ctx.claudeOAuth?.service === service) {
        ctx.claudeOAuth = null
      }
    })

  ctx.claudeOAuth = { service, flow }

  // Attach the rejection handler before awaiting so a synchronous
  // startOAuthFlow failure doesn't surface as an unhandled rejection.
  // The claude_oauth_callback handler re-awaits flow for the manual
  // path and surfaces the real error to the client.
  void flow.catch(err =>
    logForDebugging(`claude_authenticate flow ended: ${err}`, {
      level: 'info',
    }),
  )

  try {
    // Race against flow: if startOAuthFlow rejects before calling
    // the authURLHandler (e.g. AuthCodeListener.start() fails with
    // EACCES or fd exhaustion), urlPromise would pend forever and
    // wedge the stdin loop. flow resolving first is unreachable in
    // practice (it's suspended on the same urls we're waiting for).
    const { manualUrl, automaticUrl } = await Promise.race([
      urlPromise,
      flow.then(() => {
        throw new Error('OAuth flow completed without producing auth URLs')
      }),
    ])
    ctx.sendControlResponseSuccess(message, {
      manualUrl,
      automaticUrl,
    })
  } catch (error) {
    ctx.sendControlResponseError(message, errorMessage(error))
  }
}

/**
 * Handles both `claude_oauth_callback` (carries the manual code) and
 * `claude_oauth_wait_for_completion` (just parks on the same flow).
 */
export function handleClaudeOauthCallback(
  ctx: HeadlessStreamingContext,
  message: ClaudeOauthCallbackRequest,
): void {
  if (!ctx.claudeOAuth) {
    ctx.sendControlResponseError(message, 'No active claude_authenticate flow')
    return
  }
  // Inject the manual code synchronously — must happen in stdin
  // message order so a subsequent claude_authenticate doesn't
  // replace the service before this code lands.
  if (message.request.subtype === 'claude_oauth_callback') {
    ctx.claudeOAuth.service.handleManualAuthCodeInput({
      authorizationCode: message.request.authorizationCode,
      state: message.request.state,
    })
  }
  // Detach the await — the stdin reader is serial and blocking
  // here deadlocks claude_oauth_wait_for_completion: flow may
  // only resolve via a future claude_oauth_callback on stdin,
  // which can't be read while we're parked. Capture the binding;
  // claudeOAuth is nulled in flow's own .finally.
  const { flow } = ctx.claudeOAuth
  void flow.then(
    () => {
      const accountInfo = getAccountInformation()
      ctx.sendControlResponseSuccess(message, {
        account: {
          email: accountInfo?.email,
          organization: accountInfo?.organization,
          subscriptionType: accountInfo?.subscription,
          tokenSource: accountInfo?.tokenSource,
          apiKeySource: accountInfo?.apiKeySource,
          apiProvider: getAPIProvider(),
        },
      })
    },
    (error: unknown) => ctx.sendControlResponseError(message, errorMessage(error)),
  )
}
