import { describe, expect, test } from 'bun:test';
import type { TaskState } from '../../tasks/types.js';
import { footerTreeBaseIndex, getVisibleAgentTasks } from './footerTaskGeometry.js';

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
