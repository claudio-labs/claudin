import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { buildSessionRows, layoutSessionLines } from 'src/sessions/ui/sessionRows.js'
import { fitPlace, SessionsTable, sessionColumns } from 'src/sessions/ui/SessionsTable.js'
import type { LogOption } from 'src/shared/types/logs.js'

const NOW = new Date('2026-09-27T12:00:00Z')

function log(sessionId: string, minutesAgo: number, extra: Partial<LogOption>): LogOption {
  const modified = new Date(NOW.getTime() - minutesAgo * 60_000)
  return {
    date: modified.toISOString(),
    messages: [],
    value: 0,
    created: modified,
    modified,
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    sessionId,
    projectPath: '/repo',
    ...extra,
  }
}

const rows = buildSessionRows({
  logs: [
    log('cur', 0, { customTitle: 'Redesign the resume screen', gitBranch: 'main', contextTokens: 84_000 }),
    log('held', 3, { customTitle: 'Fix pihole auth bugs', gitBranch: 'fix/pihole-auth', contextTokens: 412_000 }),
    log('old', 60 * 24, {
      customTitle: 'Validate upstream URLs against the registry before merging',
      gitBranch: 'feat/upstream-url-guidance',
      contextTokens: 1_200_000,
      costUSD: 22.46,
    }),
  ],
  currentSessionId: 'cur',
  instanceSessionIds: ['cur'],
  liveElsewhere: [{ sessionId: 'held', pid: 9, cwd: '/repo', turnActive: true, runningAgents: 3, costUSD: 1.5 }],
  current: { turnActive: false, runningAgents: 0, costUSD: 0.19 },
  cwd: '/repo',
  now: NOW,
})
const lines = layoutSessionLines(rows)

function render(width: number, focusedIndex = 2): Promise<string> {
  return renderToString(
    <SessionsTable rows={rows} lines={lines} focusedIndex={focusedIndex} start={0} height={10} width={width} />,
    width,
  )
}

/** The fragments appear, in order, on the line holding `anchor`. */
function expectOnOneLine(output: string, anchor: string, fragments: string[]): void {
  const line = output.split('\n').find(l => l.includes(anchor))
  expect(line).toBeDefined()
  let from = 0
  for (const fragment of fragments) {
    const at = line!.indexOf(fragment, from)
    expect(at).toBeGreaterThanOrEqual(from)
    from = at + fragment.length
  }
}

describe('SessionsTable', () => {
  for (const width of [80, 120, 200]) {
    test(`every column of a row stays on its line at ${width} columns`, async () => {
      const output = await render(width)
      expectOnOneLine(output, 'Description', ['Description', 'Agents', 'Branch/worktree', 'Tokens', 'Cost', 'When'])
      // At 80 columns the title is cut to make room; "(current)" stays.
      expectOnOneLine(output, 'Redesi', ['●', 'Redesi', '(current)', '0', 'repo', 'main', '84k', '$0.19', '0s ago'])
      expectOnOneLine(output, 'Fix pih', ['●', 'Fix pih', '3', 'repo', 'fix/pihol', '412k', '$1.50', '3m ago'])
      expectOnOneLine(output, 'Validate', ['❯', '●', 'Validate', '0', 'repo', 'feat/', '1.2m', '$22.46', '1d ago'])
      expectOnOneLine(output, 'inactive', ['── inactive'])
      for (const line of output.split('\n')) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width)
      }
    })
  }

  test('the rule sits between the open sessions and the inactive ones', async () => {
    const output = await render(120)
    const order = ['Fix pihole', '── inactive', 'Validate'].map(f => output.indexOf(f))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('a blank line separates each line of the table', async () => {
    const lines = (await render(120)).split('\n')
    const at = (fragment: string): number => lines.findIndex(l => l.includes(fragment))
    expect(at('Fix pihole') - at('Redesign')).toBe(2)
    expect(at('── inactive') - at('Fix pihole')).toBe(2)
    expect(lines[at('Redesign') + 1]!.trim()).toBe('')
  })

  test('the columns add up to the width, the description to two fifths of it', () => {
    for (const width of [80, 120, 200, 256]) {
      const c = sessionColumns(width)
      // The cursor and dot (4) and the five two-space gaps.
      expect(4 + 10 + c.title + c.agents + c.place + c.tokens + c.cost + c.when).toBe(width)
    }
    expect(sessionColumns(200).title).toBe(80)
    expect(sessionColumns(256).title).toBe(102)
  })

  test('"When" ends on the right edge, where the search box does', async () => {
    for (const width of [120, 200]) {
      const lines = (await render(width)).split('\n')
      const header = lines.find(l => l.includes('Description'))!
      expect(header.trimEnd().length).toBe(width)
      expect(lines.find(l => l.includes('1d ago'))!.trimEnd().length).toBe(width)
    }
  })

  test('a place too narrow for both keeps the branch', () => {
    expect(fitPlace('claudin', 'feat/sessions-screen', 40)).toEqual({ where: 'claudin', branch: 'feat/sessions-screen' })
    expect(fitPlace('claudin', 'feat/sessions-screen', 24).where).toBe('claudin')
    expect(fitPlace('a-very-long-worktree-name', 'main', 16)).toEqual({ where: '', branch: 'main' })
    // Six columns less the pill's two spaces of padding.
    expect(fitPlace('claudin', '', 6)).toEqual({ where: 'cla…', branch: '' })
  })
})
