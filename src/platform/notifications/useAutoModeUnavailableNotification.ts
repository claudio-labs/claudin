import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { useNotifications } from 'src/terminal/contexts/notifications.js'
import { getIsRemoteMode } from 'src/platform/bootstrap/state.js'
import { useAppState } from 'src/terminal/state/AppState.js'
import type { PermissionMode } from 'src/services/permissions/PermissionMode.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
} from 'src/services/permissions/permissionSetup.js'
import { hasAutoModeOptIn } from 'src/platform/settings/settings.js'

/**
 * Shows a one-shot notification when the shift-tab carousel wraps past where
 * auto mode would have been. Covers all reasons (settings, circuit-breaker,
 * org-allowlist). The startup case (defaultMode: auto silently downgraded) is
 * handled by verifyAutoModeGateAccess → checkAndDisableAutoModeIfNeeded.
 */
export function useAutoModeUnavailableNotification(): void {
  const { addNotification } = useNotifications()
  const mode = useAppState(s => s.toolPermissionContext.mode)
  const isAutoModeAvailable = useAppState(
    s => s.toolPermissionContext.isAutoModeAvailable,
  )
  const shownRef = useRef(false)
  const prevModeRef = useRef<PermissionMode>(mode)

  useEffect(() => {
    const prevMode = prevModeRef.current
    prevModeRef.current = mode

    if (!feature('TRANSCRIPT_CLASSIFIER')) return
    if (getIsRemoteMode()) return
    if (shownRef.current) return

    const wrappedPastAutoSlot =
      mode === 'default' &&
      prevMode !== 'default' &&
      prevMode !== 'auto' &&
      !isAutoModeAvailable &&
      hasAutoModeOptIn()

    if (!wrappedPastAutoSlot) return

    const reason = getAutoModeUnavailableReason()
    if (!reason) return

    shownRef.current = true
    addNotification({
      key: 'auto-mode-unavailable',
      text: getAutoModeUnavailableNotification(reason),
      color: 'warning',
      priority: 'medium',
    })
  }, [mode, isAutoModeAvailable, addNotification])
}
