import { afterEach, describe, expect, test } from 'bun:test'
import type { Tools } from 'src/Tool.js'
import type {
  CollapsedReadSearchGroup,
  RenderableMessage,
} from 'src/types/message.js'
import {
  collapseReadSearchGroups,
  summarizeRecentActivities,
} from './collapseReadSearch.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

let counter = 0
const uid = (): string => `uuid-${counter++}`

const READ_TOOL = {
  name: 'Read',
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
}
const tools = [READ_TOOL] as unknown as Tools

function toolUse(id: string, name: string, input: unknown): RenderableMessage {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-08-12T00:00:00.000Z',
    message: {
      role: 'assistant',
      id: uid(),
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as RenderableMessage
}

function toolResult(
  id: string,
  result: unknown,
  isError = false,
): RenderableMessage {
  return {
    type: 'user',
    uuid: uid(),
    timestamp: '2026-08-12T00:00:00.000Z',
    toolUseResult: result,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content: isError ? 'boom' : 'ok',
        },
      ],
    },
  } as unknown as RenderableMessage
}

function assistantText(text: string): RenderableMessage {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-08-12T00:00:00.000Z',
    message: {
      role: 'assistant',
      id: uid(),
      content: [{ type: 'text', text }],
    },
  } as unknown as RenderableMessage
}

/** One structuredPatch hunk with `additions` +lines and `deletions` -lines. */
function hunk(additions: number, deletions: number) {
  return {
    oldStart: 1,
    oldLines: deletions,
    newStart: 1,
    newLines: additions,
    lines: [
      ...Array.from({ length: additions }, (_, i) => `+added ${i}`),
      ...Array.from({ length: deletions }, (_, i) => `-removed ${i}`),
      ' context',
    ],
  }
}

function collapse(messages: RenderableMessage[]): RenderableMessage[] {
  return collapseReadSearchGroups(messages, tools)
}

function onlyGroup(messages: RenderableMessage[]): CollapsedReadSearchGroup {
  const collapsed = collapse(messages)
  expect(collapsed).toHaveLength(1)
  expect(collapsed[0]!.type).toBe('collapsed_read_search')
  return collapsed[0] as CollapsedReadSearchGroup
}

afterEach(() => {
  saveGlobalConfig(c => ({ ...c, collapseFileWritesEnabled: undefined }))
})

describe('write collapse', () => {
  test('an Edit joins the same group as the reads around it', () => {
    const group = onlyGroup([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      toolUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e1', { filePath: '/repo/b.ts', structuredPatch: [hunk(4, 1)] }),
    ])

    expect(group.readCount).toBe(1)
    expect(group.writeFileStats).toEqual([
      { path: '/repo/b.ts', kind: 'M', additions: 4, deletions: 1 },
    ])
  })

  test('repeated edits of one file are a single row with summed counts', () => {
    const group = onlyGroup([
      toolUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e1', { filePath: '/repo/b.ts', structuredPatch: [hunk(4, 1)] }),
      toolUse('e2', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e2', { filePath: '/repo/b.ts', structuredPatch: [hunk(2, 0)] }),
    ])

    expect(group.writeFileStats).toEqual([
      { path: '/repo/b.ts', kind: 'M', additions: 6, deletions: 1 },
    ])
  })

  test('a Write that created the file is reported as an addition', () => {
    const group = onlyGroup([
      toolUse('w1', 'Write', { file_path: '/repo/new.ts' }),
      toolResult('w1', {
        type: 'create',
        filePath: '/repo/new.ts',
        content: 'a\nb\nc',
        structuredPatch: [],
      }),
    ])

    expect(group.writeFileStats).toEqual([
      { path: '/repo/new.ts', kind: 'A', additions: 3, deletions: 0 },
    ])
  })

  test('apply_patch lists every file in the envelope, by kind', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: /repo/added.ts',
      '+hello',
      '*** Delete File: /repo/gone.ts',
      '*** End Patch',
    ].join('\n')

    // Envelope only, no result yet: the rows have to come from parsing the
    // patch, so this half fails if getApplyPatchTargets stops resolving hunks.
    const pending = onlyGroup([toolUse('p0', 'apply_patch', { patchText })])
    expect(pending.writeFileStats).toEqual([
      { path: '/repo/added.ts', kind: 'A', additions: 0, deletions: 0 },
      { path: '/repo/gone.ts', kind: 'D', additions: 0, deletions: 0 },
    ])

    const group = onlyGroup([
      toolUse('p1', 'apply_patch', { patchText }),
      toolResult('p1', {
        files: [
          {
            absPath: '/repo/added.ts',
            type: 'add',
            additions: 1,
            deletions: 0,
          },
          { absPath: '/repo/gone.ts', type: 'delete', additions: 0, deletions: 7 },
        ],
      }),
    ])

    expect(group.writeFileStats).toEqual([
      { path: '/repo/added.ts', kind: 'A', additions: 1, deletions: 0 },
      { path: '/repo/gone.ts', kind: 'D', additions: 0, deletions: 7 },
    ])
  })

  test('a write whose input is still streaming keeps its own block', () => {
    // content_block_start arrives with `input: {}` and the partial JSON lives
    // elsewhere. Absorbing it here would hide the write completely: the group
    // cannot name a file it has not been told about.
    const collapsed = collapse([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      toolUse('e1', 'Edit', {}),
    ])

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
    ])
  })

  test('a relative path waits for the result instead of inventing a row', () => {
    // Resolving it here would use the cwd at RENDER time; after a `cd` that is
    // a different file from the one the result reports, and the group would
    // list both.
    const patchText = [
      '*** Begin Patch',
      '*** Add File: rel/added.ts',
      '+hello',
      '*** End Patch',
    ].join('\n')

    const pending = onlyGroup([toolUse('p1', 'apply_patch', { patchText })])
    expect(pending.writeFileStats).toBeUndefined()

    const resolved = onlyGroup([
      toolUse('p2', 'apply_patch', { patchText }),
      toolResult('p2', {
        files: [
          { absPath: '/elsewhere/rel/added.ts', type: 'add', additions: 1, deletions: 0 },
        ],
      }),
    ])
    expect(resolved.writeFileStats).toEqual([
      { path: '/elsewhere/rel/added.ts', kind: 'A', additions: 1, deletions: 0 },
    ])
  })

  test('the result decides the kind when the envelope could not', () => {
    // Relative paths, so NOTHING is recorded from the input and every kind here
    // comes from the result — including 'R', whose row is keyed by the move
    // DESTINATION, because that is where the file lives now.
    const patchText = [
      '*** Begin Patch',
      '*** Add File: rel/a.ts',
      '+x',
      '*** Delete File: rel/b.ts',
      '*** End Patch',
    ].join('\n')

    const group = onlyGroup([
      toolUse('p1', 'apply_patch', { patchText }),
      toolResult('p1', {
        files: [
          { absPath: '/w/a.ts', type: 'add', additions: 2, deletions: 0 },
          { absPath: '/w/b.ts', type: 'delete', additions: 0, deletions: 5 },
          {
            absPath: '/w/c.ts',
            movePath: '/w/d.ts',
            type: 'move',
            additions: 1,
            deletions: 1,
          },
        ],
      }),
    ])

    expect(group.writeFileStats).toEqual([
      { path: '/w/a.ts', kind: 'A', additions: 2, deletions: 0 },
      { path: '/w/b.ts', kind: 'D', additions: 0, deletions: 5 },
      { path: '/w/d.ts', kind: 'R', additions: 1, deletions: 1 },
    ])
  })

  test('a created file does not count its trailing newline as a line', () => {
    const group = onlyGroup([
      toolUse('w1', 'Write', { file_path: '/repo/new.ts' }),
      toolResult('w1', {
        type: 'create',
        filePath: '/repo/new.ts',
        content: 'a\nb\nc\n',
        structuredPatch: [],
      }),
    ])

    expect(group.writeFileStats).toEqual([
      { path: '/repo/new.ts', kind: 'A', additions: 3, deletions: 0 },
    ])
  })

  test('a failed write breaks the group instead of hiding the error', () => {
    const collapsed = collapse([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      toolUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e1', undefined, true),
    ])

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
      'user',
    ])
  })

  test('Rename preview keeps its own block, apply collapses', () => {
    const preview = collapse([
      toolUse('n1', 'Rename', { symbol: 'a', replacement: 'b', mode: 'preview' }),
      toolResult('n1', { type: 'preview', siteCount: 3, fileCount: 2 }),
    ])
    expect(preview.map(m => m.type)).toEqual(['assistant', 'user'])

    const group = onlyGroup([
      toolUse('n2', 'Rename', { symbol: 'a', replacement: 'b', mode: 'apply' }),
      toolResult('n2', {
        type: 'apply',
        files: [{ absPath: '/repo/x.ts', additions: 3, deletions: 3 }],
      }),
    ])
    // 'M', not 'R': Rename rewrites a symbol inside files that keep their path.
    expect(group.writeFileStats).toEqual([
      { path: '/repo/x.ts', kind: 'M', additions: 3, deletions: 3 },
    ])
  })

  test('a grouped Edit reads every file and its inline results', () => {
    const first = toolUse('g1', 'Edit', { file_path: '/repo/one.ts' })
    const second = toolUse('g2', 'Edit', { file_path: '/repo/two.ts' })
    const grouped = {
      type: 'grouped_tool_use',
      toolName: 'Edit',
      messages: [first, second],
      results: [
        toolResult('g1', {
          filePath: '/repo/one.ts',
          structuredPatch: [hunk(1, 0)],
        }),
        toolResult('g2', {
          filePath: '/repo/two.ts',
          structuredPatch: [hunk(0, 2)],
        }),
      ],
      displayMessage: first,
      uuid: uid(),
      timestamp: '2026-08-12T00:00:00.000Z',
      messageId: 'msg-1',
    } as unknown as RenderableMessage

    const group = onlyGroup([grouped])

    expect(group.writeFileStats).toEqual([
      { path: '/repo/one.ts', kind: 'M', additions: 1, deletions: 0 },
      { path: '/repo/two.ts', kind: 'M', additions: 0, deletions: 2 },
    ])
  })

  test('assistant text still breaks the group', () => {
    const collapsed = collapse([
      toolUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e1', { filePath: '/repo/b.ts', structuredPatch: [] }),
      assistantText('done'),
      toolUse('e2', 'Edit', { file_path: '/repo/c.ts' }),
      toolResult('e2', { filePath: '/repo/c.ts', structuredPatch: [] }),
    ])

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
      'collapsed_read_search',
    ])
  })

  test('collapseFileWritesEnabled: false restores the per-write blocks', () => {
    saveGlobalConfig(c => ({ ...c, collapseFileWritesEnabled: false }))
    expect(getGlobalConfig().collapseFileWritesEnabled).toBe(false)

    const collapsed = collapse([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      toolUse('e1', 'Edit', { file_path: '/repo/b.ts' }),
      toolResult('e1', { filePath: '/repo/b.ts', structuredPatch: [hunk(4, 1)] }),
    ])

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
      'user',
    ])
    // The surviving group is the READ, with no write lane at all — the shape a
    // write ejected for any other reason (an error) would also produce.
    const group = collapsed[0] as CollapsedReadSearchGroup
    expect(group.readCount).toBe(1)
    expect(group.writeFileStats).toBeUndefined()
  })
})

/**
 * The sub-agent progress line. It is built from tool_uses alone (no results),
 * but it has to describe the same work as the badge above, so it counts FILES.
 */
describe('summarizeRecentActivities — write counting', () => {
  const write = (toolName: string, input: unknown) => ({
    toolName,
    input,
    isWrite: true,
  })

  test('two edits of one file are one file, not two', () => {
    expect(
      summarizeRecentActivities([
        write('Edit', { file_path: '/repo/a.ts' }),
        write('Edit', { file_path: '/repo/a.ts' }),
      ]),
    ).toBe('Editing 1 file…')
  })

  test('one apply_patch over three files is three files, not one', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: /w/a.ts',
      '+x',
      '*** Delete File: /w/b.ts',
      '*** Add File: /w/c.ts',
      '+y',
      '*** End Patch',
    ].join('\n')

    expect(
      summarizeRecentActivities([
        { toolName: 'Read', input: {}, isRead: true },
        write('apply_patch', { patchText }),
      ]),
    ).toBe('Editing 3 files, reading 1 file…')
  })

  test('a write whose files are unknowable still counts as one', () => {
    // Rename carries the symbol, not the files — they arrive with the result,
    // which this side never sees. Counting zero would erase it from the line.
    expect(
      summarizeRecentActivities([
        { toolName: 'Read', input: {}, isRead: true },
        write('Rename', { symbol: 'a', replacement: 'b', mode: 'apply' }),
      ]),
    ).toBe('Editing 1 file, reading 1 file…')
  })
})
