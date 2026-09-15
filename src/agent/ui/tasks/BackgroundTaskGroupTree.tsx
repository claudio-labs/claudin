import figures from 'figures';
import { useEffect, useMemo } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/agent/tasks/types.js';
import { useAppState, useSetAppState } from 'src/terminal/state/AppState.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { truncate } from 'src/shared/text/format.js';
import { FOOTER_GROUP_LABELS, FOOTER_GROUP_ORDER, type FooterGroupKey, getFooterPanelLayout, matchGroupKey, MCP_BUCKET_LABELS, MCP_BUCKET_ORDER, mcpBucketCollapseKey } from 'src/agent/ui/tasks/footerTaskGeometry.js';
import { isMcpServerTask, mcpTaskStatusInput, type McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js';
import { mcpBucket, type McpBucket } from 'src/mcp/serverStatus.js';
import { mcpRowBody, mcpRowGlyph, mcpRowTone, type McpRowTone } from 'src/agent/ui/tasks/mcpRowLabel.js';
import { taskRowLabel } from 'src/agent/ui/tasks/taskRowLabel.js';

// Groups with >4 items start collapsed so the footer stays compact; the user can
// expand with Enter on the header.
const AUTO_COLLAPSE_THRESHOLD = 4;

// Render order and labels come from footerTaskGeometry, and group membership
// from its matchGroupKey. This file used to carry its own `match` predicates,
// which meant the row COUNT (countFooterTaskRows) partitioned the same tasks
// with a second, independent implementation and could silently disagree with
// the rows painted here.
//
// The agents group is skipped: local_agent tasks render in the full-width agent
// panel (CoordinatorTaskPanel: an `Agents (N)` label + per-agent metric lines)
// above the byline, not as a bare group here. Keeping them out also keeps the unified
// footer cursor (coordinatorTaskIndex) single — agents are the panel's rows,
// and tree rows come after them in the same index space.
const TREE_GROUPS: readonly FooterGroupKey[] = FOOTER_GROUP_ORDER.filter(key => key !== 'agents');

// One nesting level, two columns per step — enough to read as a tree without
// eating the label width a narrow terminal has left.
const INDENT = '  ';

export type FooterTaskRow =
  | {
      kind: 'header';
      groupKey: FooterGroupKey;
      /** What Enter toggles in AppState.collapsedTaskGroups — the group's own
       * key for a top-level header, a namespaced one for a sub-group. Callers
       * read this rather than `groupKey`, which a sub-header shares with its
       * parent. */
      collapseKey: string;
      /** 0 = the group's own header, 1 = a sub-group inside it. */
      depth: 0 | 1;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | {
      kind: 'item';
      task: BackgroundTaskState;
      label: string;
      isLast: boolean;
      depth: 0 | 1;
      /** A coloured prefix painted as a NESTED <Text> before the label. Not a
       * sibling: siblings in a row Box wrap as independent columns
       * (.claudin/rules/ink-tui.md §10). */
      accent?: { text: string; color: McpRowTone };
    };

/**
 * The MCP group is the only one that nests: its servers are partitioned again
 * by connection state, each bucket with its own header and its own collapse, so
 * "what is down" reads at a glance instead of having to be spotted among the
 * healthy rows.
 */
function pushMcpRows(
  rows: FooterTaskRow[],
  items: readonly BackgroundTaskState[],
  collapsed: ReadonlySet<string>,
): void {
  const byBucket = new Map<McpBucket, McpServerTaskState[]>();
  for (const task of items) {
    if (!isMcpServerTask(task)) continue;
    const bucket = mcpBucket(mcpTaskStatusInput(task));
    const list = byBucket.get(bucket);
    if (list) list.push(task);
    else byBucket.set(bucket, [task]);
  }
  for (const bucket of MCP_BUCKET_ORDER) {
    const list = byBucket.get(bucket);
    if (!list || list.length === 0) continue;
    const collapseKey = mcpBucketCollapseKey(bucket);
    const isCollapsed = collapsed.has(collapseKey);
    rows.push({
      kind: 'header',
      groupKey: 'mcp',
      collapseKey,
      depth: 1,
      label: MCP_BUCKET_LABELS[bucket],
      count: list.length,
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;
    list.forEach((task, i) =>
      rows.push({
        kind: 'item',
        task,
        label: mcpRowBody(task),
        isLast: i === list.length - 1,
        depth: 1,
        accent: { text: mcpRowGlyph(task), color: mcpRowTone(task) },
      }),
    );
  }
}

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
  for (const groupKey of TREE_GROUPS) {
    const items = sorted.filter(task => matchGroupKey(task) === groupKey);
    if (items.length === 0) continue;
    groupCounts.set(groupKey, items.length);
    const isCollapsed = collapsed.has(groupKey);
    rows.push({ kind: 'header', groupKey, collapseKey: groupKey, depth: 0, label: FOOTER_GROUP_LABELS[groupKey], count: items.length, collapsed: isCollapsed });
    if (isCollapsed) continue;
    if (groupKey === 'mcp') {
      pushMcpRows(rows, items, collapsed);
      continue;
    }
    items.forEach((task, i) =>
      rows.push({ kind: 'item', task, label: taskRowLabel(task), isLast: i === items.length - 1, depth: 0 }),
    );
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
  // index — treeBase (after the summary + agents) + i — and the tasks pill is
  // focused.
  const coordinatorTaskIndex = useAppState((s: AppState) => s.coordinatorTaskIndex);
  const tasksFocused = useAppState((s: AppState) => s.footerSelection === 'tasks');
  // treeBase = the summary header + the agent rows the cursor must skip before
  // it lands on the first tree row.
  const treeBase = useAppState((s: AppState) => getFooterPanelLayout(s.tasks).treeBase);
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
        const indent = row.depth === 1 ? INDENT : '';
        if (row.kind === 'header') {
          const chevron = row.collapsed ? figures.triangleRight : figures.triangleDown;
          return (
            // Keyed on collapseKey, not groupKey: a group's sub-headers share
            // its groupKey, so keying on that collides four ways under `mcp`.
            <Box key={`h-${row.collapseKey}`} flexDirection="row">
              <Text dimColor>{pointer}{indent}</Text>
              <Text dimColor>{chevron} </Text>
              <Text bold color={isSelected ? 'suggestion' : undefined}>
                {row.label}
              </Text>
              <Text dimColor> ({row.count})</Text>
            </Box>
          );
        }
        const running = row.task.status === 'running';
        // The accent is painted inside the label's own <Text>, so it spends
        // from the same width budget: its glyph plus the space after it.
        const accentWidth = row.accent ? row.accent.text.length + 1 : 0;
        const label = truncate(row.label, Math.max(8, labelWidth - indent.length - accentWidth), true);
        const connector = row.isLast ? '└─' : '├─';
        return (
          <Box key={`i-${row.task.id}`} flexDirection="row">
            <Text dimColor>{pointer}{indent}</Text>
            <Text dimColor>{connector} </Text>
            <Text dimColor={!running} color={isSelected ? 'suggestion' : undefined}>
              {row.accent ? <Text color={row.accent.color}>{row.accent.text} </Text> : null}
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
