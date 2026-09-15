/**
 * Component that registers global keybinding handlers.
 *
 * Must be rendered inside KeybindingSetup to have access to the keybinding context.
 * This component renders nothing - it just registers the keybinding handlers.
 */
import { feature } from 'bun:bundle';
import { useCallback } from 'react';
import instances from 'src/terminal/ink/instances.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import type { Screen } from 'src/agent/repl/REPL.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js';
import { logEvent } from 'src/platform/analytics/index.js';
import { useAppState, useSetAppState } from 'src/terminal/state/AppState.js';
import { count } from 'src/shared/data/array.js';
import { getTerminalPanel } from 'src/terminal/terminalPanel.js';
type Props = {
  screen: Screen;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  showAllInTranscript: boolean;
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>;
  messageCount: number;
  onEnterTranscript?: () => void;
  onExitTranscript?: () => void;
  virtualScrollActive?: boolean;
  searchBarOpen?: boolean;
};

/**
 * Registers global keybinding handlers for:
 * - ctrl+t: Toggle todo list
 * - ctrl+o: Toggle transcript mode
 * - ctrl+e: Toggle showing all messages in transcript
 * - ctrl+c/escape: Exit transcript mode
 */
export function GlobalKeybindingHandlers({
  screen,
  setScreen,
  showAllInTranscript,
  setShowAllInTranscript,
  messageCount,
  onEnterTranscript,
  onExitTranscript,
  virtualScrollActive,
  searchBarOpen = false
}: Props): null {
  const expandedView = useAppState(s => s.expandedView);
  const setAppState = useSetAppState();

  // Toggle todo list (ctrl+t) - cycles through views
  const handleToggleTodos = useCallback(() => {
    logEvent('tengu_toggle_todos', {
      is_expanded: expandedView === 'tasks'
    });
    setAppState(prev => {
      const {
        getAllInProcessTeammateTasks
      } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js') as typeof import('src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js');
      const hasTeammates = count(getAllInProcessTeammateTasks(prev.tasks), t => t.status === 'running') > 0;
      if (hasTeammates) {
        // Both exist: none → tasks → teammates → none
        switch (prev.expandedView) {
          case 'none':
            return {
              ...prev,
              expandedView: 'tasks' as const
            };
          case 'tasks':
            return {
              ...prev,
              expandedView: 'teammates' as const
            };
          case 'teammates':
            return {
              ...prev,
              expandedView: 'none' as const
            };
        }
      }
      // Only tasks: none ↔ tasks
      return {
        ...prev,
        expandedView: prev.expandedView === 'tasks' ? 'none' as const : 'tasks' as const
      };
    });
  }, [expandedView, setAppState]);

  // Toggle transcript mode (ctrl+o). Two-way prompt ↔ transcript.
  const handleToggleTranscript = useCallback(() => {
    const isEnteringTranscript = screen !== 'transcript';
    logEvent('tengu_toggle_transcript', {
      is_entering: isEnteringTranscript,
      show_all: showAllInTranscript,
      message_count: messageCount
    });
    setScreen(s_1 => s_1 === 'transcript' ? 'prompt' : 'transcript');
    setShowAllInTranscript(false);
    if (isEnteringTranscript && onEnterTranscript) {
      onEnterTranscript();
    }
    if (!isEnteringTranscript && onExitTranscript) {
      onExitTranscript();
    }
  }, [screen, setScreen, showAllInTranscript, setShowAllInTranscript, messageCount, onEnterTranscript, onExitTranscript]);

  // Toggle showing all messages in transcript mode (ctrl+e)
  const handleToggleShowAll = useCallback(() => {
    logEvent('tengu_transcript_toggle_show_all', {
      is_expanding: !showAllInTranscript,
      message_count: messageCount
    });
    setShowAllInTranscript(prev_1 => !prev_1);
  }, [showAllInTranscript, setShowAllInTranscript, messageCount]);

  // Exit transcript mode (ctrl+c or escape)
  const handleExitTranscript = useCallback(() => {
    logEvent('tengu_transcript_exit', {
      show_all: showAllInTranscript,
      message_count: messageCount
    });
    setScreen('prompt');
    setShowAllInTranscript(false);
    if (onExitTranscript) {
      onExitTranscript();
    }
  }, [setScreen, showAllInTranscript, setShowAllInTranscript, messageCount, onExitTranscript]);

  // Register keybinding handlers
  useKeybinding('app:toggleTodos', handleToggleTodos, {
    context: 'Global'
  });
  useKeybinding('app:toggleTranscript', handleToggleTranscript, {
    context: 'Global'
  });

  // Register teammate keybinding
  useKeybinding('app:toggleTeammatePreview', () => {
    setAppState(prev_3 => ({
      ...prev_3,
      showTeammateMessagePreview: !prev_3.showTeammateMessagePreview
    }));
  }, {
    context: 'Global'
  });

  // Toggle built-in terminal panel (meta+j).
  // toggle() blocks in spawnSync until the user detaches from tmux.
  const handleToggleTerminal = useCallback(() => {
    if (feature('TERMINAL_PANEL')) {
      if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false)) {
        return;
      }
      getTerminalPanel().toggle();
    }
  }, []);
  useKeybinding('app:toggleTerminal', handleToggleTerminal, {
    context: 'Global'
  });

  // Clear screen and force full redraw (ctrl+l). Recovery path when the
  // terminal was cleared externally (macOS Cmd+K) and Ink's diff engine
  // thinks unchanged cells don't need repainting.
  const handleRedraw = useCallback(() => {
    instances.get(process.stdout)?.forceRedraw();
  }, []);
  useKeybinding('app:redraw', handleRedraw, {
    context: 'Global'
  });

  // Transcript-specific bindings (only active when in transcript mode)
  const isInTranscript = screen === 'transcript';
  useKeybinding('transcript:toggleShowAll', handleToggleShowAll, {
    context: 'Transcript',
    isActive: isInTranscript && !virtualScrollActive
  });
  useKeybinding('transcript:exit', handleExitTranscript, {
    context: 'Transcript',
    // Bar-open is a mode (owns keystrokes). Navigating (highlights
    // visible, n/N active, bar closed) is NOT — Esc exits transcript
    // directly, same as less q. useSearchInput doesn't stopPropagation,
    // so without this gate its onCancel AND this handler would both
    // fire on one Esc (child registers first, fires first, bubbles).
    isActive: isInTranscript && !searchBarOpen
  });
  return null;
}
