import * as React from 'react'

import {
  KimiOAuthService,
  type KimiDeviceCodeResponse,
  type KimiOAuthTokens,
} from '../services/api/kimiOAuth.js'
import { openBrowser } from '../utils/browser.js'
import { isBareMode } from '../utils/envUtils.js'
import { saveKimiCredentials } from '../utils/kimiCredentials.js'

export type KimiOAuthFlowStatus =
  | { state: 'starting' }
  | {
      state: 'waiting'
      userCode: string
      verificationUri: string
      verificationUriComplete?: string
    }
  | {
      state: 'error'
      message: string
    }

type PersistKimiOAuthCredentials = (options?: { profileId?: string }) => void

type KimiOAuthServiceLike = Pick<KimiOAuthService, 'startDeviceFlow' | 'cleanup'>

type KimiOAuthFlowDependencies = {
  createOAuthService?: () => KimiOAuthServiceLike
  saveKimiCredentials?: typeof saveKimiCredentials
  isBareMode?: typeof isBareMode
}

function createDefaultOAuthService(): KimiOAuthServiceLike {
  return new KimiOAuthService()
}

export function useKimiOAuthFlow(options: {
  onAuthenticated: (
    tokens: KimiOAuthTokens,
    persistCredentials: PersistKimiOAuthCredentials,
  ) => void | Promise<void>
  deps?: KimiOAuthFlowDependencies
}): KimiOAuthFlowStatus {
  const { onAuthenticated } = options
  const createOAuthService =
    options.deps?.createOAuthService ?? createDefaultOAuthService
  const saveCredentials =
    options.deps?.saveKimiCredentials ?? saveKimiCredentials
  const isBareModeFn = options.deps?.isBareMode ?? isBareMode
  const [status, setStatus] = React.useState<KimiOAuthFlowStatus>({
    state: 'starting',
  })
  const openedBrowserRef = React.useRef(false)

  React.useEffect(() => {
    if (isBareModeFn()) {
      setStatus({
        state: 'error',
        message:
          'Kimi Code OAuth is unavailable in --bare because secure storage is disabled.',
      })
      return
    }

    let cancelled = false
    const oauthService = createOAuthService()

    void oauthService
      .startDeviceFlow(async (device: KimiDeviceCodeResponse) => {
        if (cancelled) return
        setStatus({
          state: 'waiting',
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: device.verification_uri_complete,
        })
      })
      .then(async tokens => {
        if (cancelled) return

        const persistCredentials: PersistKimiOAuthCredentials = options => {
          const saved = saveCredentials({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            profileId: options?.profileId,
          })
          if (!saved.success) {
            throw new Error(
              saved.warning ??
                'Kimi Code OAuth succeeded, but credentials could not be saved securely.',
            )
          }
        }

        await onAuthenticated(tokens, persistCredentials)
      })
      .catch(error => {
        if (cancelled) return
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      oauthService.cleanup()
    }
  }, [createOAuthService, isBareModeFn, onAuthenticated, saveCredentials])

  // Open the pre-filled verification URL automatically when available. The
  // user can still authorize manually on another device because we keep the
  // code + URL rendered in the TUI as fallback.
  React.useEffect(() => {
    if (status.state !== 'waiting') return
    if (openedBrowserRef.current) return
    const url = status.verificationUriComplete ?? status.verificationUri
    if (!url) return
    openedBrowserRef.current = true
    void openBrowser(url).catch(() => {
      // Silent: the rendered URL/code is the fallback for headless/SSH/WSL.
    })
  }, [status])

  return status
}
