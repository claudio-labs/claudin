import { describe, expect, test } from 'bun:test'
import {
  buildSessionRows,
  describeRunningWork,
  filterSessionRows,
  layoutSessionLines,
  scrollStartFor,
  type SessionRowsInput,
} from 'src/sessions/ui/sessionRows.js'
import type { LogOption } from 'src/shared/types/logs.js'

const NOW = new Date('2026-09-27T12:00:00Z')

function log(sessionId: string, minutesAgo: number, extra: Partial<LogOption> = {}): LogOption {
  const modified = new Date(NOW.getTime() - minutesAgo * 60_000)
  return {
    date: modified.toISOString(),
    messages: [],
    value: 0,
    created: modified,
    modified,
    firstPrompt: `prompt of ${sessionId}`,
    messageCount: 0,
    isSidechain: false,
    isLite: false,
    sessionId,
    projectPath: '/repo',
    ...extra,
  }
}

function input(overrides: Partial<SessionRowsInput>): SessionRowsInput {
  return {
    logs: [],
    currentSessionId: 'cur',
    instanceSessionIds: ['cur'],
    liveElsewhere: [],
    current: IDLE,
    cwd: '/repo',
    now: NOW,
    ...overrides,
  }
}

const IDLE = { turnActive: false, runningAgents: 0, costUSD: 0 }

describe('buildSessionRows', () => {
  test('orders current, open here (visit order), elsewhere, then inactive by recency', () => {
    const rows = buildSessionRows(
      input({
        logs: [
          log('old', 3000),
          log('recent', 5),
          log('visited-first', 60),
          log('visited-last', 600),
          log('held', 1),
          log('cur', 2),
        ],
        instanceSessionIds: ['cur', 'visited-last', 'visited-first'],
        liveElsewhere: [{ sessionId: 'held', pid: 42, cwd: '/other' }],
      }),
    )
    expect(rows.map(r => [r.sessionId, r.status])).toEqual([
      ['cur', 'current'],
      ['visited-last', 'open'],
      ['visited-first', 'open'],
      ['held', 'elsewhere'],
      ['recent', 'inactive'],
      ['old', 'inactive'],
    ])
    expect(rows.find(r => r.sessionId === 'held')?.holder).toEqual({ pid: 42, cwd: '/other' })
  })

  test('a session visited here but now held by another claudin reads as elsewhere', () => {
    const rows = buildSessionRows(
      input({
        logs: [log('cur', 1), log('left', 5)],
        instanceSessionIds: ['cur', 'left'],
        liveElsewhere: [
          { sessionId: 'left', pid: 7, cwd: '/repo' },
          { sessionId: 'cur', pid: 8, cwd: '/repo' },
        ],
      }),
    )
    expect(rows.map(r => r.status)).toEqual(['current', 'elsewhere'])
  })

  test('title prefers /rename and ai-title over the first prompt, on one line', () => {
    const rows = buildSessionRows(
      input({
        logs: [
          log('a', 1, { customTitle: 'Fix pihole auth bugs' }),
          log('b', 2, { firstPrompt: 'faz checkout\nda main' }),
        ],
      }),
    )
    expect(rows.map(r => r.title)).toEqual(['(new session)', 'Fix pihole auth bugs', 'faz checkout da main'])
  })

  test('columns: where and branch, context tokens, cost, when', () => {
    const rows = buildSessionRows(
      input({
        logs: [
          log('cur', 0, { contextTokens: 1_000, gitBranch: 'main', costUSD: 1 }),
          log('wt', 90, { contextTokens: 184_200, gitBranch: 'feat/x', projectPath: '/repo/.claudin/worktrees/x', costUSD: 22.456 }),
          log('bare', 60 * 24 * 2),
        ],
        current: { ...IDLE, contextTokens: 84_000, costUSD: 3.5, title: 'Redesign the resume screen' },
      }),
    )
    const [cur, wt, bare] = rows
    // The current session's live cost wins over its last stamp.
    expect(cur).toMatchObject({ title: 'Redesign the resume screen', where: 'repo', branch: 'main', tokens: '84k', cost: '$3.50', when: '0s ago' })
    expect(wt).toMatchObject({ where: 'x', branch: 'feat/x', tokens: '184.2k', cost: '$22.46', when: '1h ago' })
    // No cost recorded reads as zero, not blank.
    expect(bare).toMatchObject({ where: 'repo', branch: '', tokens: '', cost: '$0.00', when: '2d ago' })
  })

  test('agents and the running dot come from a live process only; the rest read 0', () => {
    const rows = buildSessionRows(
      input({
        logs: [log('cur', 0), log('held', 1), log('idle-held', 2), log('old', 3)],
        current: { turnActive: true, runningAgents: 0, costUSD: 0 },
        liveElsewhere: [
          { sessionId: 'held', pid: 7, cwd: '/repo', turnActive: false, runningAgents: 2, costUSD: 4 },
          { sessionId: 'idle-held', pid: 8, cwd: '/repo' },
        ],
      }),
    )
    expect(rows.map(r => [r.sessionId, r.agents, r.running, r.cost])).toEqual([
      ['cur', '0', true, '$0.00'],
      ['held', '2', true, '$4.00'],
      ['idle-held', '0', false, '$0.00'],
      ['old', '0', false, '$0.00'],
    ])
  })

  test('a session another instance let go keeps the cost last seen live', () => {
    const rows = buildSessionRows(
      input({
        logs: [log('cur', 0), log('released', 1), log('stamped', 2, { costUSD: 7 })],
        releasedCostUSD: new Map([['released', 0.19], ['stamped', 3]]),
      }),
    )
    expect(rows.map(r => [r.sessionId, r.status, r.cost])).toEqual([
      ['cur', 'current', '$0.00'],
      ['released', 'inactive', '$0.19'],
      // Last seen live is newer than a stamp read before the release.
      ['stamped', 'inactive', '$3.00'],
    ])
  })

  test('the current session shows before its transcript exists', () => {
    const rows = buildSessionRows(
      input({ logs: [log('other', 5)], current: { ...IDLE, runningAgents: 2, branch: 'main' } }),
    )
    expect(rows[0]).toMatchObject({ sessionId: 'cur', status: 'current', agents: '2', running: true, where: 'repo', branch: 'main' })
    expect(rows[0]?.log).toBeUndefined()
  })
})

describe('filterSessionRows', () => {
  const rows = buildSessionRows(
    input({
      logs: [
        log('a', 1, { customTitle: 'Fix pihole auth bugs', gitBranch: 'fix/pihole' }),
        log('b', 2, { firstPrompt: 'review https://github.com/o/r/pull/251', prRepository: 'o/r', prNumber: 251 }),
      ],
    }),
  )

  test('every term must match somewhere, case-insensitively', () => {
    expect(filterSessionRows(rows, 'PIHOLE fix').map(r => r.sessionId)).toEqual(['a'])
    expect(filterSessionRows(rows, 'o/r#251').map(r => r.sessionId)).toEqual(['b'])
    expect(filterSessionRows(rows, 'pihole 251')).toEqual([])
  })

  test('an empty query keeps every row', () => {
    expect(filterSessionRows(rows, '  ')).toHaveLength(rows.length)
  })
})

describe('layoutSessionLines', () => {
  test('a rule separates the open sessions from the inactive ones', () => {
    const rows = buildSessionRows(input({ logs: [log('cur', 1), log('a', 2), log('b', 3)] }))
    expect(layoutSessionLines(rows)).toEqual([
      { kind: 'row', index: 0 },
      { kind: 'divider' },
      { kind: 'row', index: 1 },
      { kind: 'row', index: 2 },
    ])
  })

  test('no rule when nothing sits above the inactive sessions', () => {
    const rows = buildSessionRows(input({ logs: [log('a', 2)], currentSessionId: 'a' }))
    const inactiveOnly = rows.map(row => ({ ...row, status: 'inactive' as const }))
    expect(layoutSessionLines(inactiveOnly)).toEqual([{ kind: 'row', index: 0 }])
  })
})

describe('scrollStartFor', () => {
  test('keeps the window still until the focus leaves it', () => {
    expect(scrollStartFor(0, 3, 5, 20)).toBe(0)
    expect(scrollStartFor(0, 5, 5, 20)).toBe(1)
    expect(scrollStartFor(10, 7, 5, 20)).toBe(7)
  })

  test('never scrolls past the end or before the start', () => {
    expect(scrollStartFor(18, 19, 5, 20)).toBe(15)
    expect(scrollStartFor(3, 0, 5, 3)).toBe(0)
  })
})

describe('describeRunningWork', () => {
  test('names the turn and the agents a switch would stop', () => {
    expect(describeRunningWork({ busy: true, runningAgents: 0 })).toBe('the running turn')
    expect(describeRunningWork({ busy: true, runningAgents: 2 })).toBe('the running turn and 2 background agents')
    expect(describeRunningWork({ busy: false, runningAgents: 1 })).toBe('1 background agent')
    expect(describeRunningWork({ busy: false, runningAgents: 0 })).toBeUndefined()
  })
})
