import { useCallback } from 'react';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import { useAppState, useAppStateStore, useSetAppState } from 'src/terminal/state/AppState.js';
import { backgroundAll, hasForegroundTasks } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js';
import { type GlobalConfig, getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
type Props = {
  onBackgroundSession: () => void;
  isLoading: boolean;
};

/**
 * Owns the ctrl+b (`task:background`) binding: with foreground bash/agent tasks
 * running, it backgrounds them all.
 *
 * It renders nothing. There used to be a second behaviour here — a double-press
 * hint that backgrounded the whole SESSION while a query was in flight — gated
 * on a flag that had been folded to a constant false, so the hint could not
 * appear and the second press could not fire. `onBackgroundSession` is kept in
 * the props because the REPL passes it; wiring it to a real gate is what it
 * would take to bring that behaviour back.
 */
export function SessionBackgroundHint(_props: Props) {
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();
  const handleBackground = useCallback(() => {
    if (isEnvTruthy(process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS)) {
      return;
    }
    const state = appStateStore.getState();
    if (hasForegroundTasks(state)) {
      backgroundAll(() => appStateStore.getState(), setAppState);
      if (!getGlobalConfig().hasUsedBackgroundTask) {
        saveGlobalConfig(markBackgroundTaskUsed);
      }
    }
  }, [appStateStore, setAppState]);
  const hasForeground = useAppState(hasForegroundTasks);
  useKeybinding('task:background', handleBackground, {
    context: 'Task',
    isActive: hasForeground,
  });
  return null;
}
function markBackgroundTaskUsed(c: GlobalConfig): GlobalConfig {
  return c.hasUsedBackgroundTask ? c : {
    ...c,
    hasUsedBackgroundTask: true
  };
}
