// useOnQuery is a React hook over the whole query loop, which no unit test can
// drive; the decisions live in cancelledTurn.ts and are tested there. What is
// pinned here, on the source, is that the hook asks them at the right points:
// a turn cancelled with Esc goes on yielding (the aborted tool_result, the
// interrupt marker) after onCancel has freed the guard, and the next prompt
// must land after those messages, not in front of them (660bb320,
// 2026-11-09: 138k rewritten, 7 thinking blocks dropped).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(import.meta.dir, 'useOnQuery.ts'), 'utf8')

function body(start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from + start.length)
  expect(to, `${end} not found after ${start}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('useOnQuery — a cancelled turn settles before the next prompt lands', () => {
  const onQuery = body('const onQuery = useCallback(', '}, [onQueryImpl,')
  const onQueryImpl = body('const onQueryImpl = useCallback(', 'const onQuery = useCallback(')

  test('the turn registers itself as soon as it owns the guard', () => {
    const start = onQuery.indexOf('queryGuard.tryStart()')
    const begin = onQuery.indexOf('cancelledTurns.begin(thisGeneration)')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(begin).toBeGreaterThan(start)
  })

  test('it waits for an older cancelled turn before appending the new messages', () => {
    const settle = onQuery.indexOf('await cancelledTurns.settle(thisGeneration)')
    const append = onQuery.indexOf('setMessages(oldMessages => [...oldMessages, ...newMessages])')
    expect(settle).toBeGreaterThanOrEqual(0)
    expect(append).toBeGreaterThan(settle)
  })

  test('the turn ends first thing in finally, whatever else it skips', () => {
    expect(onQuery).toMatch(/\} finally \{\s*(\/\/[^\n]*\n\s*)*cancelledTurns\.end\(thisGeneration\)/)
  })

  test('the query loop drops what an abandoned turn yields, and ends the turn once drained', () => {
    expect(onQueryImpl).toMatch(
      /if \(cancelledTurns\.isAbandoned\(generation\)\) continue;?\s*onQueryEvent\(event\)/,
    )
    const loopEnd = onQueryImpl.indexOf('onQueryEvent(event)')
    expect(onQueryImpl.indexOf('cancelledTurns.end(generation)')).toBeGreaterThan(loopEnd)
  })

  test('onQuery hands its generation to the loop', () => {
    expect(onQuery).toMatch(/await onQueryImpl\([^)]*thisGeneration\)/)
  })
})
