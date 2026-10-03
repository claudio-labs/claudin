import { describe, expect, test } from 'bun:test'

import { createAssistantMessage } from 'src/agent/messages/messages.js'
import { readDreamTurn, writtenPaths } from 'src/memory/autoDream/run/forkMessages.js'
import {
  assistantCalls,
  humanSays,
  toolAnswers,
  type ToolUse,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import type { Message } from 'src/shared/types/message.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const MEMORY = '/home/dev/.claudin/memory/'
const isMemoryPath = (path: string) => path.startsWith(MEMORY)
const write = (path: string, id: string): ToolUse => ({ tool: FILE_WRITE_TOOL_NAME, input: { file_path: path }, id })
const edit = (path: string, id: string): ToolUse => ({ tool: FILE_EDIT_TOOL_NAME, input: { file_path: path }, id })

type Blocks = Parameters<typeof createAssistantMessage>[0]['content']

describe('readDreamTurn', () => {
  test('joins the text blocks of one message with a newline, so they do not run together (finding 4)', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'text', text: '  Done.' },
        { type: 'text', text: 'Next  ' },
      ] as unknown as Blocks,
    })
    expect(readDreamTurn(message, isMemoryPath)?.text).toBe('Done.\nNext')
  })

  test('names only the memory files it writes; a write outside memory is no memory touched (finding 2)', () => {
    const message = assistantCalls(
      write(`${MEMORY}topic.md`, 't1'),
      write('/work/shop/README.md', 't2'),
      edit(`${MEMORY}MEMORY.md`, 't3'),
      { tool: 'Read', input: { file_path: `${MEMORY}other.md` } },
    )
    expect(readDreamTurn(message, isMemoryPath)).toEqual({
      text: '',
      toolUseCount: 4,
      touchedPaths: [`${MEMORY}topic.md`, `${MEMORY}MEMORY.md`],
    })
  })

  test('is null for anything but an assistant message', () => {
    expect(readDreamTurn(humanSays('a tool result'), isMemoryPath)).toBeNull()
  })
})

describe('writtenPaths', () => {
  test('drops a path only when every call naming it came back as an error (finding 2)', () => {
    const a = `${MEMORY}a.md`
    const b = `${MEMORY}b.md`
    const c = `${MEMORY}c.md`
    const forkMessages: Message[] = [
      assistantCalls(write(a, 'a1'), write(b, 'b1'), write(c, 'c1')),
      toolAnswers('a1', 'written', false),
      toolAnswers('b1', 'permission denied', true),
      toolAnswers('c1', 'old_string not found', true),
      assistantCalls(edit(c, 'c2')),
      toolAnswers('c2', 'edited', false),
    ]
    expect(writtenPaths([a, b, c], forkMessages)).toEqual([a, c])
  })

  test('keeps a path whose call never came back, and one the fork messages do not mention', () => {
    const pending = `${MEMORY}pending.md`
    const unseen = `${MEMORY}unseen.md`
    expect(writtenPaths([pending, unseen], [assistantCalls(write(pending, 'p1'))])).toEqual([pending, unseen])
  })
})
