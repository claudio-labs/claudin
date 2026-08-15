import { describe, expect, test } from 'bun:test';
import type { TaskState } from 'src/agent/tasks/types.js';
import {
  countVisibleAgentTasks,
  footerTreeBaseIndex,
  getAgentPanelRows,
  getVisibleAgentTasks,
} from 'src/agent/ui/tasks/footerTaskGeometry.js';

// Minimal panel-agent fixture: only the fields isPanelAgentTask and the row
// sort/visibility rules read. Cast through unknown so we don't have to satisfy
// every TaskStateBase field (mirrors BackgroundTaskGroupTree.test.ts).
function panelAgent(
  id: string,
  startTime: number,
  extra: Record<string, unknown> = {},
): TaskState {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: id,
    startTime,
    isBackgrounded: true,
    ...extra,
  } as unknown as TaskState;
}

function shell(id: string, startTime = 1): TaskState {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    command: 'noop',
    kind: 'bash',
    startTime,
    isBackgrounded: true,
  } as unknown as TaskState;
}

function asRecord(...tasks: TaskState[]): Record<string, TaskState> {
  return Object.fromEntries(tasks.map(t => [t.id, t]));
}

describe('getVisibleAgentTasks', () => {
  test('returns panel agents sorted by startTime (oldest first)', () => {
    const tasks = asRecord(
      panelAgent('a2', 200),
      panelAgent('a1', 100),
      panelAgent('a3', 300),
    );
    const result = getVisibleAgentTasks(tasks);
    expect(result.map(t => t.id)).toEqual(['a1', 'a2', 'a3']);
  });

  test('filters out non-agent tasks', () => {
    const tasks = asRecord(panelAgent('a1', 1), shell('s1'));
    const result = getVisibleAgentTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('a1');
  });

  test('filters out evicted agents (evictAfter === 0)', () => {
    // evictAfter === 0 is the immediate-dismiss flag set by the x key in the
    // panel. The row should disappear at the next render even if AppState
    // still holds the task entry while terminal-task eviction completes.
    const tasks = asRecord(
      panelAgent('a1', 1),
      panelAgent('a2', 2, { evictAfter: 0 }),
    );
    const result = getVisibleAgentTasks(tasks);
    expect(result.map(t => t.id)).toEqual(['a1']);
  });

  test('returns [] when there are no agents', () => {
    expect(getVisibleAgentTasks(asRecord(shell('s1')))).toEqual([]);
    expect(getVisibleAgentTasks({})).toEqual([]);
  });
});

describe('getAgentPanelRows — nesting', () => {
  // A sub-agent spawned BY another agent registers in the same root store at
  // any nesting depth, so without the parent link it rendered as a sibling of
  // main's own agents — `Agents (4)` next to a `Running 3 agents…` block.
  test('places a child right after its parent, indented', () => {
    const tasks = asRecord(
      panelAgent('a1', 100),
      panelAgent('a2', 200),
      panelAgent('child-of-a1', 300, { parentAgentId: 'a1' }),
    );
    const rows = getAgentPanelRows(tasks);
    expect(rows.map(r => r.task.id)).toEqual(['a1', 'child-of-a1', 'a2']);
    expect(rows.map(r => r.depth)).toEqual([0, 1, 0]);
    expect(rows.map(r => r.connector)).toEqual(['├─', '│  └─', '└─']);
  });

  test('a grandchild carries its ancestors guides', () => {
    const tasks = asRecord(
      panelAgent('a1', 100),
      panelAgent('kid', 200, { parentAgentId: 'a1' }),
      panelAgent('grandkid', 300, { parentAgentId: 'kid' }),
    );
    const rows = getAgentPanelRows(tasks);
    expect(rows.map(r => r.task.id)).toEqual(['a1', 'kid', 'grandkid']);
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2]);
    // a1 is the last root and kid its last child, so both guides are blank.
    expect(rows.map(r => r.connector)).toEqual(['└─', '   └─', '      └─']);
  });

  test('siblings under one parent keep the guide line until the last', () => {
    const tasks = asRecord(
      panelAgent('a1', 100),
      panelAgent('a2', 150),
      panelAgent('kid1', 200, { parentAgentId: 'a1' }),
      panelAgent('kid2', 250, { parentAgentId: 'a1' }),
    );
    const rows = getAgentPanelRows(tasks);
    expect(rows.map(r => r.task.id)).toEqual(['a1', 'kid1', 'kid2', 'a2']);
    expect(rows.map(r => r.connector)).toEqual(['├─', '│  ├─', '│  └─', '└─']);
  });

  test('an evicted or absent parent leaves the child at the root', () => {
    // The parent finished and its row is gone; the child is still running and
    // must stay visible (and selectable) rather than vanish with its parent.
    const tasks = asRecord(
      panelAgent('gone', 100, { evictAfter: 0 }),
      panelAgent('orphan', 200, { parentAgentId: 'gone' }),
      panelAgent('unknown-parent', 300, { parentAgentId: 'never-existed' }),
    );
    const rows = getAgentPanelRows(tasks);
    expect(rows.map(r => r.task.id)).toEqual(['orphan', 'unknown-parent']);
    expect(rows.map(r => r.depth)).toEqual([0, 0]);
  });

  test('a parent link that does not go back in time is ignored', () => {
    // Guards the walk against a cycle: parent edges may only point at an
    // earlier-started agent, so every task is reachable from some root and
    // gets exactly one row.
    const tasks = asRecord(
      panelAgent('a', 100, { parentAgentId: 'b' }),
      panelAgent('b', 200, { parentAgentId: 'a' }),
      panelAgent('self', 300, { parentAgentId: 'self' }),
    );
    const rows = getAgentPanelRows(tasks);
    expect(rows.map(r => r.task.id)).toEqual(['a', 'b', 'self']);
    expect(rows.map(r => r.depth)).toEqual([0, 1, 0]);
  });

  test('nesting never changes the row count', () => {
    // countVisibleAgentTasks skips the tree build to stay cheap in the footer
    // selector — it must keep agreeing with the rows the panel renders, or the
    // cursor bounds drift away from what is on screen.
    const tasks = asRecord(
      panelAgent('a1', 100),
      panelAgent('kid', 200, { parentAgentId: 'a1' }),
      panelAgent('grandkid', 300, { parentAgentId: 'kid' }),
      panelAgent('a2', 400),
      panelAgent('hidden', 500, { evictAfter: 0 }),
      shell('s1'),
    );
    expect(countVisibleAgentTasks(tasks)).toBe(4);
    expect(getAgentPanelRows(tasks)).toHaveLength(4);
    expect(footerTreeBaseIndex(tasks)).toBe(5);
  });
});

describe('footerTreeBaseIndex', () => {
  // BackgroundTaskGroupTree.test.ts already covers the agents=0 and agents=N
  // cases for the tree-base offset. These tests pin the off-by-one *boundary*
  // — the formula is base === A===0 ? 0 : A+1, so the seam at A=1 (where the
  // ● main row first appears) is the easiest place to silently regress.
  test('one agent → tree starts at index 2 (pill + main + agent → tree)', () => {
    expect(footerTreeBaseIndex(asRecord(panelAgent('a1', 1)))).toBe(2);
  });

  test('evicted agents do not contribute to the offset', () => {
    // A=1 visible + 1 evicted should still report base=2, not 3 — eviction
    // is the only way the cursor stays put when the panel shrinks.
    const tasks = asRecord(
      panelAgent('a1', 1),
      panelAgent('a2', 2, { evictAfter: 0 }),
    );
    expect(footerTreeBaseIndex(tasks)).toBe(2);
  });
});
