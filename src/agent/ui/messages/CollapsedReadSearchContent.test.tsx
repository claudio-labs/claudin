import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import type { Tools } from 'src/tools/Tool.js'
import type {
  CollapsedReadSearchGroup,
  WriteFileStat,
} from 'src/shared/types/message.js'
import type { MCPProgress } from 'src/shared/types/tools.js'
import { MCPTool } from 'src/tools/MCPTool/MCPTool.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { CollapsedReadSearchContent } from 'src/agent/ui/messages/CollapsedReadSearchContent.js'

const EMPTY_GROUP = {
  type: 'collapsed_read_search',
  searchCount: 0,
  readCount: 0,
  listCount: 0,
  replCount: 0,
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
    expect(firstLine).toContain('updated 1 file')
    expect(firstLine).toContain('deleted 1 file')
    expect(firstLine).toContain('read 3 files')
    expect(firstLine).toContain('+42 −7')
    expect(firstLine.indexOf('Created')).toBeLessThan(
      firstLine.indexOf('read 3 files'),
    )
    // No per-file rows once the group is done.
    expect(out).not.toContain('one.ts')
  })

  test('a moved file gets its own verb, not "updated"', async () => {
    // Only Patch's `Move to:` produces 'R', and it is the one kind no
    // other test reaches — the four verbs are a single array, so a wrong entry
    // would only ever show up here.
    const out = await render({
      writeFileStats: [
        { path: '/repo/moved.ts', kind: 'R', additions: 0, deletions: 0 },
      ],
    })

    expect(flatten(out)).toContain('Renamed 1 file')
  })

  test('a symbol rename reads as a rename but keeps "M" on its row', async () => {
    // The Rename tool rewrites a symbol inside files that keep their path, so
    // the header says "renaming" while the row carries git's letter for a plain
    // modification. Asserting only the header would pass with 'S' mapped to 'R'.
    const out = await render(
      {
        writeFileStats: [
          { path: '/repo/sym.ts', kind: 'S', additions: 3, deletions: 3 },
        ],
        latestWriteFile: '/repo/sym.ts',
      },
      true,
    )

    expect(flatten(out)).toContain('Renaming 1 file')
    expect(out).toContain('M /repo/sym.ts')
  })

  test('a moved file and a symbol rename share one "renamed" part', async () => {
    // Two kinds, one verb — the line must not read "Renamed 1 file, renamed 1
    // file".
    const out = await render({
      writeFileStats: [
        { path: '/repo/moved.ts', kind: 'R', additions: 0, deletions: 0 },
        { path: '/repo/sym.ts', kind: 'S', additions: 3, deletions: 3 },
      ],
    })

    expect(flatten(out)).toContain('Renamed 2 files')
  })

  test('the badge keeps flowing as one line at any width', async () => {
    // 80 is the default and already overflows this badge; 46 forces two more
    // wraps. A column split scrambles the reading order at both.
    for (const columns of [80, 46, 34]) {
      const flat = flatten(await render({ readCount: 3, writeFileStats: stats }, false, columns))
      expectInOrder(flat, [
        'Created 1 file',
        'updated 1 file',
        'deleted 1 file',
        'read 3 files',
        '+42',
        '−7',
        '(ctrl+o',
      ])
    }
  })

  test('a running group shows only the latest file it touched', async () => {
    // One ⎿ line replaced in place, like the MCP hint — the files written
    // before it are counted on the header, not stacked underneath.
    const out = await render(
      { writeFileStats: stats, latestWriteFile: '/repo/two.ts' },
      true,
    )

    expect(out).toContain('updating 1 file')
    expect(out).toContain('A /repo/two.ts')
    expect(out).toContain('+14')
    expect(out).not.toContain('one.ts')
    expect(out).not.toContain('three.ts')
  })

  test('a hint takes the line when the latest operation is not a write', async () => {
    const out = await render(
      { readCount: 1, writeFileStats: stats, latestDisplayHint: 'src/read.ts' },
      true,
    )

    expect(out).toContain('⎿  src/read.ts')
    expect(out).not.toContain('one.ts')
    expect(out).not.toContain('two.ts')
  })

  test('the ⎿ row keeps its path and its +/− together', async () => {
    // The row is its own Box; it hits the same column-split trap as the
    // badge. Only a width narrow enough to wrap it tells the two apart —
    // measured: at 80 and 34 both shapes render identically, at 26 the split
    // one starts eating the path ("M /repo/one.t  +28 −4").
    for (const columns of [80, 26, 20]) {
      const flat = flatten(
        await render(
          { writeFileStats: stats, latestWriteFile: '/repo/one.ts' },
          true,
          columns,
        ),
      )
      expectInOrder(flat, ['⎿', 'M /repo/one.ts', '+28', '−4'])
    }
  })

  test('a zero side is dropped from the badge and from the row', async () => {
    // "+146 −0" reads as noise; only the side that moved is shown.
    const addOnly = flatten(
      await render(
        { writeFileStats: [stats[1]!], latestWriteFile: stats[1]!.path },
        true,
      ),
    )
    expect(addOnly).toContain('A /repo/two.ts +14')
    expect(addOnly).not.toContain('−0')

    const delOnly = flatten(
      await render(
        { writeFileStats: [stats[2]!], latestWriteFile: stats[2]!.path },
        true,
      ),
    )
    expect(delOnly).toContain('D /repo/three.ts −3')
    expect(delOnly).not.toContain('+0')
  })

  test('many files still take one row, never a list', async () => {
    const many: WriteFileStat[] = Array.from({ length: 11 }, (_, i) => ({
      path: `/repo/f${i}.ts`,
      kind: 'M',
      additions: 1,
      deletions: 0,
    }))
    const out = await render(
      { writeFileStats: many, latestWriteFile: '/repo/f10.ts' },
      true,
    )

    expect(out).toContain('Updating 11 files')
    expect(out).toContain('M /repo/f10.ts')
    expect(out).not.toContain('/repo/f0.ts')
    expect(out).not.toContain('more file')
    expect(out.match(/⎿/g)).toHaveLength(1)
  })

  test('a write-only group still renders (it is not treated as empty)', async () => {
    const out = await render({
      writeFileStats: [
        { path: '/repo/one.ts', kind: 'M', additions: 0, deletions: 0 },
      ],
    })

    expect(out).toContain('Updated 1 file')
  })
})

/** A scope's ops, zero unless given. */
function ops(counts: Partial<{ search: number; read: number; write: number }>) {
  return { search: 0, read: 0, write: 0, ...counts }
}

describe('CollapsedReadSearchContent — recalled memories', () => {
  test('a recalled memory leaves the badge for its own Loaded line', async () => {
    const out = await render({ readCount: 3, memoryOps: { private: ops({ read: 1 }) } })
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? ''

    expect(firstLine).toContain('Read 3 files')
    expect(firstLine).not.toContain('memor')
    expect(flatten(out)).toContain('⎿ Loaded 1 private memory')
  })

  test('recalled team memories join the same Loaded line, labelled team', async () => {
    const out = await render({
      readCount: 3,
      memoryOps: { private: ops({ read: 1 }), team: ops({ read: 2 }) },
    })
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? ''

    expect(firstLine).toContain('Read 3 files')
    expect(firstLine).not.toContain('memor')
    expect(flatten(out)).toContain('⎿ Loaded 1 private memory, 2 team memories')
  })

  test('a group of nothing but recalls is one standalone Loaded line', async () => {
    // Every memory read is subtracted out of readCount (collapseReadSearch.ts),
    // so this group has no badge parts left at all. The line has to survive
    // that and carry the expand hint the badge would otherwise have held.
    const out = await render({ memoryOps: { private: ops({ read: 2 }) } })
    const lines = out.split('\n').filter(l => l.trim().length > 0)

    // Exactly one line: an empty badge row would still print "(ctrl+o to
    // expand)" of its own, so a `toContain` alone passes on that shape.
    expect(lines).toHaveLength(1)
    expect(flatten(lines[0]!)).toContain('⎿ Loaded 2 private memories')
    expect(flatten(lines[0]!)).toContain('ctrl+o to expand')
    expect(out).not.toContain('Recalled')
  })

  test('a group of nothing but recalls renders in every scope', async () => {
    // The render gate counts reads too: a recall-only group has no badge part,
    // and must not be dropped as empty.
    for (const [scope, line] of [
      ['global', '⎿ Loaded 1 global memory'],
      ['private', '⎿ Loaded 1 private memory'],
      ['team', '⎿ Loaded 1 team memory'],
    ] as const) {
      const lines = (await render({ memoryOps: { [scope]: ops({ read: 1 }) } }))
        .split('\n')
        .filter(l => l.trim().length > 0)
      expect(lines).toHaveLength(1)
      expect(flatten(lines[0]!)).toContain(line)
    }
  })

  test('the Loaded line sits below the badge, and only one expand hint shows', async () => {
    const lines = (await render({ readCount: 2, memoryOps: { private: ops({ read: 1 }) } }))
      .split('\n')
      .filter(l => l.trim().length > 0)

    expect(lines[0]).toContain('Read 2 files')
    expect(lines[1]).toContain('Loaded 1 private memory')
    expect(flatten(lines.join(' ')).match(/ctrl\+o/g)).toHaveLength(1)
  })

  test('memory writes and searches keep their verbs on the badge', async () => {
    // Only a recall is a context load; writing or searching memory is
    // something the group did, so it stays a badge verb.
    const out = await render({ memoryOps: { private: ops({ write: 1, search: 1 }) } })
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? ''

    expect(firstLine).toContain('Searched private memories')
    expect(firstLine).toContain('wrote 1 private memory')
    expect(out).not.toContain('Loaded')
  })

  test('the recall line keeps its count together at narrow widths', async () => {
    // A width that forces a wrap is the only thing that tells one <Text> from
    // sibling <Text>s laid out as independently-wrapping columns (ink-tui.md §10).
    for (const columns of [80, 40, 24]) {
      const flat = flatten(
        await render({ memoryOps: { private: ops({ read: 3 }) } }, false, columns),
      )
      expectInOrder(flat, ['Loaded 3 private memories'])
    }
  })

  test('a recalled global memory is named global, ahead of the private ones', async () => {
    const out = await render({
      readCount: 1,
      memoryOps: { private: ops({ read: 1 }), global: ops({ read: 2 }) },
    })
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? ''

    expect(firstLine).toContain('Read 1 file')
    expect(firstLine).not.toContain('memor')
    expect(flatten(out)).toContain('⎿ Loaded 2 global memories, 1 private memory')
  })

  test('global memory writes and searches get their own verbs, ahead of private', async () => {
    const flat = flatten(
      await render({
        memoryOps: { private: ops({ write: 1 }), global: ops({ search: 1, write: 2 }) },
      }),
    )

    expectInOrder(flat, [
      'Searched global memories',
      ', wrote 2 global memories',
      ', wrote 1 private memory',
    ])
    expect(flat).not.toContain('Loaded')
  })

  test('a running global write reads in the present tense', async () => {
    const flat = flatten(await render({ memoryOps: { global: ops({ write: 1 }) } }, true))
    expect(flat).toContain('Writing 1 global memory')
  })
})

describe('CollapsedReadSearchContent — memory badge, per scope', () => {
  test('each scope names its search and its write', async () => {
    for (const scope of ['global', 'private', 'team'] as const) {
      expect(flatten(await render({ memoryOps: { [scope]: ops({ search: 1 }) } }))).toContain(
        `Searched ${scope} memories`,
      )
      expect(flatten(await render({ memoryOps: { [scope]: ops({ write: 1 }) } }))).toContain(
        `Wrote 1 ${scope} memory`,
      )
      expect(flatten(await render({ memoryOps: { [scope]: ops({ write: 3 }) } }))).toContain(
        `Wrote 3 ${scope} memories`,
      )
    }
  })

  test('team searches and writes share one part list, search first', async () => {
    expect(
      flatten(await render({ memoryOps: { team: ops({ search: 1, write: 2 }) } })),
    ).toContain('Searched team memories, wrote 2 team memories')
  })

  test('a preceding part lowercases the first memory verb and adds the comma', async () => {
    const flat = flatten(await render({ readCount: 1, memoryOps: { team: ops({ write: 1 }) } }))
    expectInOrder(flat, ['Read 1 file', ', wrote 1 team memory'])
  })

  test('scopes render global, private, team — whatever the key order', async () => {
    const flat = flatten(
      await render({
        memoryOps: {
          team: ops({ search: 1 }),
          private: ops({ search: 1 }),
          global: ops({ search: 1 }),
        },
      }),
    )
    expectInOrder(flat, [
      'Searched global memories',
      ', searched private memories',
      ', searched team memories',
    ])
  })
})

describe('CollapsedReadSearchContent — MCP clock', () => {
  const SERVER = 'plugin:context7:context7'

  function mcpToolUse(id: string) {
    return {
      type: 'assistant',
      uuid: `msg-${id}`,
      timestamp: '2026-08-12T00:00:00.000Z',
      message: {
        role: 'assistant',
        id: `api-${id}`,
        content: [{ type: 'tool_use', id, name: 'mcp__context7__query-docs', input: {} }],
      },
    }
  }

  function mcpTick(id: string, fields: Partial<MCPProgress>) {
    return {
      type: 'progress',
      toolUseID: `p-${id}`,
      parentToolUseID: id,
      data: {
        type: 'mcp_progress',
        status: 'started',
        serverName: SERVER,
        toolName: 'query-docs',
        ...fields,
      },
    }
  }

  function renderMcp(opts: {
    ticks: ReturnType<typeof mcpTick>[]
    running?: string[]
    overrides?: Partial<CollapsedReadSearchGroup>
  }): Promise<string> {
    const progress = new Map<string, unknown[]>()
    for (const tick of opts.ticks) {
      progress.set(tick.parentToolUseID, [...(progress.get(tick.parentToolUseID) ?? []), tick])
    }
    const isActiveGroup = (opts.running?.length ?? 0) > 0
    return renderToString(
      <AppStateProvider>
        <CollapsedReadSearchContent
          message={{
            ...EMPTY_GROUP,
            mcpCallCount: 2,
            mcpServerNames: [SERVER],
            messages: [mcpToolUse('m1'), mcpToolUse('m2')],
            ...opts.overrides,
          } as unknown as CollapsedReadSearchGroup}
          inProgressToolUseIDs={new Set(opts.running ?? [])}
          shouldAnimate={false}
          verbose={false}
          tools={[] as unknown as Tools}
          lookups={{ ...lookups, progressMessagesByToolUseID: progress } as typeof lookups}
          isActiveGroup={isActiveGroup}
        />
      </AppStateProvider>,
    ).then(stripAnsi)
  }

  test('a running batch ticks from the first call that started', async () => {
    const now = Date.now()
    const flat = flatten(
      await renderMcp({
        ticks: [
          mcpTick('m1', { status: 'completed', startedAt: now - 12_000, elapsedTimeMs: 3_000 }),
          // Its `started` tick was replaced by a progress one; the start survives on it.
          mcpTick('m2', { status: 'progress', startedAt: now - 8_000, progress: 1 }),
        ],
        running: ['m2'],
      }),
    )
    expectInOrder(flat, [`Calling ${SERVER} 2 times · 12s`, '…'])
  })

  test('a finished batch keeps its total', async () => {
    const flat = flatten(
      await renderMcp({
        ticks: [
          mcpTick('m1', { status: 'completed', startedAt: 1_000, elapsedTimeMs: 6_000 }),
          mcpTick('m2', { status: 'completed', startedAt: 7_000, elapsedTimeMs: 8_400 }),
        ],
      }),
    )
    expectInOrder(flat, [`Called ${SERVER} 2 times · 14s`, '(ctrl+o'])
  })

  test('the clock stays with the MCP part, not at the end of the line', async () => {
    const flat = flatten(
      await renderMcp({
        ticks: [
          mcpTick('m1', { status: 'completed', startedAt: 1_000, elapsedTimeMs: 6_000 }),
          mcpTick('m2', { status: 'completed', startedAt: 7_000, elapsedTimeMs: 8_400 }),
        ],
        overrides: { memoryOps: { private: ops({ write: 1 }) } },
      }),
    )
    expectInOrder(flat, [`Called ${SERVER} 2 times · 14s`, ', wrote 1 private memory'])
  })

  test('a resumed group, with no ticks left, shows no time', async () => {
    const flat = flatten(await renderMcp({ ticks: [] }))
    expectInOrder(flat, [`Called ${SERVER} 2 times (ctrl+o`])
    expect(flat).not.toContain('·')
  })
})

describe('CollapsedReadSearchContent — MCP detail (ctrl+o)', () => {
  const RESULT = '{"resolved_scope": {"workspace": "default"}, "messages": []}'

  function mcpTool(serverName: string, toolName: string) {
    return {
      ...MCPTool,
      name: `mcp__${serverName}__${toolName}`,
      mcpInfo: { serverName, toolName },
      userFacingName: () => `${serverName} - ${toolName} (MCP)`,
    }
  }

  function renderDetail(opts: {
    serverName?: string
    resolved: boolean
  }): Promise<string> {
    const tool = mcpTool(opts.serverName ?? 'ai-memory', 'memory_message_list')
    const use = {
      type: 'assistant',
      uuid: 'msg-m1',
      timestamp: '2026-10-11T00:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'api-m1',
        content: [{ type: 'tool_use', id: 'm1', name: tool.name, input: { box: 'inbox', limit: 5 } }],
      },
    }
    return renderToString(
      <AppStateProvider>
        <CollapsedReadSearchContent
          message={{ ...EMPTY_GROUP, mcpCallCount: 1, messages: [use] } as unknown as CollapsedReadSearchGroup}
          inProgressToolUseIDs={new Set(opts.resolved ? [] : ['m1'])}
          shouldAnimate={false}
          verbose={true}
          tools={[tool] as unknown as Tools}
          lookups={{
            ...lookups,
            resolvedToolUseIDs: new Set(opts.resolved ? ['m1'] : []),
            toolResultByToolUseID: new Map(opts.resolved ? [['m1', { type: 'user', toolUseResult: RESULT }]] : []),
          } as unknown as typeof lookups}
          isActiveGroup={!opts.resolved}
        />
      </AppStateProvider>,
      120,
    ).then(stripAnsi)
  }

  test('a finished call reads Called server.tool with the arguments as sent', async () => {
    const out = await renderDetail({ resolved: true })
    expect(out).toContain('Called ai-memory.memory_message_list({"box":"inbox","limit":5})')
    expect(out).not.toContain('(MCP)')
  })

  test('the result stays the compact JSON the server sent', async () => {
    const out = await renderDetail({ resolved: true })
    // Pretty-printed, it would be split one key per row.
    expect(out).toContain(RESULT)
  })

  test('a running call reads Calling', async () => {
    const out = await renderDetail({ resolved: false })
    expect(out).toContain('Calling ai-memory.memory_message_list({"box":"inbox","limit":5})')
  })

  test('a claude.ai server drops its prefix, as the group header does', async () => {
    const out = await renderDetail({ serverName: 'claude.ai Slack', resolved: true })
    expect(out).toContain('Called Slack.memory_message_list(')
  })
})

describe('CollapsedReadSearchContent — shell lane (fullscreen)', () => {
  let savedNoFlicker: string | undefined

  beforeAll(() => {
    savedNoFlicker = process.env.CLAUDIN_NO_FLICKER
    process.env.CLAUDIN_NO_FLICKER = '1'
  })
  afterAll(() => {
    if (savedNoFlicker === undefined) delete process.env.CLAUDIN_NO_FLICKER
    else process.env.CLAUDIN_NO_FLICKER = savedNoFlicker
  })

  test('git ops lead the line, and the commands behind them leave the shell count', async () => {
    for (const columns of [80, 200]) {
      const flat = flatten(
        await render(
          {
            readCount: 1,
            bashCount: 3,
            gitOpBashCount: 1,
            commits: [
              { sha: '1a2b3c', kind: 'committed' },
              { sha: '9f8e7d', kind: 'amended' },
              { sha: '445566', kind: 'cherry-picked' },
            ],
            pushes: [{ branch: 'main' }, { branch: 'main' }],
            branches: [
              { ref: 'feat/x', action: 'merged' },
              { ref: 'origin/main', action: 'rebased' },
            ],
            prs: [{ number: 42, action: 'created' }],
          },
          false,
          columns,
        ),
      )
      expectInOrder(flat, [
        'Committed 1a2b3c',
        ', amended commit 9f8e7d',
        ', cherry-picked 445566',
        // Two pushes to one branch name it once.
        ', pushed to main, merged feat/x',
        ', rebased onto origin/main',
        ', created PR #42',
        ', read 1 file',
        ', ran 2 shell commands',
      ])
    }
  })

  test('a group that is nothing but a commit still renders', async () => {
    const flat = flatten(
      await render({ bashCount: 1, gitOpBashCount: 1, commits: [{ sha: '1a2b3c', kind: 'committed' }] }),
    )
    expectInOrder(flat, ['Committed 1a2b3c', '(ctrl+o'])
    expect(flat).not.toContain('shell command')
  })

  test('every PR action has its verb', async () => {
    const flat = flatten(
      await render(
        {
          // A PR only reaches the group through a command counted as a git op.
          bashCount: 5,
          gitOpBashCount: 5,
          prs: [
            { number: 1, action: 'edited' },
            { number: 2, action: 'merged' },
            { number: 3, action: 'commented' },
            { number: 4, action: 'closed' },
            { number: 5, action: 'ready' },
          ],
        },
        false,
        200,
      ),
    )
    expectInOrder(flat, [
      'Edited PR #1',
      ', merged PR #2',
      ', commented on PR #3',
      ', closed PR #4',
      ', marked ready PR #5',
    ])
  })

  test('a running group says Running', async () => {
    const flat = flatten(await render({ bashCount: 2 }, true))
    expectInOrder(flat, ['Running 2 shell commands', '…'])
  })

  test('without fullscreen the shell parts are not shown', async () => {
    process.env.CLAUDIN_NO_FLICKER = '0'
    try {
      const flat = flatten(
        await render({ readCount: 1, bashCount: 2, commits: [{ sha: '1a2b3c', kind: 'committed' }] }),
      )
      expect(flat).toContain('Read 1 file')
      expect(flat).not.toContain('Committed')
      expect(flat).not.toContain('shell command')
    } finally {
      process.env.CLAUDIN_NO_FLICKER = '1'
    }
  })

  describe('clock', () => {
    function shellToolUse(id: string) {
      return {
        type: 'assistant',
        uuid: `msg-${id}`,
        timestamp: '2026-08-12T00:00:00.000Z',
        message: {
          role: 'assistant',
          id: `api-${id}`,
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }],
        },
      }
    }

    function renderShell(opts: {
      ticks: Record<string, unknown>
      running: string[]
    }): Promise<string> {
      const progress = new Map<string, unknown[]>()
      for (const [id, data] of Object.entries(opts.ticks)) {
        progress.set(id, [{ type: 'progress', toolUseID: `p-${id}`, parentToolUseID: id, data }])
      }
      return renderToString(
        <AppStateProvider>
          <CollapsedReadSearchContent
            message={{
              ...EMPTY_GROUP,
              bashCount: 2,
              latestDisplayHint: '$ npm test',
              messages: [shellToolUse('b1'), shellToolUse('b2')],
            } as unknown as CollapsedReadSearchGroup}
            inProgressToolUseIDs={new Set(opts.running)}
            shouldAnimate={false}
            verbose={false}
            tools={[] as unknown as Tools}
            lookups={{ ...lookups, progressMessagesByToolUseID: progress } as typeof lookups}
            isActiveGroup={opts.running.length > 0}
          />
        </AppStateProvider>,
      ).then(stripAnsi)
    }

    const bashTick = (elapsedTimeSeconds: number, totalLines: number) => ({
      type: 'bash_progress',
      output: '',
      fullOutput: '',
      elapsedTimeSeconds,
      totalLines,
      totalBytes: 0,
    })

    test('the slowest running shell command owns the header clock; its lines go on the hint', async () => {
      // The slowest comes first, so "the last one seen" would show the wrong one.
      const flat = flatten(
        await renderShell({
          ticks: { b1: bashTick(12, 3), b2: bashTick(4, 1) },
          running: ['b1', 'b2'],
        }),
      )
      expectInOrder(flat, ['Running 2 shell commands · 12s', '…', '$ npm test (3 lines)'])
    })

    test('a command that is no longer running has no clock', async () => {
      const flat = flatten(
        await renderShell({ ticks: { b1: bashTick(12, 3) }, running: ['b2'] }),
      )
      expect(flat).not.toContain('·')
      expect(flat).not.toContain('lines)')
    })
  })
})
