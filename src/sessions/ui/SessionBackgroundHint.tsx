import { useCallback } from 'react'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import { useAppState, useAppStateStore, useSetAppState } from 'src/terminal/state/AppState.js'
import { backgroundAll, hasForegroundTasks } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'
import { type GlobalConfig, getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
type Props = {
  onBackgroundSession: () => void
  isLoading: boolean
}

/**
 * Owns Ctrl+B (`task:background`) while foreground bash or agent tasks run,
 * and sends them all to the background. It renders nothing.
 *
 * Neither prop is read. The REPL passes them for a second behaviour that is
 * gone (backgrounding the whole session on a double press while a query
 * runs); they stay until the REPL decides what Ctrl+B does then.
 */
export function SessionBackgroundHint(_props: Props): null {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const foregroundWork = useAppState(hasForegroundTasks)

  const sendToBackground = useCallback(() => {
    if (isEnvTruthy(process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS)) return
    backgroundAll(store.getState, setAppState)
    if (!getGlobalConfig().hasUsedBackgroundTask) saveGlobalConfig(withBackgroundTaskUsed)
  }, [store, setAppState])

  useKeybinding('task:background', sendToBackground, { context: 'Task', isActive: foregroundWork })
  return null
}

function withBackgroundTaskUsed(config: GlobalConfig): GlobalConfig {
  return config.hasUsedBackgroundTask ? config : { ...config, hasUsedBackgroundTask: true }
}
