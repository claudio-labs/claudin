import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/state/AppState.js'
import type { Tools } from 'src/Tool.js'
import type {
  CollapsedReadSearchGroup,
  WriteFileStat,
} from 'src/types/message.js'
import { renderToString } from 'src/components/staticRender.js'
import { CollapsedReadSearchContent } from './CollapsedReadSearchContent.js'

const EMPTY_GROUP = {
  type: 'collapsed_read_search',
  searchCount: 0,
  readCount: 0,
  listCount: 0,
  replCount: 0,
  memorySearchCount: 0,
  memoryReadCount: 0,
  memoryWriteCount: 0,
  readFilePaths: [],
  searchArgs: [],
  latestDisplayHint: undefined,
  messages: [],
  displayMessage: undefined,
  uuid: 'group-1',
  timestamp: '2026-08-12T00:00:00.000Z',
} as unknown as CollapsedReadSearchGroup

const lookups = {
  erroredToolUseIDs: new Set<string>(),
  resolvedToolUseIDs: new Set<string>(),
  progressMessagesByToolUseID: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
} as unknown as React.ComponentProps<
  typeof CollapsedReadSearchContent
>['lookups']

function render(
  overrides: Partial<CollapsedReadSearchGroup>,
  isActiveGroup = false,
  columns?: number,
): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <CollapsedReadSearchContent
        message={{ ...EMPTY_GROUP, ...overrides }}
        inProgressToolUseIDs={new Set()}
        shouldAnimate={false}
        verbose={false}
        tools={[] as unknown as Tools}
        lookups={lookups}
        isActiveGroup={isActiveGroup}
      />
    </AppStateProvider>,
    columns,
  ).then(stripAnsi)
}

/** Collapse every wrap into a single space: what the eye reads, in order. */
function flatten(out: string): string {
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Asserts `haystack` contains all of `needles`, contiguously each and in this
 * order. Width-independent, which is the point: a line split into sibling
 * <Text> columns still contains every word, but interleaved (see §10 of
 * rules/ink-tui.md), so both the contiguity and the order break.
 */
function expectInOrder(haystack: string, needles: string[]): void {
  let at = 0
  for (const needle of needles) {
    const found = haystack.indexOf(needle, at)
    if (found < 0) {
      throw new Error(
        `expected ${JSON.stringify(needle)} at or after index ${at} in:\n${haystack}`,
      )
    }
    at = found + needle.length
  }
}

const stats: WriteFileStat[] = [
  { path: '/repo/one.ts', kind: 'M', additions: 28, deletions: 4 },
  { path: '/repo/two.ts', kind: 'A', additions: 14, deletions: 0 },
  { path: '/repo/three.ts', kind: 'D', additions: 0, deletions: 3 },
]

describe('CollapsedReadSearchContent — write lane', () => {
  test('a finished group is one line: verbs per kind plus the summed +/−', async () => {
    const out = await render({ readCount: 3, writeFileStats: stats })
    // Assert on the RAW line, not on whitespace-normalized text: the badge has
    // to stay one flowing line. Rendering it as sibling <Text>s in the row Box
    // turns each into its own wrapping column, which still "contains" every
    // word — just spread over two rows (see rules/ink-tui.md §10).
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? ''

    // Writes lead the line, so the read part is no longer the capitalized one.
    expect(firstLine).toContain('Created 1 file')
    expect(firstLine).toContain('edited 1 file')
    expect(firstLine).toContain('deleted 1 file')
    expect(firstLine).toContain('read 3 files')
    expect(firstLine).toContain('+42 −7')
    expect(firstLine.indexOf('Created')).toBeLessThan(
      firstLine.indexOf('read 3 files'),
    )
    // No per-file rows once the group is done.
    expect(out).not.toContain('one.ts')
  })

  test('a moved file gets its own verb, not "edited"', async () => {
    // Only apply_patch's `Move to:` produces 'R', and it is the one kind no
    // other test reaches — the four verbs are a single array, so a wrong entry
    // would only ever show up here.
    const out = await render({
      writeFileStats: [
        { path: '/repo/moved.ts', kind: 'R', additions: 0, deletions: 0 },
      ],
    })

    expect(flatten(out)).toContain('Renamed 1 file')
  })

  test('the badge keeps flowing as one line at any width', async () => {
    // 80 is the default and already overflows this badge; 46 forces two more
    // wraps. A column split scrambles the reading order at both.
    for (const columns of [80, 46, 34]) {
      const flat = flatten(await render({ readCount: 3, writeFileStats: stats }, false, columns))
      expectInOrder(flat, [
        'Created 1 file',
        'edited 1 file',
        'deleted 1 file',
        'read 3 files',
        '+42',
        '−7',
        '(ctrl+o',
      ])
    }
  })

  test('a running group lists the files it touched', async () => {
    const out = await render({ writeFileStats: stats }, true)

    expect(out).toContain('editing 1 file')
    expect(out).toContain('M /repo/one.ts')
    expect(out).toContain('A /repo/two.ts')
    expect(out).toContain('D /repo/three.ts')
    expect(out).toContain('+28')
  })

  test('each ⎿ row keeps its path and its +/− together', async () => {
    // The rows are their own Box; they hit the same column-split trap as the
    // badge. Only a width narrow enough to wrap a row tells the two apart —
    // measured: at 80 and 34 both shapes render identically, at 26 the split
    // one starts eating the path ("M /repo/one.t  +28 −4").
    for (const columns of [80, 26, 20]) {
      const flat = flatten(await render({ writeFileStats: stats }, true, columns))
      expectInOrder(flat, [
        'M /repo/one.ts',
        '+28',
        '−4',
        'A /repo/two.ts',
        '+14',
        '−0',
        'D /repo/three.ts',
        '+0',
        '−3',
      ])
    }
  })

  test('the file list is capped and the remainder is counted', async () => {
    const many: WriteFileStat[] = Array.from({ length: 11 }, (_, i) => ({
      path: `/repo/f${i}.ts`,
      kind: 'M',
      additions: 1,
      deletions: 0,
    }))
    const out = await render({ writeFileStats: many }, true)

    expect(out).toContain('/repo/f7.ts')
    expect(out).not.toContain('/repo/f8.ts')
    expect(out).toContain('and 3 more files')
  })

  test('a write-only group still renders (it is not treated as empty)', async () => {
    const out = await render({
      writeFileStats: [
        { path: '/repo/one.ts', kind: 'M', additions: 0, deletions: 0 },
      ],
    })

    expect(out).toContain('Edited 1 file')
  })
})
