import { getClientType } from 'src/platform/bootstrap/state.js'
import { getRemoteSessionUrl, isRemoteSessionLocal } from 'src/constants/product.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * Returns attribution text for commits and PRs.
 *
 * Claudin adds NO attribution by default. Users who want a commit trailer or a
 * PR footer can opt in by setting `attribution.commit` / `attribution.pr` in
 * settings.json — those strings are used verbatim.
 */
export function getAttributionTexts(): AttributionTexts {
  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  const settings = getInitialSettings()
  return {
    commit: settings.attribution?.commit ?? '',
    pr: settings.attribution?.pr ?? '',
  }
}

/**
 * Get PR attribution text.
 *
 * Returns the user's custom `attribution.pr` when set, otherwise an empty
 * string — Claudin appends no PR footer by default.
 *
 * @param _getAppState unused; kept for call-site compatibility.
 */
export async function getEnhancedPRAttribution(
  _getAppState: () => AppState,
): Promise<string> {
  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  return getInitialSettings().attribution?.pr ?? ''
}
