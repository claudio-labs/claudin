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
import { useAppState, useSetAppState } from '../state/AppState.js';
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers.js';
import { isPanelAgentTask, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import { evictTerminalTask } from '../utils/task/framework.js';
import { isTerminalStatus } from './tasks/taskStatusUtils.js';
import { countFooterTaskRows } from './tasks/footerSelection.js';
import { getVisibleAgentTasks } from './tasks/footerTaskGeometry.js';
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
  // Layout mirrors the BackgroundTaskGroupTree below: `● main` first, then an
  // `Agents (N)` group label, then one connector-prefixed row per agent
  // (├─/└─). The label is purely visual (no collapse) — render it WITHOUT the
  // tree's chevron so users don't expect Enter to toggle it. The other tree
  // headers (Shells/Monitors) DO toggle and keep the chevron. Selection model:
  // index 0 = main, 1..N = agents.
  return <Box flexDirection="column">
      <MainLine isSelected={selectedIndex === 0} isViewed={viewingAgentTaskId === undefined} onClick={() => exitTeammateView(setAppState)} />
      <Box flexDirection="row">
        <Text dimColor>{"    "}</Text>
        <Text bold>Agents</Text>
        <Text dimColor> ({visibleTasks.length})</Text>
      </Box>
      {visibleTasks.map((task, i) => <AgentLine key={task.id} task={task} name={nameByAgentId.get(task.id)} connector={i === visibleTasks.length - 1 ? "└─" : "├─"} isSelected={selectedIndex === i + 1} isViewed={viewingAgentTaskId === task.id} onClick={() => enterTeammateView(task.id, setAppState)} />)}
    </Box>;
}

/**
 * Returns the number of visible coordinator tasks (for selection bounds).
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this count
 * stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount() {
  // Total selectable footer rows under the tasks pill — the upper bound for the
  // coordinatorTaskIndex cursor. Agent portion: index 0 = main, 1..N = agents,
  // so N agents contribute N + 1 (0 when there are none, so the panel renders
  // nothing). Tree portion: the grouped shells/monitors/etc. rows sit right
  // after agents, so they're folded into the same count — this is what lets ↓
  // walk the cursor into the tree (and keeps x/enter acting on tree rows).
  return useAppState(s => {
    const n = getVisibleAgentTasks(s.tasks).length;
    const agentPart = n === 0 ? 0 : n + 1;
    // countFooterTaskRows is a cheap counter — no row-list allocation. Hot path:
    // this selector runs on every AppState change AND on the panel's 1s tick,
    // so the previous buildFooterTaskRows().rows.length per call was wasteful.
    const treePart = countFooterTaskRows(s.tasks, s.foregroundedTaskId, s.collapsedTaskGroups);
    return agentPart + treePart;
  });
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
  /** Tree connector glyph (├─ / └─) rendered before the bullet to group the
   * agent rows under the `▼ Agents (N)` header, matching BackgroundTaskGroupTree. */
  connector?: string;
  isSelected?: boolean;
  isViewed?: boolean;
  onClick?: () => void;
};
function AgentLine(t0: AgentLineProps) {
  const {
    task,
    name,
    connector,
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
  // Live activity shown after the name, e.g. `Reading AgentTool.tsx`. Falls back
  // to `Starting…` during the boot window before the agent reports progress, so
  // the row doesn't render as `(name)` with a dangling trailing space.
  const displayDescription = task.progress?.summary ?? (isRunning ? "Starting\u2026" : "");
  const highlighted = isSelected || hover;
  const prefix = highlighted ? figures.pointer + " " : "  ";
  // Tree connector (├─/└─) groups the row under the `▼ Agents (N)` header.
  const connectorPart = connector ? `${connector} ` : "";
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  const dim = !highlighted && !isViewed;
  const sep = isRunning ? PLAY_ICON : PAUSE_ICON;
  // Agent name in parentheses, rendered before the live activity so the row
  // reads `● (Whole-feature review) Reading AgentTool.tsx`. This is the same
  // launch name shown in the "background agents launched" line — task.description
  // — so the panel row stays identifiable even after progress text changes. A
  // registry/custom name (if present) wins, falling back to the agent type.
  // Cap the paren label so a long launch description doesn't crowd out the
  // live activity text. 30 chars is enough to keep "Whole-feature review",
  // "Coding-standards review", and similar names intact while truncating the
  // rare model-generated multi-sentence descriptions.
  const rawParenLabel = name || task.description || task.agentType;
  const parenLabel = rawParenLabel.length > 30 ? rawParenLabel.slice(0, 29) + "\u2026" : rawParenLabel;
  const namePart = `(${parenLabel}) `;
  const hintPart = isSelected && !isViewed ? ` · x to ${isRunning ? "stop" : "clear"}` : "";
  // Metrics are right-aligned (space-between) so they form a consistent column
  // regardless of description length. The description truncates to whatever space
  // the left side has after reserving the metrics width.
  const suffixPart = ` ${sep} ${elapsed}${toolText}${tokenText}${queuedText}${hintPart}`;
  const availableForDesc = Math.max(0, columns - stringWidth(prefix) - stringWidth(connectorPart) - stringWidth(`${bullet} `) - stringWidth(namePart) - stringWidth(suffixPart));
  const truncated = wrapText(displayDescription, availableForDesc, "truncate-end");
  const leftText = <Text dimColor={dim} bold={isViewed}>{prefix}<Text dimColor>{connectorPart}</Text>{bullet}{" "}<Text dimColor={false} bold={true}>{namePart}</Text>{truncated}</Text>;
  const rightText = <Text dimColor={dim}> {sep} {elapsed}{toolText}{tokenText}{queuedCount > 0 && <Text color="warning">{queuedText}</Text>}{hintPart && <Text dimColor={true}>{hintPart}</Text>}</Text>;
  const line = <Box width={columns} justifyContent="space-between">{leftText}{rightText}</Box>;
  if (!onClick) {
    return line;
  }
  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{line}</Box>;
}
