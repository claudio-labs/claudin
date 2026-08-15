import { describe, expect, test } from 'bun:test'
import type { Task } from 'src/tasks/tasks.js'
import { orderTasksForDisplay } from 'src/components/tasks/taskOrdering.js'

function task(
  id: string,
  status: Task['status'],
  blockedBy: string[] = [],
): Task {
  return {
    id,
    subject: `task ${id}`,
    description: '',
    status,
    blocks: [],
    blockedBy,
  } as Task
}

const ids = (tasks: Task[]): string[] => tasks.map(t => t.id)

describe('orderTasksForDisplay', () => {
  test('sinks completed tasks below everything still open', () => {
    const out = orderTasksForDisplay([
      task('1', 'completed'),
      task('2', 'completed'),
      task('3', 'in_progress'),
      task('4', 'pending'),
    ])
    expect(ids(out)).toEqual(['3', '4', '1', '2'])
  })

  test('puts in_progress above pending', () => {
    const out = orderTasksForDisplay([
      task('1', 'pending'),
      task('2', 'in_progress'),
    ])
    expect(ids(out)).toEqual(['2', '1'])
  })

  test('sorts blocked pending tasks after unblocked ones', () => {
    const out = orderTasksForDisplay([
      task('1', 'pending', ['3']),
      task('2', 'pending'),
      task('3', 'pending'),
    ])
    expect(ids(out)).toEqual(['2', '3', '1'])
  })

  test('a task blocked only by completed work is not treated as blocked', () => {
    const out = orderTasksForDisplay([
      task('1', 'completed'),
      task('2', 'pending', ['1']),
      task('3', 'pending'),
    ])
    expect(ids(out)).toEqual(['2', '3', '1'])
  })

  test('sorts by id numerically inside a group', () => {
    const out = orderTasksForDisplay([
      task('10', 'pending'),
      task('9', 'pending'),
      task('2', 'pending'),
    ])
    expect(ids(out)).toEqual(['2', '9', '10'])
  })

  test('falls back to lexicographic order for non-numeric ids', () => {
    const out = orderTasksForDisplay([
      task('beta', 'pending'),
      task('alpha', 'pending'),
    ])
    expect(ids(out)).toEqual(['alpha', 'beta'])
  })

  test('leaves a list with nothing completed in id order', () => {
    const out = orderTasksForDisplay([
      task('3', 'pending'),
      task('1', 'pending'),
      task('2', 'pending'),
    ])
    expect(ids(out)).toEqual(['1', '2', '3'])
  })

  test('does not mutate the input array', () => {
    const input = [task('1', 'completed'), task('2', 'pending')]
    orderTasksForDisplay(input)
    expect(ids(input)).toEqual(['1', '2'])
  })

  test('handles an empty list', () => {
    expect(orderTasksForDisplay([])).toEqual([])
  })
})
