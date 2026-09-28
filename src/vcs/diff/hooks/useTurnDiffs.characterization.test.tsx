/**
 * Characterization of `useTurnDiffs`, the per-turn sources of the /diff
 * reviewer: which files each user prompt's tools changed, read from the
 * transcript the REPL hands it.
 *
 * Transcripts are built with the real message factories, and every patch is a
 * real one computed from before/after texts. The texts never end with a
 * newline: how a created file's final newline is counted is a defect this
 * suite leaves free (see the spec, finding 4).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import type { Message } from 'src/shared/types/message.js'
import { hostHook, stopAllHooks } from 'src/vcs/diff/hooks/__testutils__/hookHost.js'
import { type TurnDiff, type TurnFileDiff, useTurnDiffs } from 'src/vcs/diff/hooks/useTurnDiffs.js'
import { getPatchFromContents } from 'src/vcs/git/diff.js'

afterEach(() => stopAllHooks())

let tick = Date.parse('2026-09-28T09:00:00.000Z')
const nextStamp = (): string => new Date((tick += 1_000)).toISOString()
let toolUseSerial = 0

function prompt(text: string): Message {
  return createUserMessage({ content: text, timestamp: nextStamp() })
}

function toolReturned(result: unknown): Message {
  toolUseSerial += 1
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: `toolu_${toolUseSerial}`, content: 'ok' }],
    toolUseResult: result,
    timestamp: nextStamp(),
  })
}

function patchOf(filePath: string, before: string, after: string): StructuredPatchHunk[] {
  return getPatchFromContents({ filePath, oldContent: before, newContent: after })
}

/** What the edit tool reports. */
function edited(filePath: string, before: string, after: string) {
  return {
    filePath,
    oldString: before,
    newString: after,
    originalFile: before,
    structuredPatch: patchOf(filePath, before, after),
    userModified: false,
    replaceAll: false,
  }
}

/** What the write tool reports for a new file. */
function created(filePath: string, content: string) {
  return { type: 'create', filePath, content, structuredPatch: [], originalFile: null }
}

/** What the write tool reports for an existing file. */
function overwritten(filePath: string, before: string, after: string) {
  return {
    type: 'update',
    filePath,
    content: after,
    structuredPatch: patchOf(filePath, before, after),
    originalFile: before,
  }
}

type PatchEntry = {
  absPath: string
  type: 'add' | 'update' | 'delete' | 'move'
  movePath?: string
  before: string
  after: string
}

/** What the apply-patch tool reports: one entry per file it touched. */
function patched(entries: PatchEntry[]) {
  return {
    files: entries.map(entry => {
      const structuredPatch = patchOf(entry.absPath, entry.before, entry.after)
      const { added, removed } = tally(structuredPatch)
      return {
        absPath: entry.absPath,
        type: entry.type,
        ...(entry.movePath ? { movePath: entry.movePath } : {}),
        additions: added,
        deletions: removed,
        structuredPatch,
      }
    }),
  }
}

function tally(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
  const lines = hunks.flatMap(hunk => hunk.lines)
  return {
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
  }
}

function fileEntry(
  filePath: string,
  hunks: StructuredPatchHunk[],
  isNewFile = false,
): TurnFileDiff {
  const { added, removed } = tally(hunks)
  return { filePath, hunks, isNewFile, linesAdded: added, linesRemoved: removed }
}

/** A turn reduced to what a table can state: number, and per file +/-. */
function outline(turns: TurnDiff[]): Array<{ turn: number; files: string[] }> {
  return turns.map(turn => ({
    turn: turn.turnIndex,
    files: [...turn.files.values()].map(
      f => `${f.filePath} +${f.linesAdded} -${f.linesRemoved}${f.isNewFile ? ' new' : ''}`,
    ),
  }))
}

async function turnsOf(messages: Message[]): Promise<TurnDiff[]> {
  const host = await hostHook((m: Message[]) => useTurnDiffs(m), messages)
  return host.current()
}

const LIB = 'export const one = 1\nexport const two = 2\nexport const three = 3'
const LIB_EDITED = 'export const one = 1\nexport const two = 22\nexport const three = 3'

describe('what counts as a turn with changes', () => {
  test('one prompt and one edit: the whole turn record', async () => {
    const ask = prompt('fix the typo')
    const edit = edited('/w/lib.ts', LIB, LIB_EDITED)
    const turns = await turnsOf([ask, createAssistantMessage({ content: 'on it' }), toolReturned(edit)])

    expect(turns).toEqual([
      {
        turnIndex: 1,
        userPromptPreview: 'fix the typo',
        timestamp: ask.timestamp,
        files: new Map([['/w/lib.ts', fileEntry('/w/lib.ts', edit.structuredPatch)]]),
        stats: { filesChanged: 1, linesAdded: 1, linesRemoved: 1 },
      },
    ])
  })

  const nothingToShow: Array<{ name: string; messages: () => Message[] }> = [
    { name: 'an empty transcript', messages: () => [] },
    { name: 'a conversation with no tools', messages: () => [prompt('hi'), createAssistantMessage({ content: 'hello' })] },
    {
      name: 'tools that change no file',
      messages: () => [prompt('run it'), toolReturned({ stdout: 'ok', stderr: '', interrupted: false })],
    },
    {
      name: 'an edit whose patch is empty',
      messages: () => [prompt('noop'), toolReturned({ ...edited('/w/a.ts', 'same', 'same'), structuredPatch: [] })],
    },
    {
      name: 'a path with neither a patch nor created content',
      messages: () => [prompt('odd'), toolReturned({ filePath: '/w/a.ts', type: 'update', structuredPatch: [] })],
    },
    {
      name: 'an apply-patch result with no files',
      messages: () => [prompt('empty patch'), toolReturned({ files: [] })],
    },
    {
      name: 'an apply-patch result where one entry is malformed',
      messages: () => [
        prompt('bad patch'),
        toolReturned({
          files: [
            ...patched([{ absPath: '/w/a.ts', type: 'update', before: 'a', after: 'b' }]).files,
            { absPath: '/w/b.ts', type: 'update' },
          ],
        }),
      ],
    },
    {
      name: 'an edit before the first prompt',
      messages: () => [toolReturned(edited('/w/a.ts', 'a', 'b')), createAssistantMessage({ content: 'done' })],
    },
  ]

  for (const row of nothingToShow) {
    test(`no turns for ${row.name}`, async () => {
      expect(await turnsOf(row.messages())).toEqual([])
    })
  }

  test('newest first, numbered by every prompt whether or not it changed files', async () => {
    const turns = await turnsOf([
      prompt('first'),
      toolReturned(edited('/w/a.ts', 'a', 'A')),
      prompt('second, no edits'),
      createAssistantMessage({ content: 'nothing to do' }),
      prompt('third'),
      toolReturned(edited('/w/b.ts', 'b', 'B')),
      prompt('fourth, no edits'),
    ])

    expect(outline(turns)).toEqual([
      { turn: 3, files: ['/w/b.ts +1 -1'] },
      { turn: 1, files: ['/w/a.ts +1 -1'] },
    ])
    expect(turns.map(turn => turn.userPromptPreview)).toEqual(['third', 'first'])
  })

  /** `previews` lists each resulting turn's prompt preview, newest first. */
  const turnBoundaries: Array<{
    name: string
    between: () => Message
    turns: number[]
    previews: string[]
  }> = [
    {
      name: 'a meta user message does not start a turn',
      between: () => createUserMessage({ content: 'reminder', isMeta: true, timestamp: nextStamp() }),
      turns: [1],
      previews: ['go'],
    },
    {
      name: 'a tool_result message without a tool result object does not start a turn',
      between: () =>
        createUserMessage({
          content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'failed', is_error: true }],
          timestamp: nextStamp(),
        }),
      turns: [1],
      previews: ['go'],
    },
    {
      name: 'a system message does not start a turn',
      between: () => createSystemMessage('compacting', 'info'),
      turns: [1],
      previews: ['go'],
    },
    {
      name: 'an interruption notice does start one, with an empty preview',
      between: () => createUserInterruptionMessage({ toolUse: false }),
      turns: [2, 1],
      previews: ['', 'go'],
    },
  ]

  for (const row of turnBoundaries) {
    test(row.name, async () => {
      const turns = await turnsOf([
        prompt('go'),
        toolReturned(edited('/w/a.ts', 'a', 'A')),
        row.between(),
        toolReturned(edited('/w/b.ts', 'b', 'B')),
      ])
      expect(turns.map(turn => turn.turnIndex)).toEqual(row.turns)
      expect(turns.map(turn => turn.userPromptPreview)).toEqual(row.previews)
      expect(turns.flatMap(turn => [...turn.files.keys()]).sort()).toEqual(['/w/a.ts', '/w/b.ts'])
    })
  }
})

describe('the files of a turn', () => {
  test('edits to one file pile up in order; files keep first-touch order; stats add up', async () => {
    const first = edited('/w/z.ts', 'z1\nz2\nz3', 'z1\nZ2\nz3')
    const second = edited('/w/a.ts', 'a1', 'a1\na2\na3')
    const third = edited('/w/z.ts', 'z1\nZ2\nz3', 'Z1\nZ2')
    const [turn] = await turnsOf([prompt('go'), toolReturned(first), toolReturned(second), toolReturned(third)])

    expect([...turn!.files.keys()]).toEqual(['/w/z.ts', '/w/a.ts'])
    expect(turn!.files.get('/w/z.ts')).toEqual(
      fileEntry('/w/z.ts', [...first.structuredPatch, ...third.structuredPatch]),
    )
    expect(turn!.files.get('/w/a.ts')).toEqual(fileEntry('/w/a.ts', second.structuredPatch))
    const perFile = [...turn!.files.values()]
    expect(turn!.stats).toEqual({
      filesChanged: 2,
      linesAdded: perFile.reduce((sum, f) => sum + f.linesAdded, 0),
      linesRemoved: perFile.reduce((sum, f) => sum + f.linesRemoved, 0),
    })
  })

  test('a created file is one all-added hunk numbered from line 1', async () => {
    const [turn] = await turnsOf([prompt('make it'), toolReturned(created('/w/new.ts', 'alpha\nbeta\ngamma'))])

    expect(turn!.files.get('/w/new.ts')).toEqual({
      filePath: '/w/new.ts',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+alpha', '+beta', '+gamma'] }],
      isNewFile: true,
      linesAdded: 3,
      linesRemoved: 0,
    })
    expect(turn!.stats).toEqual({ filesChanged: 1, linesAdded: 3, linesRemoved: 0 })
  })

  test('a file created and then edited in the same turn is still new', async () => {
    const edit = edited('/w/new.ts', 'alpha\nbeta', 'alpha\nBETA')
    const [turn] = await turnsOf([
      prompt('make it'),
      toolReturned(created('/w/new.ts', 'alpha\nbeta')),
      toolReturned(edit),
    ])

    const entry = turn!.files.get('/w/new.ts')!
    expect(entry.isNewFile).toBe(true)
    expect(entry.hunks.slice(1)).toEqual(edit.structuredPatch)
    expect([entry.linesAdded, entry.linesRemoved]).toEqual([3, 1])
  })

  test('a write over an existing file uses its patch and is not new', async () => {
    const write = overwritten('/w/cfg.json', '{\n  "a": 1\n}', '{\n  "a": 2\n}')
    const [turn] = await turnsOf([prompt('bump'), toolReturned(write)])

    expect(turn!.files.get('/w/cfg.json')).toEqual(fileEntry('/w/cfg.json', write.structuredPatch))
  })

  test('an apply-patch result fans out per file, and a move is filed under its destination', async () => {
    const result = patched([
      { absPath: '/w/added.ts', type: 'add', before: '', after: 'x\ny' },
      { absPath: '/w/changed.ts', type: 'update', before: 'a\nb', after: 'a\nB' },
      { absPath: '/w/gone.ts', type: 'delete', before: 'p\nq\nr', after: '' },
      { absPath: '/w/old-name.ts', type: 'move', movePath: '/w/new-name.ts', before: 'm', after: 'M' },
      { absPath: '/w/unmoved.ts', type: 'move', before: 'u', after: 'U' },
    ])
    const [turn] = await turnsOf([prompt('apply'), toolReturned(result)])

    expect(outline([turn!])).toEqual([
      {
        turn: 1,
        files: [
          '/w/added.ts +2 -0 new',
          '/w/changed.ts +1 -1',
          '/w/gone.ts +0 -3',
          '/w/new-name.ts +1 -1',
          '/w/unmoved.ts +1 -1',
        ],
      },
    ])
    expect(turn!.files.get('/w/new-name.ts')!.hunks).toEqual(result.files[3]!.structuredPatch)
  })

  test('an apply-patch that touches a file an edit already touched adds to it', async () => {
    const edit = edited('/w/a.ts', 'a\nb\nc', 'a\nB\nc')
    const result = patched([{ absPath: '/w/a.ts', type: 'update', before: 'a\nB\nc', after: 'a\nB\nC\nd' }])
    const [turn] = await turnsOf([prompt('go'), toolReturned(edit), toolReturned(result)])

    expect(turn!.files.get('/w/a.ts')).toEqual(
      fileEntry('/w/a.ts', [...edit.structuredPatch, ...result.files[0]!.structuredPatch]),
    )
  })
})

describe('the prompt preview', () => {
  const previews = [
    { text: 'short', preview: 'short' },
    { text: 'x'.repeat(30), preview: 'x'.repeat(30) },
    { text: `${'y'.repeat(29)}zz`, preview: `${'y'.repeat(29)}…` },
    { text: 'rename the helper and update every caller', preview: 'rename the helper and update …' },
  ]

  for (const row of previews) {
    test(`${row.text.length} characters preview as ${row.preview.length}`, async () => {
      const [turn] = await turnsOf([prompt(row.text), toolReturned(edited('/w/a.ts', 'a', 'b'))])
      expect(turn!.userPromptPreview).toBe(row.preview)
    })
  }
})

describe('as the transcript grows', () => {
  test('appended messages extend the running turn and add new ones', async () => {
    const start = [prompt('one'), toolReturned(edited('/w/a.ts', 'a', 'A'))]
    const host = await hostHook((m: Message[]) => useTurnDiffs(m), start)
    expect(outline(host.current())).toEqual([{ turn: 1, files: ['/w/a.ts +1 -1'] }])

    const more = [...start, toolReturned(edited('/w/b.ts', 'b', 'B\nb2'))]
    host.rerender(more)
    expect(outline(host.current())).toEqual([{ turn: 1, files: ['/w/a.ts +1 -1', '/w/b.ts +2 -1'] }])
    expect(host.current()[0]!.stats).toEqual({ filesChanged: 2, linesAdded: 3, linesRemoved: 2 })

    const later = [...more, prompt('two'), toolReturned(created('/w/c.ts', 'c'))]
    host.rerender(later)
    expect(outline(host.current())).toEqual([
      { turn: 2, files: ['/w/c.ts +1 -0 new'] },
      { turn: 1, files: ['/w/a.ts +1 -1', '/w/b.ts +2 -1'] },
    ])

    host.rerender([...later])
    expect(outline(host.current())).toHaveLength(2)
  })

  test('a shorter transcript (a rewind) is read again from the start', async () => {
    const full = [
      prompt('one'),
      toolReturned(edited('/w/a.ts', 'a', 'A')),
      prompt('two'),
      toolReturned(edited('/w/b.ts', 'b', 'B')),
      prompt('three'),
      toolReturned(edited('/w/c.ts', 'c', 'C')),
    ]
    const host = await hostHook((m: Message[]) => useTurnDiffs(m), full)
    expect(host.current().map(turn => turn.turnIndex)).toEqual([3, 2, 1])

    const rewound = [prompt('again'), toolReturned(edited('/w/d.ts', 'd', 'D'))]
    host.rerender(rewound)
    expect(outline(host.current())).toEqual([{ turn: 1, files: ['/w/d.ts +1 -1'] }])
    expect(host.current()[0]!.userPromptPreview).toBe('again')
  })
})
