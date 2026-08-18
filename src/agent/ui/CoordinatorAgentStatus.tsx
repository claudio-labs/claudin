/**
 * CoordinatorTaskPanel — Steerable list of background agents.
 *
 * Renders below the prompt input footer whenever local_agent tasks exist.
 * Visibility is driven by evictAfter: undefined (running/retained) shows
 * always; a timestamp shows until passed. Enter to view/steer, x to dismiss.
 */

import figures from 'figures';
import * as React from 'react';
import { BLACK_CIRCLE, PAUSE_ICON, PLAY_ICON } from 'src/shared/constants/figures.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { stringWidth } from 'src/terminal/ink/stringWidth.js';
import { Box, Text, wrapText } from 'src/terminal/ink.js';
import { useAppState, useSetAppState } from 'src/terminal/state/AppState.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import { enterTeammateView } from 'src/terminal/state/teammateViewHelpers.js';
import { isPanelAgentTask, type LocalAgentTaskState } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js';
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js';
import { formatDuration, formatNumber } from 'src/shared/text/format.js';
import { evictTerminalTask } from 'src/agent/tasks/framework.js';
import { isTerminalStatus } from 'src/agent/ui/tasks/taskStatusUtils.js';
import { countFooterTaskRows, getAgentPanelRows, getFooterPanelLayout } from 'src/agent/ui/tasks/footerTaskGeometry.js';
export function CoordinatorTaskPanel(): React.ReactNode {
  const tasks: AppState['tasks'] = useAppState((s: AppState) => s.tasks);
  const viewingAgentTaskId: AppState['viewingAgentTaskId'] = useAppState((s_0: AppState) => s_0.viewingAgentTaskId);
  const agentNameRegistry: AppState['agentNameRegistry'] = useAppState((s_1: AppState) => s_1.agentNameRegistry);
  const coordinatorTaskIndex: AppState['coordinatorTaskIndex'] = useAppState((s_2: AppState) => s_2.coordinatorTaskIndex);
  const tasksSelected: boolean = useAppState((s_3: AppState) => s_3.footerSelection === 'tasks');
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined;
  const setAppState = useSetAppState();
  const rows = getAgentPanelRows(tasks);
  // Cursor geometry: the summary header owns index 0, so the agent rows start
  // one further down than the row order alone would suggest.
  const layout = getFooterPanelLayout(tasks);
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
  if (rows.length === 0) {
    return null;
  }
  // Layout mirrors the BackgroundTaskGroupTree below: an `Agents (N)` group
  // label, then one connector-prefixed row per agent (├─/└─). The label is
  // purely visual (no collapse) — render it WITHOUT the tree's chevron so users
  // don't expect Enter to toggle it. The other tree headers (Shells/Monitors)
  // DO toggle and keep the chevron. Selection model: index 0 = the summary
  // header (FooterTaskSummary, rendered above this panel), 1..N = agents, in
  // row order.
  //
  // There is NO `● main` row: the summary header above is what folds this panel
  // away now, and leaving an agent's view is escape
  // (useBackgroundTaskNavigation) or the leader entry in the background-tasks
  // dialog.
  //
  // Rows are a tree, not a flat list: an agent spawned BY another agent
  // registers into the same root store (see setAppStateForTasks), so it is
  // indented under its parent instead of posing as one of main's own agents —
  // that is what made `Agents (4)` unexplainable next to a transcript block
  // that said `Running 3 agents…`.
  return <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{"    "}</Text>
        <Text bold>Agents</Text>
        <Text dimColor> ({rows.length})</Text>
      </Box>
      {rows.map((row, i) => <AgentLine key={row.task.id} task={row.task} name={nameByAgentId.get(row.task.id)} connector={row.connector} isSelected={selectedIndex === layout.agentStart + i} isViewed={viewingAgentTaskId === row.task.id} onClick={() => enterTeammateView(row.task.id, setAppState)} />)}
    </Box>;
}

/**
 * Returns the number of visible coordinator tasks (for selection bounds).
 * The panel's 1s tick evicts expired tasks from prev.tasks, so this count
 * stays accurate without needing its own tick.
 */
export function useCoordinatorTaskCount() {
  // Total selectable footer rows under the tasks pill — the upper bound for the
  // coordinatorTaskIndex cursor. Collapsed, the summary header is the only row
  // there is, so the cursor cannot walk into a panel that isn't painted.
  // Expanded, layout.treeBase already covers the summary header + agent rows,
  // and the grouped shells/monitors/etc. rows follow — folding them into one
  // count is what lets ↓ walk the cursor into the tree (and keeps x/enter
  // acting on tree rows).
  return useAppState((s: AppState) => {
    // countFooterTaskRows is a cheap counter — no row-list allocation. Hot path:
    // this selector runs on every AppState change AND on the panel's 1s tick,
    // so the previous buildFooterTaskRows().rows.length per call was wasteful.
    const treePart = countFooterTaskRows(s.tasks, s.foregroundedTaskId, s.collapsedTaskGroups);
    const layout = getFooterPanelLayout(s.tasks);
    if (layout.agentCount === 0 && treePart === 0) return 0;
    if (s.footerTasksCollapsed) return 1;
    return layout.treeBase + treePart;
  });
}
type AgentLineProps = {
  task: LocalAgentTaskState;
  name?: string;
  /** Tree connector rendered before the bullet to group the agent rows under
   * the `▼ Agents (N)` header, matching BackgroundTaskGroupTree. Carries the
   * ancestor guides for nested agents (`│  └─`), so its width varies with
   * depth — everything below measures it instead of assuming 2 columns. */
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
  // Live activity shown after the name, e.g. `Reading AgentTool.tsx`. Prefer
  // the forked-fork-mini summary (`task.progress.summary`) when the SDK summary
  // flag is on; otherwise fall back to the latest tool activity (the same source
  // `AgentProgressLine` uses for `lastToolInfo`), so the row updates live in the
  // default TUI path instead of being pinned at `Starting…`. Final fallback is
  // `Starting…` during the boot window before any tool fires, so the row
  // doesn't render as `(name)` with a dangling trailing space.
  const displayDescription = task.progress?.summary
    ?? task.progress?.lastActivity?.activityDescription
    ?? (isRunning ? "Starting\u2026" : "");
  const highlighted = isSelected || hover;
  // 4-wide prefix so the tree connector (└─/├─) sits directly under the `A` of
  // the `Agents` header, which is itself indented 4 spaces (see CoordinatorTaskPanel).
  const prefix = highlighted ? figures.pointer + "   " : "    ";
  // Tree connector (├─/└─) groups the row under the `▼ Agents (N)` header.
  const connectorPart = connector ? `${connector} ` : "";
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle;
  const dim = !highlighted && !isViewed;
  const sep = isRunning ? PLAY_ICON : PAUSE_ICON;
  // Render the row as `● dev-anchor(Whole-feature review) Reading AgentTool.tsx`
  // — a colored badge mirroring AgentProgressLine, then the parenthesized
  // launch description, then the live activity. Badge text is `agentType` (or
  // `@<name>` for teammate spawns), badge color is `getAgentColor(agentType)`
  // (teammates inherit the type's color, matching UI.tsx:682-687). The badge
  // text is always rendered in bold; only backgroundColor is gated on
  // `badgeColor`, so built-ins without a registered color (Code, Plan)
  // still get a labeled badge — consistent with AgentProgressLine.
  // The paren label is capped at 30 chars so a long launch description doesn't
  // crowd out the live activity text.
  const badgeColor = getAgentColor(task.agentType);
  const badgeLabel = name ? `@${name}` : task.agentType;
  const rawParenLabel = task.description || task.agentType;
  const parenLabel = rawParenLabel.length > 30 ? rawParenLabel.slice(0, 29) + "\u2026" : rawParenLabel;
  const badgeWidth = stringWidth(badgeLabel);
  const parenPart = `(${parenLabel}) `;
  const hintPart = isSelected && !isViewed ? ` · x to ${isRunning ? "stop" : "clear"}` : "";
  // Metrics are right-aligned (space-between) so they form a consistent column
  // regardless of description length. The description truncates to whatever space
  // the left side has after reserving the metrics width.
  const suffixPart = ` ${sep} ${elapsed}${toolText}${tokenText}${queuedText}${hintPart}`;
  const availableForDesc = Math.max(0, columns - stringWidth(prefix) - stringWidth(connectorPart) - stringWidth(`${bullet} `) - badgeWidth - stringWidth(parenPart) - stringWidth(suffixPart));
  const truncated = wrapText(displayDescription, availableForDesc, "truncate-end");
  const badgeNode = <Text bold={true} backgroundColor={badgeColor} color={badgeColor ? "inverseText" : undefined}>{badgeLabel}</Text>;
  const leftText = <Text dimColor={dim} bold={isViewed}>{prefix}<Text dimColor>{connectorPart}</Text>{bullet}{" "}{badgeNode}<Text dimColor={false} bold={true}>{parenPart}</Text>{truncated}</Text>;
  const rightText = <Text dimColor={dim}> {sep} {elapsed}{toolText}{tokenText}{queuedCount > 0 && <Text color="warning">{queuedText}</Text>}{hintPart && <Text dimColor={true}>{hintPart}</Text>}</Text>;
  const line = <Box width={columns} justifyContent="space-between">{leftText}{rightText}</Box>;
  if (!onClick) {
    return line;
  }
  return <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>{line}</Box>;
}
