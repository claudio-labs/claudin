/**
 * CoordinatorTaskPanel — Steerable list of background agents.
 *
 * Renders below the prompt input footer whenever local_agent tasks exist.
 * Visibility is driven by evictAfter: undefined (running/retained) shows
 * always; a timestamp shows until passed. Enter to view/steer, x to dismiss.
 */

import figures from 'figures';
import * as React from 'react';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { BLACK_CIRCLE, PAUSE_ICON, PLAY_ICON } from '../constants/figures.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { stringWidth } from '../ink/stringWidth.js';
import { Box, Text, wrapText } from '../ink.js';
import { type AppState, useAppState, useSetAppState } from '../state/AppState.js';
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers.js';
import { isPanelAgentTask, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import { evictTerminalTask } from '../utils/task/framework.js';
import { isTerminalStatus } from './tasks/taskStatusUtils.js';

/**
 * Which panel-managed tasks currently have a visible row.
 * Presence in AppState.tasks IS visibility — the 1s tick in
 * CoordinatorTaskPanel evicts tasks past their evictAfter deadline. The
 * evictAfter !== 0 check handles immediate dismiss (x key) without making
 * the filter time-dependent. Shared by panel render, useCoordinatorTaskCount,
 * and index resolvers so the math can't drift.
 */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks).filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0).sort((a, b) => a.startTime - b.startTime);
}
export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  const agentNameRegistry = useAppState(s_1 => s_1.agentNameRegistry);
  const coordinatorTaskIndex = useAppState(s_2 => s_2.coordinatorTaskIndex);
  const tasksSelected = useAppState(s_3 => s_3.footerSelection === 'tasks');
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined;
  const setAppState = useSetAppState();
  const visibleTasks = getVisibleAgentTasks(tasks);
  const hasTasks = Object.values(tasks).some(isPanelAgentTask);

  // 1s tick: re-render for elapsed time + evict tasks past their deadline.
  // The eviction deletes from prev.tasks, which makes useCoordinatorTaskCount
  // (and other consumers) see the updated count without their own tick.
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!hasTasks) return;
    const interval = setInterval((tasksRef_0, setAppState_0, setTick_0) => {
      const now = Date.now();
      for (const t of Object.values(tasksRef_0.current)) {
        if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
          evictTerminalTask(t.id, setAppState_0);
        }
      }
      setTick_0((prev: number) => prev + 1);
    }, 1000, tasksRef, setAppState, setTick);
    return () => clearInterval(interval);
  }, [hasTasks, setAppState]);
  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>();
    for (const [n, id] of agentNameRegistry) inv.set(id, n);
    return inv;
  }, [agentNameRegistry]);
  if (visibleTasks.length === 0) {
    return null;
  }
  return <Box flexDirection="column" marginTop={1}>
      <MainLine isSelected={selectedIndex === 0} isViewed={viewingAgentTaskId === undefined} onClick={() => exitTeammateView(setAppState)} />
      {visibleTasks.map((task, i) => <AgentLine key={task.id} task={task} name={nameByAgentId.get(task.id)} isSelected={selectedIndex === i + 1} isViewed={viewingAgentTaskId === task.id} onClick={() => enterTeammateView(task.id, setAppState)} />)}
    </Box>;
}

/**
 * Returns the number of visible coordinator tasks (for selection bounds).
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this count
 * stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount() {
  const tasks = useAppState(_temp);
  let t0;
  t0 = 0;
  return t0;
}
function _temp(s) {
  return s.tasks;
}
function MainLine(t0: {
  isSelected?: boolean;
  isViewed?: boolean;
  onClick?: () => void;
}) {
  const {
    isSelected,
    isViewed,
    onClick
  } = t0;
  const { columns } = useTerminalSize();
  const [hover, setHover] = React.useState(false);
  const prefix = isSelected || hover ? figures.pointer + " " : "  ";
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  const dim = !isSelected && !isViewed && !hover;
  // Persistent navigation hint on the main row. Render the live up/down
  // bindings (Footer context, same mechanism as the neighboring view hint) so a
  // remap is reflected here too, instead of a hardcoded ↑/↓.
  const upKey = useShortcutDisplay('footer:up', 'Footer', '↑');
  const downKey = useShortcutDisplay('footer:down', 'Footer', '↓');
  const line = <Box width={columns} justifyContent="space-between">
      <Text dimColor={dim} bold={isViewed}>{prefix}{bullet} main</Text>
      <Text dimColor={true}>
        <KeyboardShortcutHint shortcut={`${upKey}/${downKey}`} action="select" />{" · "}
        <ConfigurableShortcutHint action="footer:openSelected" context="Footer" fallback="enter" description="view" />
      </Text>
    </Box>;
  if (!onClick) {
    return line;
  }
  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{line}</Box>;
}
type AgentLineProps = {
  task: LocalAgentTaskState;
  name?: string;
  isSelected?: boolean;
  isViewed?: boolean;
  onClick?: () => void;
};
function AgentLine(t0: AgentLineProps) {
  const {
    task,
    name,
    isSelected,
    isViewed,
    onClick
  } = t0;
  const {
    columns
  } = useTerminalSize();
  const [hover, setHover] = React.useState(false);
  const isRunning = !isTerminalStatus(task.status);
  const pausedMs = task.totalPausedMs ?? 0;
  const elapsedMs = Math.max(0, isRunning ? Date.now() - task.startTime - pausedMs : (task.endTime ?? task.startTime) - task.startTime - pausedMs);
  const elapsed = formatDuration(elapsedMs);
  // Live token count — same source the backgrounded AgentProgressLine reads, kept
  // in the identical `· ↓ N tokens` format (the ↓/↑ arrow signals output activity).
  const tokenCount = task.progress?.tokenCount;
  const lastActivity = task.progress?.lastActivity;
  const arrow = lastActivity ? figures.arrowDown : figures.arrowUp;
  const tokenText = tokenCount !== undefined && tokenCount > 0 ? ` · ${arrow} ${formatNumber(tokenCount)} tokens` : "";
  // Tool-use count gives an at-a-glance sense of how far along the agent is.
  const toolUseCount = task.progress?.toolUseCount ?? 0;
  const toolText = toolUseCount > 0 ? ` · ${toolUseCount} tool ${toolUseCount === 1 ? "use" : "uses"}` : "";
  const queuedCount = task.pendingMessages.length;
  const queuedText = queuedCount > 0 ? ` · ${queuedCount} queued` : "";
  const displayDescription = task.progress?.summary || task.description;
  const highlighted = isSelected || hover;
  const prefix = highlighted ? figures.pointer + " " : "  ";
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  const dim = !highlighted && !isViewed;
  const sep = isRunning ? PLAY_ICON : PAUSE_ICON;
  const namePart = name ? `${name}: ` : "";
  const hintPart = isSelected && !isViewed ? ` · x to ${isRunning ? "stop" : "clear"}` : "";
  // Metrics are right-aligned (space-between) so they form a consistent column
  // regardless of description length. The description truncates to whatever space
  // the left side has after reserving the metrics width.
  const suffixPart = ` ${sep} ${elapsed}${toolText}${tokenText}${queuedText}${hintPart}`;
  const availableForDesc = Math.max(0, columns - stringWidth(prefix) - stringWidth(`${bullet} `) - stringWidth(namePart) - stringWidth(suffixPart));
  const truncated = wrapText(displayDescription, availableForDesc, "truncate-end");
  const leftText = <Text dimColor={dim} bold={isViewed}>{prefix}{bullet}{" "}{name && <><Text dimColor={false} bold={true}>{name}</Text>{": "}</>}{truncated}</Text>;
  const rightText = <Text dimColor={dim}> {sep} {elapsed}{toolText}{tokenText}{queuedCount > 0 && <Text color="warning">{queuedText}</Text>}{hintPart && <Text dimColor={true}>{hintPart}</Text>}</Text>;
  const line = <Box width={columns} justifyContent="space-between">{leftText}{rightText}</Box>;
  if (!onClick) {
    return line;
  }
  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{line}</Box>;
}
