/**
 * The decisions the characterization suite leaves free on purpose (spec,
 * findings 4 and 5), and the turns already handed out staying as they were.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createUserMessage } from 'src/agent/messages/messages.js'
import type { Message } from 'src/shared/types/message.js'
import { hostHook, stopAllHooks } from 'src/vcs/diff/hooks/__testutils__/hookHost.js'
import { applyToolResultToTurn, type TurnDiff, useTurnDiffs } from 'src/vcs/diff/hooks/useTurnDiffs.js'
import { getPatchFromContents } from 'src/vcs/git/diff.js'

afterEach(() => stopAllHooks())

const blankTurn = (): TurnDiff => ({
  turnIndex: 1,
  userPromptPreview: '',
  timestamp: '',
  files: new Map(),
  stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
})

describe('a created file counts the lines it has (finding 4)', () => {
  const cases = [
    { content: 'a\nb\n', lines: ['+a', '+b'] },
    { content: 'a\nb', lines: ['+a', '+b'] },
    { content: '\n', lines: ['+'] },
    { content: 'one\r\ntwo\r\n', lines: ['+one\r', '+two\r'] },
  ]
  for (const row of cases) {
    test(`${JSON.stringify(row.content)} adds ${row.lines.length} line(s)`, () => {
      const turn = blankTurn()
      applyToolResultToTurn(turn, { type: 'create', filePath: '/w/new.ts', content: row.content, structuredPatch: [] })
      expect(turn.files.get('/w/new.ts')).toEqual({
        filePath: '/w/new.ts',
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: row.lines.length, lines: row.lines }],
        isNewFile: true,
        linesAdded: row.lines.length,
        linesRemoved: 0,
      })
      expect(turn.stats).toEqual({ filesChanged: 1, linesAdded: row.lines.length, linesRemoved: 0 })
    })
  }

  test('an empty created file is listed as new, with no hunk and no line', () => {
    const turn = blankTurn()
    applyToolResultToTurn(turn, { type: 'create', filePath: '/w/empty.ts', content: '', structuredPatch: [] })
    expect(turn.files.get('/w/empty.ts')).toEqual({
      filePath: '/w/empty.ts',
      hunks: [],
      isNewFile: true,
      linesAdded: 0,
      linesRemoved: 0,
    })
  })
})

let serial = 0
const prompt = (text: string): Message => createUserMessage({ content: text })
function edit(filePath: string): Message {
  serial += 1
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: `toolu_fix_${serial}`, content: 'ok' }],
    toolUseResult: { filePath, structuredPatch: getPatchFromContents({ filePath, oldContent: 'x', newContent: 'y' }) },
  })
}

const outline = (turns: TurnDiff[]) => turns.map(turn => [turn.turnIndex, turn.userPromptPreview, [...turn.files.keys()]])

describe('a replaced transcript is read again from the start (finding 5)', () => {
  const replacements = [
    {
      name: 'a different list of the same length',
      before: [prompt('old one'), edit('/w/old.ts')],
      after: [prompt('new one'), edit('/w/new.ts')],
      turns: [[1, 'new one', ['/w/new.ts']]],
    },
    {
      name: 'a longer list that does not start with what was read (a compaction)',
      before: [prompt('old one'), edit('/w/old.ts'), prompt('old two'), edit('/w/old2.ts')],
      after: [prompt('summary'), edit('/w/a.ts'), prompt('next'), edit('/w/b.ts'), prompt('last'), edit('/w/c.ts')],
      turns: [
        [3, 'last', ['/w/c.ts']],
        [2, 'next', ['/w/b.ts']],
        [1, 'summary', ['/w/a.ts']],
      ],
    },
  ]
  for (const row of replacements) {
    test(row.name, async () => {
      const host = await hostHook((messages: Message[]) => useTurnDiffs(messages), row.before)
      host.rerender(row.after)
      expect(outline(host.current())).toEqual(row.turns)
    })
  }
})

test('turns handed out earlier do not change as the transcript grows', async () => {
  const start = [prompt('go'), edit('/w/a.ts')]
  const host = await hostHook((messages: Message[]) => useTurnDiffs(messages), start)
  const [earlier] = host.current()

  host.rerender([...start, edit('/w/b.ts')])
  expect([...earlier!.files.keys()]).toEqual(['/w/a.ts'])
  expect(earlier!.stats.filesChanged).toBe(1)
  expect([...host.current()[0]!.files.keys()]).toEqual(['/w/a.ts', '/w/b.ts'])
})
