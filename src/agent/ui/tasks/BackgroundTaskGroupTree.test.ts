import { describe, expect, test } from 'bun:test';
import type { TaskState } from 'src/agent/tasks/types.js';
import { buildFooterTaskRows } from 'src/agent/ui/tasks/BackgroundTaskGroupTree.js';
import {
  countFooterTaskRows,
  getFooterPanelLayout,
} from 'src/agent/ui/tasks/footerTaskGeometry.js';
import { resolveFooterTreeRow } from 'src/agent/ui/tasks/footerSelection.js';

// Minimal fixtures — only the fields buildFooterTaskRows reads. Cast through
// unknown so we don't have to satisfy every TaskStateBase field.
function shell(id: string, command: string, kind?: 'bash' | 'monitor', startTime = 1): TaskState {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    command,
    kind,
    startTime,
    isBackgrounded: true,
  } as unknown as TaskState;
}
function agent(id: string, description: string, startTime = 1): TaskState {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description,
    startTime,
    isBackgrounded: true,
  } as unknown as TaskState;
}
function monitorMcp(id: string, description: string, startTime = 1): TaskState {
  return {
    id,
    type: 'monitor_mcp',
    status: 'running',
    description,
    startTime,
  } as unknown as TaskState;
}

function asRecord(...tasks: TaskState[]): Record<string, TaskState> {
  return Object.fromEntries(tasks.map(t => [t.id, t]));
}

describe('buildFooterTaskRows', () => {
  test('a single task still renders a header + child — the pill already covers the singleton case', () => {
    // Avoids the double-display where pill ("1 shell") + a bare bullet showed
    // the same task twice. Header is the single source of truth in the tree.
    const { rows } = buildFooterTaskRows(asRecord(shell('s1', 'echo hi')), undefined, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'header', groupKey: 'shells', count: 1 });
    expect(rows[1]).toMatchObject({ kind: 'item', label: 'echo hi', isLast: true });
  });

  test('two+ tasks of a type render a header followed by children', () => {
    const { rows } = buildFooterTaskRows(
      asRecord(shell('s1', 'a'), shell('s2', 'b')),
      undefined,
      new Set(),
    );
    expect(rows[0]).toMatchObject({ kind: 'header', groupKey: 'shells', count: 2 });
    expect(rows.slice(1)).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'item', isLast: false });
    expect(rows[2]).toMatchObject({ kind: 'item', isLast: true });
  });

  test('collapsed group emits only its header', () => {
    const { rows } = buildFooterTaskRows(
      asRecord(shell('s1', 'a'), shell('s2', 'b')),
      undefined,
      new Set(['shells']),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'header', collapsed: true });
  });

  test('monitor shells and monitor_mcp merge into the Monitors group', () => {
    const { groupCounts } = buildFooterTaskRows(
      asRecord(shell('m1', 'tail -f', 'monitor'), monitorMcp('m2', 'watch logs')),
      undefined,
      new Set(),
    );
    expect(groupCounts.get('monitors')).toBe(2);
    expect(groupCounts.get('shells')).toBeUndefined();
  });

  test('shells (non-monitor) stay separate from monitors', () => {
    const { groupCounts } = buildFooterTaskRows(
      asRecord(shell('s1', 'run', 'bash'), shell('m1', 'tail', 'monitor')),
      undefined,
      new Set(),
    );
    expect(groupCounts.get('shells')).toBe(1);
    expect(groupCounts.get('monitors')).toBe(1);
  });

  test('local_agent tasks are excluded — they render in the full-width agent panel', () => {
    const { rows, groupCounts } = buildFooterTaskRows(
      asRecord(shell('s1', 'sh'), agent('a1', 'do thing'), agent('a2', 'other')),
      undefined,
      new Set(),
    );
    // Only the shells group survives (header + 1 item); agents are absent from
    // the tree entirely — they appear in the CoordinatorTaskPanel above.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'header', groupKey: 'shells' });
    expect(rows[1]).toMatchObject({ kind: 'item', label: 'sh' });
    expect(groupCounts.get('agents')).toBeUndefined();
  });

  test('the foregrounded task is excluded', () => {
    const { rows } = buildFooterTaskRows(asRecord(shell('s1', 'echo hi')), 's1', new Set());
    expect(rows).toHaveLength(0);
  });

  test('running tasks sort before non-running, then by recency', () => {
    const older = shell('s1', 'older', 'bash', 10);
    const newer = shell('s2', 'newer', 'bash', 20);
    const { rows } = buildFooterTaskRows(asRecord(older, newer), undefined, new Set());
    // header + 2 children; newer (higher startTime) first.
    expect(rows[1]).toMatchObject({ label: 'newer' });
    expect(rows[2]).toMatchObject({ label: 'older' });
  });
});

describe('getFooterPanelLayout', () => {
  test('zero agents → only the summary header precedes the tree', () => {
    const layout = getFooterPanelLayout(asRecord(shell('s1', 'a')));
    expect(layout).toMatchObject({
      summaryIndex: 0,
      mainIndex: -1,
      agentStart: -1,
      agentCount: 0,
      treeBase: 1,
    });
  });

  test('N agents → summary, main, N agent rows, then the tree', () => {
    const layout = getFooterPanelLayout(
      asRecord(agent('a1', 'one'), agent('a2', 'two'), shell('s1', 'a')),
    );
    expect(layout).toMatchObject({
      summaryIndex: 0,
      mainIndex: 1,
      agentStart: 2,
      agentCount: 2,
      treeBase: 4,
    });
  });

  test('the agent rows exactly fill the gap between main and the tree', () => {
    // agentStart + agentCount === treeBase is the invariant the footer cursor
    // depends on: no gap, no overlap, so every index maps to one painted row.
    const layout = getFooterPanelLayout(asRecord(agent('a1', 'one'), shell('s1', 'a')));
    expect(layout.agentStart + layout.agentCount).toBe(layout.treeBase);
  });
});

describe('resolveFooterTreeRow', () => {
  const tasks = asRecord(
    agent('a1', 'panel agent'),
    shell('s1', 'first', 'bash'),
    shell('s2', 'second', 'bash'),
  );
  // Layout: 0 = summary, 1 = main, 2 = agent, 3 = shells header, 4 = first,
  // 5 = second.

  test('returns undefined for cursor positions before the tree (summary / main / agent)', () => {
    expect(resolveFooterTreeRow(tasks, undefined, [], 0)).toBeUndefined();
    expect(resolveFooterTreeRow(tasks, undefined, [], 1)).toBeUndefined();
    expect(resolveFooterTreeRow(tasks, undefined, [], 2)).toBeUndefined();
  });

  test('returns the header at base index', () => {
    const row = resolveFooterTreeRow(tasks, undefined, [], 3);
    expect(row).toMatchObject({ kind: 'header', groupKey: 'shells', count: 2 });
  });

  test('returns the child items at the trailing indices', () => {
    expect(resolveFooterTreeRow(tasks, undefined, [], 4)).toMatchObject({ kind: 'item', isLast: false });
    expect(resolveFooterTreeRow(tasks, undefined, [], 5)).toMatchObject({ kind: 'item', isLast: true });
  });

  test('collapsed group hides items so out-of-range cursor returns undefined', () => {
    // Only the header is rendered; index 4 has no row.
    expect(resolveFooterTreeRow(tasks, undefined, ['shells'], 4)).toBeUndefined();
  });

  test('with no agents the tree starts right after the summary header', () => {
    // The shift this change introduced: treeBase went 0 -> 1 because the
    // summary occupies index 0 even when there is no agent partition. Index 0
    // must resolve to no tree row, and the header must sit at 1.
    const shellsOnly = asRecord(shell('s1', 'only', 'bash'));
    expect(resolveFooterTreeRow(shellsOnly, undefined, [], 0)).toBeUndefined();
    expect(resolveFooterTreeRow(shellsOnly, undefined, [], 1)).toMatchObject({
      kind: 'header',
      groupKey: 'shells',
    });
    expect(resolveFooterTreeRow(shellsOnly, undefined, [], 2)).toMatchObject({
      kind: 'item',
      label: 'only',
    });
  });
});

describe('countFooterTaskRows', () => {
  test('counts header + children for expanded groups, header-only for collapsed', () => {
    const tasks = asRecord(
      shell('s1', 'a', 'bash'),
      shell('s2', 'b', 'bash'),
      monitorMcp('m1', 'mon'),
    );
    // Expanded: shells header(1) + 2 items + monitors header(1) + 1 item = 5.
    expect(countFooterTaskRows(tasks, undefined, [])).toBe(5);
    // Collapse shells: shells header(1) + monitors header(1) + 1 item = 3.
    expect(countFooterTaskRows(tasks, undefined, ['shells'])).toBe(3);
  });

  test('excludes the foregrounded task and agents (agents live in the panel)', () => {
    const tasks = asRecord(agent('a1', 'panel'), shell('s1', 'sh'));
    // 1 shell → header + 1 item = 2; agent not counted.
    expect(countFooterTaskRows(tasks, undefined, [])).toBe(2);
    // Foregrounded shell vanishes → 0 rows.
    expect(countFooterTaskRows(tasks, 's1', [])).toBe(0);
  });
});
