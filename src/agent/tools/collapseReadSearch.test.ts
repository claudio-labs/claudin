import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tools } from 'src/tools/Tool.js'
import type {
  CollapsedReadSearchGroup,
  RenderableMessage,
} from 'src/shared/types/message.js'
import {
  collapseReadSearchGroups,
  getSearchReadSummaryText,
  summarizeRecentActivities,
} from 'src/agent/tools/collapseReadSearch.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { thinkingSignature } from 'src/providers/shims/claude/__testutils__/thinkingSignature.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import {
  getPrivateMemPath,
  getGlobalMemPath,
  getMemoryBaseDir,
} from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'

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

/** A thinking block whose signature marks it `kind`: "narration" or "thinking". */
function thinking(kind: string, text: string): RenderableMessage {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-08-12T00:00:00.000Z',
    message: {
      role: 'assistant',
      id: uid(),
      content: [{ type: 'thinking', thinking: text, signature: thinkingSignature(kind) }],
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

describe('progress updates', () => {
  // Claude Code breaks the group on a progress update, as on text, so the
  // sentence shows where it arrived instead of after the collapsed badge.
  test('a progress update breaks the group where it arrived', () => {
    const collapsed = collapse([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      thinking('narration', 'Found it; reading the caller next.'),
      toolUse('r2', 'Read', { file_path: '/repo/b.ts' }),
      toolResult('r2', { file: {} }),
    ])

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
      'collapsed_read_search',
    ])
  })

  test('reasoning still waits behind the group without breaking it', () => {
    const collapsed = collapse([
      toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('r1', { file: {} }),
      thinking('thinking', ''),
      toolUse('r2', 'Read', { file_path: '/repo/b.ts' }),
      toolResult('r2', { file: {} }),
    ])

    expect(collapsed.map(m => m.type)).toEqual(['collapsed_read_search', 'assistant'])
  })
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

  test('Patch lists every file in the envelope, by kind', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Add File: /repo/added.ts',
      '+hello',
      '*** Delete File: /repo/gone.ts',
      '*** End Patch',
    ].join('\n')

    // Envelope only, no result yet: the rows have to come from parsing the
    // patch, so this half fails if getApplyPatchTargets stops resolving hunks.
    const pending = onlyGroup([toolUse('p0', 'Patch', { patchText })])
    expect(pending.writeFileStats).toEqual([
      { path: '/repo/added.ts', kind: 'A', additions: 0, deletions: 0 },
      { path: '/repo/gone.ts', kind: 'D', additions: 0, deletions: 0 },
    ])

    const group = onlyGroup([
      toolUse('p1', 'Patch', { patchText }),
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

    const pending = onlyGroup([toolUse('p1', 'Patch', { patchText })])
    expect(pending.writeFileStats).toBeUndefined()

    const resolved = onlyGroup([
      toolUse('p2', 'Patch', { patchText }),
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
      toolUse('p1', 'Patch', { patchText }),
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
    // 'S', not 'R': Rename rewrites a symbol inside files that keep their path,
    // so the summary says "renamed" while the ⎿ row still reads as a modify.
    expect(group.writeFileStats).toEqual([
      { path: '/repo/x.ts', kind: 'S', additions: 3, deletions: 3 },
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

describe('MCP collapse', () => {
  // What fetchCapabilities builds for a tool outside the search/read
  // whitelist (context7's query-docs): classified as neither.
  const MCP_TOOL = {
    name: 'mcp__context7__query-docs',
    isMcp: true,
    mcpInfo: { serverName: 'context7', toolName: 'query-docs' },
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
  }
  const mcpTools = [READ_TOOL, MCP_TOOL] as unknown as Tools

  test('an MCP call outside the search/read whitelist joins the group', () => {
    const collapsed = collapseReadSearchGroups(
      [
        toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
        toolResult('r1', { file: {} }),
        toolUse('m1', MCP_TOOL.name, { query: 'stacks' }),
        toolResult('m1', 'docs'),
        toolUse('m2', MCP_TOOL.name, { query: 'webhooks' }),
        toolResult('m2', 'docs'),
      ],
      mcpTools,
    )

    expect(collapsed.map(m => m.type)).toEqual(['collapsed_read_search'])
    const group = collapsed[0] as CollapsedReadSearchGroup
    expect(group.readCount).toBe(1)
    expect(group.mcpCallCount).toBe(2)
    expect(group.mcpServerNames).toEqual(['context7'])
    expect(group.latestDisplayHint).toBe('"webhooks"')
  })

  test('a failed MCP call breaks the group instead of hiding the error', () => {
    const collapsed = collapseReadSearchGroups(
      [
        toolUse('r1', 'Read', { file_path: '/repo/a.ts' }),
        toolResult('r1', { file: {} }),
        toolUse('m1', MCP_TOOL.name, { query: 'stacks' }),
        toolResult('m1', undefined, true),
      ],
      mcpTools,
    )

    expect(collapsed.map(m => m.type)).toEqual([
      'collapsed_read_search',
      'assistant',
      'user',
    ])
    expect((collapsed[0] as CollapsedReadSearchGroup).mcpCallCount).toBeUndefined()
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

  test('one Patch over three files is three files, not one', () => {
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
        write('Patch', { patchText }),
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

// CLAUDIN_READ_MULTI: one Read naming several files in `file_paths`
// (readMulti.ts). Counted by its first file_path alone it read nothing, so
// the badge fell back to counting the call.
describe('batch Read', () => {
  const PATHS = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']

  test('the badge counts and lists every file a batch names', () => {
    const group = onlyGroup([
      toolUse('rb', 'Read', { file_path: null, file_paths: PATHS }),
      toolResult('rb', { type: 'batch', files: [], notShown: [], content: '' }),
      // Stored as Codex sends a single Read under the batch-capable schema.
      toolUse('rs', 'Read', { file_path: '/repo/d.ts', file_paths: null }),
      toolResult('rs', { file: {} }),
    ])
    expect(group.readCount).toBe(4)
    expect(group.readFilePaths).toEqual([...PATHS, '/repo/d.ts'])
  })

  test('a grouped Read counts every file its batch names', () => {
    const batch = toolUse('gb1', 'Read', { file_paths: PATHS })
    const single = toolUse('gb2', 'Read', { file_path: '/repo/d.ts' })
    const grouped = {
      type: 'grouped_tool_use',
      toolName: 'Read',
      messages: [batch, single],
      results: [
        toolResult('gb1', { type: 'batch', files: [], notShown: [], content: '' }),
        toolResult('gb2', { file: {} }),
      ],
      displayMessage: batch,
      uuid: uid(),
      timestamp: '2026-08-12T00:00:00.000Z',
      messageId: 'msg-gb',
    } as unknown as RenderableMessage

    const group = onlyGroup([grouped])
    expect(group.readCount).toBe(4)
    expect(group.readFilePaths).toEqual([...PATHS, '/repo/d.ts'])
  })

  test('the progress line counts its files, while the gate counts it as one use', () => {
    const batch = {
      toolName: 'Read',
      input: { file_paths: PATHS },
      isRead: true,
      activityDescription: 'Reading 3 files: a.ts, b.ts, c.ts',
    }
    // One use alone does not start summarizing: its own description stands.
    expect(summarizeRecentActivities([batch])).toBe('Reading 3 files: a.ts, b.ts, c.ts')
    expect(
      summarizeRecentActivities([
        { toolName: 'Grep', input: { pattern: 'x' }, isSearch: true },
        batch,
      ]),
    ).toBe('Searching for 1 pattern, reading 3 files…')
    expect(
      summarizeRecentActivities([
        { toolName: 'Read', input: { file_path: '/repo/d.ts', file_paths: null }, isRead: true },
        batch,
      ]),
    ).toBe('Reading 4 files…')
  })
})

// Memory is counted per directory (memoryScopes.ts): global (~/.claudin/memory/),
// private (<repo>/.claudin/memory/) and team (its team/ subdirectory). Pinned
// against a fresh git project and config home: the real ~/.claudin is never
// resolved.
describe('memory counts per scope', () => {
  const ENV_KEYS = [
    'CLAUDIN_CONFIG_DIR',
    'CLAUDIN_DISABLE_AUTO_MEMORY',
    'CLAUDIN_GLOBAL_MEMORY',
    'CLAUDIN_SIMPLE',
    'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  ] as const
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let root: string
  let globalDir: string
  let privateDir: string
  let teamDir: string
  const dirOf = (scope: 'global' | 'private' | 'team'): string =>
    ({ global: globalDir, private: privateDir, team: teamDir })[scope]
  const SCOPES = ['global', 'private', 'team'] as const

  const GREP_TOOL = {
    name: 'Grep',
    isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  }
  const memTools = [READ_TOOL, GREP_TOOL] as unknown as Tools

  function memGroup(messages: RenderableMessage[]): CollapsedReadSearchGroup {
    const collapsed = collapseReadSearchGroups(messages, memTools)
    expect(collapsed).toHaveLength(1)
    return collapsed[0] as CollapsedReadSearchGroup
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'collapse-mem-scopes-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    globalDir = getGlobalMemPath()
    privateDir = getPrivateMemPath()
    teamDir = getTeamMemPath()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    rmSync(root, { recursive: true, force: true })
  })

  test('the fixture keeps the dirs apart, team nested in private', () => {
    expect(globalDir.startsWith(join(root, 'config'))).toBe(true)
    expect(privateDir.startsWith(join(root, 'project'))).toBe(true)
    expect(teamDir.startsWith(privateDir)).toBe(true)
  })

  for (const scope of SCOPES) {
    test(`a ${scope} memory read is a ${scope} recall, not a file`, () => {
      const group = memGroup([
        toolUse('r1', 'Read', { file_path: join(dirOf(scope), 'some-memory.md') }),
        toolResult('r1', { file: {} }),
      ])
      expect(group.memoryOps).toEqual({ [scope]: { search: 0, read: 1, write: 0 } })
      expect(group.readCount).toBe(0)
      expect(group.readFilePaths).toEqual([])
    })

    test(`a search inside the ${scope} dir is a ${scope} memory search`, () => {
      const group = memGroup([
        toolUse('s1', 'Grep', { pattern: 'x', path: join(dirOf(scope), 'sub') }),
        toolResult('s1', {}),
      ])
      expect(group.memoryOps).toEqual({ [scope]: { search: 1, read: 0, write: 0 } })
      expect(group.searchCount).toBe(0)
    })

    test(`a search over the bare ${scope} dir (no trailing slash) is a ${scope} memory search`, () => {
      const group = memGroup([
        toolUse('s1', 'Grep', { pattern: 'x', path: dirOf(scope).replace(/\/$/, '') }),
        toolResult('s1', {}),
      ])
      expect(group.memoryOps).toEqual({ [scope]: { search: 1, read: 0, write: 0 } })
      expect(group.searchCount).toBe(0)
    })

    test(`a write or edit of a ${scope} memory is a ${scope} memory write`, () => {
      const group = memGroup([
        toolUse('w1', FILE_WRITE_TOOL_NAME, {
          file_path: join(dirOf(scope), 'some-memory.md'),
          content: 'x',
        }),
        toolResult('w1', {}),
        toolUse('w2', FILE_EDIT_TOOL_NAME, {
          file_path: join(dirOf(scope), 'MEMORY.md'),
          old_string: 'a',
          new_string: 'b',
        }),
        toolResult('w2', {}),
      ])
      expect(group.memoryOps).toEqual({ [scope]: { search: 0, read: 0, write: 2 } })
      // A memory write is not a file write: no ⎿ row for it.
      expect(group.writeFileStats).toBeUndefined()
    })
  }

  const patchUse = (id: string, ...lines: string[]) =>
    toolUse(id, 'Patch', { patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })

  test('a Patch to memory files is a memory write, one per file, for the directory each lands in', () => {
    const group = memGroup([
      patchUse('p1', `*** Add File: ${join(globalDir, 'user-language.md')}`, '+---'),
      toolResult('p1', {}),
      patchUse(
        'p2',
        `*** Update File: ${join(privateDir, 'feedback-x.md')}`,
        '@@',
        '-a',
        '+b',
        `*** Update File: ${join(privateDir, 'MEMORY.md')}`,
        '@@',
        '+- [X](feedback-x.md) — hook',
      ),
      toolResult('p2', {}),
      patchUse('p3', `*** Update File: ${join(privateDir, 'project-y.md')}`, `*** Move to: ${join(teamDir, 'project-y.md')}`),
      toolResult('p3', {}),
    ])
    expect(group.memoryOps).toEqual({
      global: { search: 0, read: 0, write: 1 },
      private: { search: 0, read: 0, write: 3 },
      team: { search: 0, read: 0, write: 1 },
    })
    // A memory write is not a file write: no ⎿ row for it.
    expect(group.writeFileStats).toBeUndefined()
  })

  test('a Patch that also touches a source file stays a file write', () => {
    const memoryFile = join(privateDir, 'feedback-x.md')
    const group = memGroup([
      patchUse('p1', `*** Add File: ${memoryFile}`, '+---', '*** Add File: /repo/a.ts', '+x'),
      toolResult('p1', { files: [] }),
    ])
    expect(group.memoryOps).toBeUndefined()
    expect(group.writeFileStats?.map(s => s.path).sort()).toEqual(['/repo/a.ts', memoryFile])
  })

  test('a path under the team dir is team, not private, though it is inside both', () => {
    const file = join(teamDir, 'decisions', 'x.md')
    const group = memGroup([
      toolUse('r1', 'Read', { file_path: file }),
      toolResult('r1', { file: {} }),
      toolUse('s1', 'Grep', { pattern: 'x', path: join(teamDir, 'bugs') }),
      toolResult('s1', {}),
      toolUse('w1', FILE_WRITE_TOOL_NAME, { file_path: file, content: 'x' }),
      toolResult('w1', {}),
    ])
    expect(group.memoryOps).toEqual({ team: { search: 1, read: 1, write: 1 } })
    expect(group.memoryOps?.private).toBeUndefined()
  })

  test('scopes are counted apart in one group', () => {
    const group = memGroup([
      toolUse('g1', 'Read', { file_path: join(globalDir, 'user-language.md') }),
      toolResult('g1', { file: {} }),
      toolUse('p1', 'Read', { file_path: join(privateDir, 'feedback-x.md') }),
      toolResult('p1', { file: {} }),
      toolUse('f1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('f1', { file: {} }),
      toolUse('s1', 'Grep', { pattern: 'pt-BR', path: globalDir.replace(/\/$/, '') }),
      toolResult('s1', {}),
      toolUse('s2', 'Grep', { pattern: 'pnpm', path: privateDir }),
      toolResult('s2', {}),
      toolUse('s3', 'Grep', { pattern: 'plain', path: '/repo' }),
      toolResult('s3', {}),
    ])
    expect(group.memoryOps).toEqual({
      global: { search: 1, read: 1, write: 0 },
      private: { search: 1, read: 1, write: 0 },
    })
    // Only the non-memory operations are left in the regular counts and lists.
    expect(group.readCount).toBe(1)
    expect(group.readFilePaths).toEqual(['/repo/a.ts'])
    expect(group.searchCount).toBe(1)
    expect(group.searchArgs).toEqual(['plain'])
  })

  test('a memory file in no directory (agent memory) is counted as private', () => {
    const file = join(getMemoryBaseDir(), 'agent-memory', 'reviewer', 'notes.md')
    const group = memGroup([
      toolUse('a1', 'Read', { file_path: file }),
      toolResult('a1', { file: {} }),
    ])
    expect(group.memoryOps).toEqual({ private: { search: 0, read: 1, write: 0 } })
    expect(group.readCount).toBe(0)
  })

  test('a group without memory carries no memoryOps', () => {
    const group = memGroup([
      toolUse('f1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('f1', { file: {} }),
    ])
    expect(group.memoryOps).toBeUndefined()
  })

  test('with CLAUDIN_GLOBAL_MEMORY=0, a file in the global dir is no memory', () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    try {
      const file = join(globalDir, 'user-language.md')
      const group = memGroup([
        toolUse('o1', 'Read', { file_path: file }),
        toolResult('o1', { file: {} }),
        toolUse('o2', FILE_WRITE_TOOL_NAME, { file_path: file, content: 'x' }),
        toolResult('o2', { type: 'update', filePath: file, structuredPatch: [] }),
      ])
      expect(group.memoryOps).toBeUndefined()
      expect(group.readCount).toBe(1)
      expect(group.readFilePaths).toEqual([file])
      // The write is an ordinary file write, with its own ⎿ row.
      expect(group.writeFileStats?.map(s => s.path)).toEqual([file])
    } finally {
      delete process.env.CLAUDIN_GLOBAL_MEMORY
    }
  })
})

describe('getSearchReadSummaryText — memory', () => {
  const ops = (counts: Partial<{ search: number; read: number; write: number }>) => ({
    search: 0,
    read: 0,
    write: 0,
    ...counts,
  })

  test('each scope names its recall, search and write', () => {
    for (const scope of ['global', 'private', 'team'] as const) {
      expect(
        getSearchReadSummaryText(0, 0, false, 0, {
          [scope]: ops({ read: 1, search: 1, write: 2 }),
        }),
      ).toBe(
        `Recalled 1 ${scope} memory, searched ${scope} memories, wrote 2 ${scope} memories`,
      )
    }
  })

  test('global, private, team — general to specific, whatever the key order', () => {
    expect(
      getSearchReadSummaryText(0, 0, false, 0, {
        team: ops({ write: 1 }),
        private: ops({ search: 1, read: 1, write: 1 }),
        global: ops({ search: 1, read: 1, write: 2 }),
      }),
    ).toBe(
      'Recalled 1 global memory, searched global memories, wrote 2 global memories, recalled 1 private memory, searched private memories, wrote 1 private memory, wrote 1 team memory',
    )
  })

  test('the active tense, and memory ahead of the file parts', () => {
    expect(
      getSearchReadSummaryText(0, 0, true, 0, { global: ops({ read: 2 }) }),
    ).toBe('Recalling 2 global memories…')
    expect(
      getSearchReadSummaryText(1, 3, false, 0, { team: ops({ search: 1 }) }),
    ).toBe('Searched team memories, searched for 1 pattern, read 3 files')
  })

  test('no memoryOps, no memory parts', () => {
    expect(getSearchReadSummaryText(0, 2, false, 0, undefined)).toBe('Read 2 files')
    expect(getSearchReadSummaryText(0, 2, false, 0, {})).toBe('Read 2 files')
  })
})
