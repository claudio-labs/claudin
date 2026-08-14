import figures from 'figures';
import { useEffect, useMemo } from 'react';
import { Box, Text } from 'src/ink.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import type { AppState } from 'src/state/AppStateStore.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { truncate } from 'src/utils/format.js';
import { footerTreeBaseIndex } from './footerTaskGeometry.js';

// Groups with >4 items start collapsed so the footer stays compact; the user can
// expand with Enter on the header.
const AUTO_COLLAPSE_THRESHOLD = 4;

// Group order is the top-to-bottom render order AND the cursor navigation order.
type GroupDef = {
  key: string;
  label: string;
  match: (task: BackgroundTaskState) => boolean;
};
// NOTE: local_agent tasks are intentionally absent — they render in the
// full-width agent panel (CoordinatorTaskPanel: `● main` + per-agent metric
// lines) above the byline, not as a bare group here. Keeping them out also
// keeps the unified footer cursor (coordinatorTaskIndex) single — agents are
// the panel's rows, tree rows come after them in the same index space.
const GROUP_ORDER: GroupDef[] = [
  { key: 'shells', label: 'Shells', match: t => t.type === 'local_bash' && t.kind !== 'monitor' },
  {
    key: 'monitors',
    label: 'Monitors',
    match: t => (t.type === 'local_bash' && t.kind === 'monitor') || t.type === 'monitor_mcp',
  },
  { key: 'remote', label: 'Remote', match: t => t.type === 'remote_agent' },
  { key: 'workflows', label: 'Workflows', match: t => t.type === 'local_workflow' },
  { key: 'dreams', label: 'Dreams', match: t => t.type === 'dream' },
];

// Short, single-line label per task — mirrors toListItem() in BackgroundTasksDialog.
function labelFor(task: BackgroundTaskState): string {
  switch (task.type) {
    case 'local_bash':
      return task.kind === 'monitor' ? task.description : task.command;
    case 'remote_agent':
      return task.title;
    case 'local_agent':
      return task.description;
    case 'local_workflow':
      return task.summary ?? task.description;
    case 'monitor_mcp':
      return task.description;
    case 'dream':
      return task.description;
    case 'in_process_teammate':
      return `@${task.identity.agentName}`;
    default:
      return '';
  }
}

export type FooterTaskRow =
  | { kind: 'header'; groupKey: string; label: string; count: number; collapsed: boolean }
  | { kind: 'item'; task: BackgroundTaskState; label: string; isLast: boolean };

/**
 * Pure builder: partitions non-teammate background tasks into typed groups and
 * flattens them into the ordered list of selectable rows. The flat order is the
 * navigation order — both the renderer and useBackgroundTaskNavigation consume
 * this so the footer cursor maps 1:1 to what's painted.
 *
 * Every non-empty group renders a header (Enter toggles collapse) + child rows
 * (├─/└─). We don't special-case singletons: the pill (BackgroundTaskStatus)
 * already summarizes the singleton case ("1 shell"); collapsing tree rows
 * under the matching header keeps the pill→tree relationship unambiguous and
 * avoids the double-display where the pill and a bare tree row showed the
 * same task twice.
 */
export function buildFooterTaskRows(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
  collapsed: ReadonlySet<string>,
): { rows: FooterTaskRow[]; groupCounts: Map<string, number> } {
  // Mirrors BackgroundTasksDialog: every background task except teammates (their
  // own tree) and the foregrounded task (shown in the main UI, not the footer).
  const base = Object.values(tasks ?? {}).filter(
    (t): t is BackgroundTaskState =>
      isBackgroundTask(t) && t.type !== 'in_process_teammate' && t.id !== foregroundedTaskId,
  );

  const sorted = [...base].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return b.startTime - a.startTime;
  });

  const rows: FooterTaskRow[] = [];
  const groupCounts = new Map<string, number>();
  for (const group of GROUP_ORDER) {
    const items = sorted.filter(group.match);
    if (items.length === 0) continue;
    groupCounts.set(group.key, items.length);
    const isCollapsed = collapsed.has(group.key);
    rows.push({ kind: 'header', groupKey: group.key, label: group.label, count: items.length, collapsed: isCollapsed });
    if (!isCollapsed) {
      items.forEach((task, i) =>
        rows.push({ kind: 'item', task, label: labelFor(task), isLast: i === items.length - 1 }),
      );
    }
  }
  return { rows, groupCounts };
}

export function BackgroundTaskGroupTree(): React.ReactNode {
  const tasks = useAppState((s: AppState) => s.tasks);
  const foregroundedTaskId = useAppState((s: AppState) => s.foregroundedTaskId);
  const collapsedTaskGroups = useAppState((s: AppState) => s.collapsedTaskGroups);
  // Auto-collapse seed memory lives in AppState (not a useRef) so a tree
  // unmount/remount — e.g. when a fullscreen dialog opens then closes — does
  // not re-collapse a group the user has since expanded.
  const seededTaskGroups = useAppState((s: AppState) => s.seededTaskGroups);
  // The footer cursor lives in coordinatorTaskIndex (shared with the agent
  // panel). A tree row i is highlighted when the cursor lands on its global
  // index — treeBase (after main + agents) + i — and the tasks pill is focused.
  const coordinatorTaskIndex = useAppState((s: AppState) => s.coordinatorTaskIndex);
  const tasksFocused = useAppState((s: AppState) => s.footerSelection === 'tasks');
  // treeBase = the agent partition size (main + agent rows) the cursor must
  // skip before it lands on the first tree row.
  const treeBase = useAppState((s: AppState) => footerTreeBaseIndex(s.tasks));
  const setAppState = useSetAppState();
  const { columns } = useTerminalSize();

  const collapsedSet = useMemo(() => new Set<string>(collapsedTaskGroups), [collapsedTaskGroups]);
  const { rows, groupCounts } = useMemo(
    () => buildFooterTaskRows(tasks as Record<string, TaskState> | undefined, foregroundedTaskId, collapsedSet),
    [tasks, foregroundedTaskId, collapsedSet],
  );

  // Auto-collapse a group the first time it appears with >4 items. Seeding is
  // recorded in AppState (seededTaskGroups) so a remount doesn't re-collapse a
  // group the user has since expanded — the seeded mark survives, but the
  // collapse itself is the user's to keep or undo.
  //
  // The effect is keyed on a serialized digest of groupCounts (not the Map
  // identity, which changes every panel tick / progress update) so it only
  // re-runs when group sizes actually change.
  const seededSet = useMemo(() => new Set(seededTaskGroups), [seededTaskGroups]);
  const groupCountsKey = useMemo(
    () => Array.from(groupCounts.entries()).map(([k, n]) => `${k}:${n}`).sort().join('|'),
    [groupCounts],
  );
  useEffect(() => {
    const toSeed: string[] = [];
    for (const [key, n] of groupCounts) {
      if (n > AUTO_COLLAPSE_THRESHOLD && !seededSet.has(key)) {
        toSeed.push(key);
      }
    }
    if (toSeed.length === 0) return;
    setAppState(prev => {
      const nextCollapsed = new Set(prev.collapsedTaskGroups);
      const nextSeeded = new Set(prev.seededTaskGroups);
      for (const k of toSeed) {
        nextCollapsed.add(k);
        nextSeeded.add(k);
      }
      return { ...prev, collapsedTaskGroups: [...nextCollapsed], seededTaskGroups: [...nextSeeded] };
    });
    // groupCounts is intentionally read inside but excluded from deps — the
    // digest key above subsumes its content. seededSet is also excluded for
    // the same reason (seededTaskGroups identity drives it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupCountsKey, setAppState]);

  if (rows.length === 0) return null;

  // Prefix budget: pointer(2) + chevron-or-connector(2) + space(1) + " (N)"
  // suffix on headers up to ~5 chars. Reserve 12 so the longest realistic
  // suffix ("(99)") on a header at narrow columns still fits without overflow.
  const labelWidth = Math.max(12, columns - 12);

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const isSelected = tasksFocused && coordinatorTaskIndex === treeBase + i;
        const pointer = isSelected ? `${figures.pointer} ` : '  ';
        if (row.kind === 'header') {
          const chevron = row.collapsed ? figures.triangleRight : figures.triangleDown;
          return (
            <Box key={`h-${row.groupKey}`} flexDirection="row">
              <Text dimColor>{pointer}</Text>
              <Text dimColor>{chevron} </Text>
              <Text bold color={isSelected ? 'suggestion' : undefined}>
                {row.label}
              </Text>
              <Text dimColor> ({row.count})</Text>
            </Box>
          );
        }
        const running = row.task.status === 'running';
        const label = truncate(row.label, labelWidth, true);
        const connector = row.isLast ? '└─' : '├─';
        return (
          <Box key={`i-${row.task.id}`} flexDirection="row">
            <Text dimColor>{pointer}</Text>
            <Text dimColor>{connector} </Text>
            <Text dimColor={!running} color={isSelected ? 'suggestion' : undefined}>
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
