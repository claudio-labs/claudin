import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text } from 'src/terminal/ink.js';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { computeGlimmerIndex, computeShimmerSegments, SHIMMER_INTERVAL_MS } from 'src/platform/bridge/bridgeStatusUtil.js';
import { feature } from 'bun:bundle';
import { count } from 'src/shared/data/array.js';
import sample from 'lodash-es/sample.js';
import { formatDuration, formatNumber, formatSecondsShort } from 'src/shared/text/format.js';
import type { Theme } from 'src/terminal/theme/theme.js';
import { getSpinnerVerbs } from 'src/agent/prompts/spinnerVerbs.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { TaskListV2 } from 'src/agent/ui/TaskListV2.js';
import { useTasksV2 } from 'src/agent/hooks/useTasksV2.js';
import type { Task } from 'src/agent/tasks/tasks.js';
import { type AppState, useAppState } from 'src/terminal/state/AppState.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { stringWidth } from 'src/terminal/ink/stringWidth.js';
import { getDefaultCharacters, isBoldSpinnerFrame, SPINNER_FRAME_MS, type SpinnerMode } from 'src/terminal/spinner/index.js';
import { SpinnerAnimationRow } from 'src/terminal/spinner/SpinnerAnimationRow.js';
import { useSettings } from 'src/platform/useSettings.js';
import { isInProcessTeammateTask } from 'src/agent/tasks/InProcessTeammateTask/types.js';
import { isBackgroundTask } from 'src/agent/tasks/types.js';
import { getAllInProcessTeammateTasks } from 'src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { getEffortSuffix, isAdaptiveEffort } from 'src/providers/effort/effort.js';
import { getMainLoopModel } from 'src/providers/model/model.js';
import { getViewedTeammateTask } from 'src/terminal/state/selectors.js';
import { TEARDROP_ASTERISK } from 'src/shared/constants/figures.js';
import figures from 'figures';
import { getCurrentTurnTokenBudget, getTurnOutputTokens } from 'src/platform/bootstrap/state.js';
import { TeammateSpinnerTree } from 'src/terminal/spinner/TeammateSpinnerTree.js';
import { useAnimationFrame } from 'src/terminal/ink.js';
import { getGlobalConfig } from 'src/platform/config/config.js';
export type { SpinnerMode } from 'src/terminal/spinner/index.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
// No mirroring: the orbit is a directional rotation (see getDefaultCharacters).
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS];
type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader's turn has completed (no active query). Used to suppress stall-red spinner when only teammates are running. */
  leaderIsIdle?: boolean;
};

// Thin wrapper: branches on isBriefOnly so the two variants have independent
export function SpinnerWithVerb(props: Props): React.ReactNode {
  return <SpinnerWithVerbInner {...props} />;
}
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false
}: Props): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;

  // NOTE: useAnimationFrame(50) lives in SpinnerAnimationRow, not here.
  // This component only re-renders when props or app state change —
  // it is no longer on the 50ms clock. All `time`-derived values
  // (frame, glimmer, stalled intensity, token counter, thinking shimmer,
  // elapsed-time timer) are computed inside the child.

  const tasks = useAppState((s: AppState) => s.tasks);
  const viewingAgentTaskId = useAppState(
    (s_0: AppState) => s_0.viewingAgentTaskId,
  );
  const expandedView = useAppState((s_1: AppState) => s_1.expandedView);
  const showExpandedTodos = expandedView === 'tasks';
  const showSpinnerTree = expandedView === 'teammates';
  const selectedIPAgentIndex = useAppState(
    (s_2: AppState) => s_2.selectedIPAgentIndex,
  );
  const viewSelectionMode = useAppState(
    (s_3: AppState) => s_3.viewSelectionMode,
  );
  // Get foregrounded teammate (if viewing a teammate's transcript)
  const foregroundedTeammate = viewingAgentTaskId ? getViewedTeammateTask({
    viewingAgentTaskId,
    tasks
  }) : undefined;
  const {
    columns
  } = useTerminalSize();
  const tasksV2 = useTasksV2();

  // Track thinking status: 'thinking' | number (duration in ms) | null
  // Shows each state for minimum 2s to avoid UI jank
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null);
  const thinkingStartRef = useRef<number | null>(null);
  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;
    if (mode === 'thinking') {
      // Started thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus('thinking');
      }
    } else if (thinkingStartRef.current !== null) {
      // Stopped thinking - calculate duration and ensure 2s minimum display
      const duration = Date.now() - thinkingStartRef.current;
      const elapsed = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - elapsed);
      thinkingStartRef.current = null;

      // Show "thinking..." for remaining time if < 2s elapsed, then show duration
      const showDuration = (): void => {
        setThinkingStatus(duration);
        // Clear after 2s
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null);
      };
      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }
    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer);
      if (clearStatusTimer) clearTimeout(clearStatusTimer);
    };
  }, [mode]);

  // Find the current in-progress task and next pending task
  const currentTodo = tasksV2?.find(task => task.status !== 'pending' && task.status !== 'completed');
  const nextTask = findNextPendingTask(tasksV2);

  // Use useState with initializer to pick a random verb once on mount
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()));

  // Leader's own verb (always the leader's, regardless of who is foregrounded)
  const leaderVerb = overrideMessage ?? currentTodo?.activeForm ?? currentTodo?.subject ?? randomVerb;
  const effectiveVerb = foregroundedTeammate && !foregroundedTeammate.isIdle ? foregroundedTeammate.spinnerVerb ?? randomVerb : leaderVerb;
  const message = effectiveVerb + '…';

  const effortValue = useAppState((s_4: AppState) => s_4.effortValue);
  // Adaptive effort is no longer surfaced in the UI but legacy settings may
  // still hold the value; treat it as unset so the pinned-level suffix path
  // applies once the user picks a level.
  const effortSuffix = isAdaptiveEffort(effortValue) ? '' : getEffortSuffix(getMainLoopModel(), effortValue);
  const thinkingVerb = 'thinking';

  // Check if any running in-process teammates exist (needed for both modes)
  const runningTeammates = getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running');
  const hasRunningTeammates = runningTeammates.length > 0;
  const allIdle = hasRunningTeammates && runningTeammates.every(t_0 => t_0.isIdle);

  // Gather aggregate token stats from all running swarm teammates
  // In spinner-tree mode, skip aggregation (teammates have their own lines in the tree)
  let teammateTokens = 0;
  if (!showSpinnerTree) {
    for (const task_0 of Object.values(tasks)) {
      if (isInProcessTeammateTask(task_0) && task_0.status === 'running') {
        if (task_0.progress?.tokenCount) {
          teammateTokens += task_0.progress.tokenCount;
        }
      }
    }
  }

  // Stale read of the refs for showBtwTip below — we're off the 50ms clock
  // so this only updates when props/app state change, which is sufficient for
  // a coarse 30s threshold.
  const elapsedSnapshot = pauseStartTimeRef.current !== null ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;

  // Leader token count for TeammateSpinnerTree — read raw (non-animated) from
  // the ref. The tree is only shown when teammates are running; teammate
  // progress updates to s.tasks trigger re-renders that keep this fresh.
  const leaderTokenCount = Math.round(responseLengthRef.current / 4);
  const defaultColor: keyof Theme = 'claude';
  const defaultShimmerColor = 'claudeShimmer';
  const messageColor = overrideColor ?? defaultColor;
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor;

  // When leader is idle but teammates are running (and we're viewing the leader),
  // show a static dim idle display instead of the animated spinner — otherwise
  // useStalledAnimation detects no new tokens after 3s and turns the spinner red.
  if (leaderIsIdle && hasRunningTeammates && !foregroundedTeammate) {
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} Idle
            {!allIdle && ' · teammates running'}
          </Text>
        </Box>
        {showSpinnerTree && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderTokenCount={leaderTokenCount} leaderIdleText="Idle" />}
      </Box>;
  }

  // When viewing an idle teammate, show static idle display instead of animated spinner
  if (foregroundedTeammate?.isIdle) {
    const idleText = allIdle ? `${TEARDROP_ASTERISK} Worked for ${formatDuration(Date.now() - foregroundedTeammate.startTime)}` : `${TEARDROP_ASTERISK} Idle`;
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>{idleText}</Text>
        </Box>
        {showSpinnerTree && hasRunningTeammates && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} />}
      </Box>;
  }

  // Time-based tip overrides: coarse thresholds so a stale ref read (we're
  // off the 50ms clock) is fine. Other triggers (mode change, setMessages)
  // cause re-renders that refresh this in practice.
  let contextTipsActive = false;
  const tipsEnabled = settings.spinnerTipsEnabled !== false;
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000;
  const showBtwTip = tipsEnabled && elapsedSnapshot > 30_000 && !getGlobalConfig().btwUseCount;
  const effectiveTip = contextTipsActive ? undefined : showClearTip && !nextTask ? 'Use /clear to start fresh when switching topics and free up context' : showBtwTip && !nextTask ? "Use /btw to ask a quick side question without interrupting Claudin's current work" : spinnerTip;

  // Budget text (internal-only) — shown above the tip line
  let budgetText: string | null = null;
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens();
      if (tokens >= budget) {
        budgetText = `Target: ${formatNumber(tokens)} used (${formatNumber(budget)} min ${figures.tick})`;
      } else {
        const pct = Math.round(tokens / budget * 100);
        const remaining = budget - tokens;
        const rate = elapsedSnapshot > 5000 && tokens >= 2000 ? tokens / elapsedSnapshot : 0;
        const eta = rate > 0 ? ` \u00B7 ~${formatDuration(remaining / rate, {
          mostSignificantOnly: true
        })}` : '';
        budgetText = `Target: ${formatNumber(tokens)} / ${formatNumber(budget)} (${pct}%)${eta}`;
      }
    }
  }
  return <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow mode={mode} reducedMotion={reducedMotion} hasActiveTools={hasActiveTools} responseLengthRef={responseLengthRef} message={message} messageColor={messageColor} shimmerColor={shimmerColor} overrideColor={overrideColor} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} spinnerSuffix={spinnerSuffix} verbose={verbose} columns={columns} hasRunningTeammates={hasRunningTeammates} teammateTokens={teammateTokens} foregroundedTeammate={foregroundedTeammate} leaderIsIdle={leaderIsIdle} thinkingStatus={thinkingStatus} effortSuffix={effortSuffix} thinkingVerb={thinkingVerb} />
      {showSpinnerTree && hasRunningTeammates ? <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} /> : showExpandedTodos && tasksV2 && tasksV2.length > 0 ? <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box> : nextTask || effectiveTip || budgetText ?
    // IMPORTANT: we need this width="100%" to avoid an Ink bug where the
    // tip gets duplicated over and over while the spinner is running if
    // the terminal is very small. TODO: fix this in Ink.
    <Box width="100%" flexDirection="column">
          {budgetText && <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>}
          {(nextTask || effectiveTip) && <MessageResponse>
              <Text dimColor>
                {nextTask ? `Next: ${nextTask.subject}` : `Tip: ${effectiveTip}`}
              </Text>
            </MessageResponse>}
        </Box> : null}
    </Box>;
}

// Brief/assistant mode spinner: single status line. PromptInput drops its
// Idle placeholder for brief mode. Same 2-row [blank, content] footprint
// as the working spinner so the input bar never jumps when toggling between
// working/idle/disconnected. PromptInput's absolute-positioned Notifications
// overlay compensates with marginTop=-2 in brief mode.
export function BriefIdleStatus() {
  const $ = _c(9);
  const connStatus = useAppState(_temp7);
  const runningCount = useAppState(_temp8);
  const {
    columns
  } = useTerminalSize();
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? "Reconnecting\u2026" : "Disconnected";
  const leftText = showConnWarning ? connText : "";
  const rightText = runningCount > 0 ? `${runningCount} in background` : "";
  if (!leftText && !rightText) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Box height={2} />;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    return t0;
  }
  const pad = Math.max(1, columns - 2 - stringWidth(leftText) - stringWidth(rightText));
  let t0;
  if ($[1] !== leftText) {
    t0 = leftText ? <Text color="error">{leftText}</Text> : null;
    $[1] = leftText;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== pad || $[4] !== rightText) {
    t1 = rightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{rightText}</Text></> : null;
    $[3] = pad;
    $[4] = rightText;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== t0 || $[7] !== t1) {
    t2 = <Box marginTop={1} paddingLeft={2}><Text>{t0}{t1}</Text></Box>;
    $[6] = t0;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  return t2;
}
function _temp8(s_0: AppState) {
  return count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount;
}
function _temp7(s: AppState) {
  return s.remoteConnectionStatus;
}
export function Spinner() {
  const $ = _c(9);
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : SPINNER_FRAME_MS);
  if (reducedMotion) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Text color="text">●</Text>;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    let t1;
    if ($[1] !== ref) {
      t1 = <Box ref={ref} flexWrap="wrap" height={1} width={2}>{t0}</Box>;
      $[1] = ref;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  const frame = Math.floor(time / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  const t0 = SPINNER_FRAMES[frame];
  const bold = isBoldSpinnerFrame(frame);
  let t1;
  if ($[3] !== t0 || $[4] !== bold) {
    t1 = <Text bold={bold} color="text">{t0}</Text>;
    $[3] = t0;
    $[4] = bold;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== ref || $[7] !== t1) {
    t2 = <Box ref={ref} flexWrap="wrap" height={1} width={2}>{t1}</Box>;
    $[6] = ref;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  return t2;
}
function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
