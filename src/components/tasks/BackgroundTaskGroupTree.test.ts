import { describe, expect, test } from 'bun:test';
import type { TaskState } from '../../tasks/types.js';
import { buildFooterTaskRows } from './BackgroundTaskGroupTree.js';
import { footerTreeBaseIndex } from './footerTaskGeometry.js';
import {
  countFooterTaskRows,
  resolveFooterTreeRow,
} from './footerSelection.js';

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

describe('footerTreeBaseIndex', () => {
  test('zero agents → tree starts at index 0', () => {
    expect(footerTreeBaseIndex(asRecord(shell('s1', 'a')))).toBe(0);
  });

  test('N agents → tree starts at N + 1 (main row + agent rows)', () => {
    expect(
      footerTreeBaseIndex(asRecord(agent('a1', 'one'), agent('a2', 'two'), shell('s1', 'a'))),
    ).toBe(3);
  });
});

describe('resolveFooterTreeRow', () => {
  const tasks = asRecord(
    agent('a1', 'panel agent'),
    shell('s1', 'first', 'bash'),
    shell('s2', 'second', 'bash'),
  );
  // Layout: index 0 = main, 1 = agent, 2 = shells header, 3 = first, 4 = second.

  test('returns undefined for cursor positions before the tree (main / agent)', () => {
    expect(resolveFooterTreeRow(tasks, undefined, [], 0)).toBeUndefined();
    expect(resolveFooterTreeRow(tasks, undefined, [], 1)).toBeUndefined();
  });

  test('returns the header at base index', () => {
    const row = resolveFooterTreeRow(tasks, undefined, [], 2);
    expect(row).toMatchObject({ kind: 'header', groupKey: 'shells', count: 2 });
  });

  test('returns the child items at the trailing indices', () => {
    expect(resolveFooterTreeRow(tasks, undefined, [], 3)).toMatchObject({ kind: 'item', isLast: false });
    expect(resolveFooterTreeRow(tasks, undefined, [], 4)).toMatchObject({ kind: 'item', isLast: true });
  });

  test('collapsed group hides items so out-of-range cursor returns undefined', () => {
    // Only header rendered; index 3 has no row.
    expect(resolveFooterTreeRow(tasks, undefined, ['shells'], 3)).toBeUndefined();
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
