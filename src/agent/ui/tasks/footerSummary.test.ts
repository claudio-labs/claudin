import { describe, expect, test } from 'bun:test'
import type { TaskState } from 'src/agent/tasks/types.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import {
  buildFooterSummarySegments,
  formatSegmentCount,
} from 'src/agent/ui/tasks/footerSummary.js'

// Minimal fixtures — only the fields the summary reads.
function shell(id: string, kind?: 'bash' | 'monitor'): TaskState {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    command: id,
    kind,
    startTime: 1,
    isBackgrounded: true,
  } as unknown as TaskState
}

function agent(
  id: string,
  extra: { status?: string; error?: string; agentType?: string; evictAfter?: number } = {},
): TaskState {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: id,
    agentType: 'Plan',
    startTime: 1,
    isBackgrounded: true,
    ...extra,
  } as unknown as TaskState
}

function asRecord(...tasks: TaskState[]): AppState['tasks'] {
  return Object.fromEntries(tasks.map(t => [t.id, t])) as AppState['tasks']
}

describe('buildFooterSummarySegments', () => {
  test('emits nothing when there is no background work', () => {
    expect(buildFooterSummarySegments(asRecord(), undefined)).toEqual([])
    expect(buildFooterSummarySegments(undefined, undefined)).toEqual([])
  })

  test('a group with zero items produces no segment at all', () => {
    // The whole point of the collapsed line: only what exists gets an icon.
    const segments = buildFooterSummarySegments(asRecord(shell('s1')), undefined)
    expect(segments.map(s => s.key)).toEqual(['shells'])
  })

  test('orders segments the way the expanded view stacks them', () => {
    const segments = buildFooterSummarySegments(
      asRecord(shell('m1', 'monitor'), shell('s1', 'bash'), agent('a1')),
      undefined,
    )
    expect(segments.map(s => s.key)).toEqual(['agents', 'shells', 'monitors'])
  })

  test('counts match the expanded headers, monitors absorbing both kinds', () => {
    const segments = buildFooterSummarySegments(
      asRecord(
        shell('s1', 'bash'),
        shell('s2', 'bash'),
        shell('m1', 'monitor'),
        agent('a1'),
        agent('a2'),
      ),
      undefined,
    )
    expect(segments).toMatchObject([
      { key: 'agents', count: 2 },
      { key: 'shells', count: 2 },
      { key: 'monitors', count: 1 },
    ])
  })

  test('the foregrounded task is excluded, exactly as in the tree', () => {
    expect(buildFooterSummarySegments(asRecord(shell('s1')), 's1')).toEqual([])
  })

  test('finished agents still on screen are counted, and broken out', () => {
    // countVisibleAgentTasks keeps a terminal agent until its eviction
    // deadline, so `count` has to include it or the icon would disagree with
    // the `Agents (N)` header one row below.
    const segments = buildFooterSummarySegments(
      asRecord(agent('a1'), agent('a2', { status: 'completed' })),
      undefined,
    )
    expect(segments[0]).toMatchObject({ key: 'agents', count: 2, finished: 1 })
  })

  test('an evicted agent (evictAfter 0) is invisible to the summary', () => {
    expect(
      buildFooterSummarySegments(asRecord(agent('a1', { evictAfter: 0 })), undefined),
    ).toEqual([])
  })

  test('a completed shell leaves the footer instead of reporting as finished', () => {
    // isBackgroundTask drops anything not running/pending, so the group loses
    // the task outright — asserting `finished: 0` on a RUNNING shell would pass
    // even if the field were wired to the agent counter.
    const done = { ...shell('s1'), status: 'completed' } as unknown as TaskState
    const segments = buildFooterSummarySegments(
      asRecord(done, shell('s2')),
      undefined,
    )
    expect(segments).toMatchObject([{ key: 'shells', count: 1, finished: 0 }])
  })

  test('a healthy panel has no tone', () => {
    const segments = buildFooterSummarySegments(asRecord(agent('a1')), undefined)
    expect(segments[0]?.tone).toBeUndefined()
  })

  test('a failed agent tints the icon red, a killed one amber', () => {
    const failed = buildFooterSummarySegments(
      asRecord(agent('a1'), agent('a2', { status: 'failed' })),
      undefined,
    )
    expect(failed[0]?.tone).toBe('error')

    const killed = buildFooterSummarySegments(
      asRecord(agent('a1'), agent('a2', { status: 'killed' })),
      undefined,
    )
    expect(killed[0]?.tone).toBe('warning')
  })

  test('an error message tints even when the status has not flipped yet', () => {
    const segments = buildFooterSummarySegments(
      asRecord(agent('a1', { error: 'boom' })),
      undefined,
    )
    expect(segments[0]?.tone).toBe('error')
  })

  test('a failure outranks a kill', () => {
    const segments = buildFooterSummarySegments(
      asRecord(agent('a1', { status: 'killed' }), agent('a2', { status: 'failed' })),
      undefined,
    )
    expect(segments[0]?.tone).toBe('error')
  })

  test('only agents carry a tone — a shell group is never tinted', () => {
    const segments = buildFooterSummarySegments(
      asRecord(shell('s1'), agent('a1', { status: 'failed' })),
      undefined,
    )
    // Assert the shells segment EXISTS and is untinted; `?.tone` alone would
    // also pass if the group vanished entirely.
    const shells = segments.find(s => s.key === 'shells')
    expect(shells).toBeDefined()
    expect(shells?.tone).toBeUndefined()
    expect(segments.find(s => s.key === 'agents')?.tone).toBe('error')
  })
})

describe('formatSegmentCount', () => {
  test('prints the bare count when nothing has finished', () => {
    expect(formatSegmentCount({ key: 'shells', count: 2, finished: 0 })).toBe('(2)')
  })

  test('appends the finished count only when there is one', () => {
    expect(formatSegmentCount({ key: 'agents', count: 2, finished: 1 })).toBe('(2/1)')
  })

  test('a fully finished group still reports its total first', () => {
    expect(formatSegmentCount({ key: 'agents', count: 1, finished: 1 })).toBe('(1/1)')
  })
})
