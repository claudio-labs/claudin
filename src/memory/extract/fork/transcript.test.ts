/**
 * The transcript readers, over hand-built messages and a memory directory
 * that exists only as a path.
 */
import { describe, expect, test } from 'bun:test'
import { join, resolve, sep } from 'node:path'

import { createSystemMessage } from 'src/agent/messages/messages.js'
import {
  assistantCalls,
  assistantSays,
  humanSays,
  nextToolUseId,
  toolAnswers,
  type ToolUse,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { isInsideDirectory } from 'src/memory/extract/fork/permissions.js'
import {
  countExchangeMessages,
  mainAgentSavedMemory,
  messagesAfterMark,
  savedMemoryFiles,
} from 'src/memory/extract/fork/transcript.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'

const MEMORY = resolve(sep, 'virtual-project', 'memory') + sep
const ELSEWHERE = resolve(sep, 'virtual-project', 'src')

const inMemory = (...parts: string[]): string => join(MEMORY, ...parts)
const isMemoryPath = (filePath: string): boolean => isInsideDirectory(filePath, MEMORY)

function writes(path: string, id?: string): ToolUse {
  return { tool: FILE_WRITE_TOOL_NAME, input: { file_path: path, content: 'a fact' }, id }
}

function edits(path: string, id?: string): ToolUse {
  return { tool: FILE_EDIT_TOOL_NAME, input: { file_path: path, old_string: 'a', new_string: 'b' }, id }
}

describe('messagesAfterMark', () => {
  const messages = [humanSays('a'), assistantSays('b'), humanSays('c')]

  test('everything before there is a mark', () => {
    expect(messagesAfterMark(messages, undefined)).toEqual(messages)
  })

  test('what follows the marked message', () => {
    expect(messagesAfterMark(messages, messages[1]!.uuid)).toEqual([messages[2]])
    expect(messagesAfterMark(messages, messages[2]!.uuid)).toEqual([])
  })

  test('everything again once the marked message is gone', () => {
    expect(messagesAfterMark(messages, 'a-message-compaction-removed')).toEqual(messages)
  })
})

test('countExchangeMessages counts user and assistant messages, tool results included, and nothing else', () => {
  const id = nextToolUseId()
  const messages = [
    humanSays('a'),
    createSystemMessage('a notice', 'info'),
    assistantCalls({ tool: FILE_WRITE_TOOL_NAME, input: { file_path: inMemory('a.md') }, id }),
    toolAnswers(id, 'done', false),
  ]
  expect(countExchangeMessages(messages)).toBe(3)
  expect(countExchangeMessages([])).toBe(0)
})

describe('mainAgentSavedMemory', () => {
  test('an Edit or Write into the memory directory after the mark is a save; one before the mark is not', () => {
    const before = [humanSays('a'), assistantCalls(writes(inMemory('a.md'))), assistantSays('saved')]
    expect(mainAgentSavedMemory(before, undefined, isMemoryPath)).toBe(true)
    expect(mainAgentSavedMemory(before, before[2]!.uuid, isMemoryPath)).toBe(false)
    const edited = [...before, assistantCalls(edits(inMemory('a.md')))]
    expect(mainAgentSavedMemory(edited, before[2]!.uuid, isMemoryPath)).toBe(true)
  })

  test('after a compaction removed the marked message, a save among the messages left is still seen', () => {
    const compacted = [
      humanSays('summary of the work so far'),
      assistantCalls(writes(inMemory('project_release.md'))),
      assistantSays('noted'),
    ]
    expect(mainAgentSavedMemory(compacted, 'the-message-compaction-removed', isMemoryPath)).toBe(true)
  })

  test('a write elsewhere, or a call without a string path, is not a save', () => {
    const messages = [
      assistantCalls(writes(join(ELSEWHERE, 'app.ts'))),
      assistantCalls({ tool: FILE_WRITE_TOOL_NAME, input: { file_path: 42 } }),
      assistantCalls({ tool: FILE_EDIT_TOOL_NAME, input: { content: 'no path' } }),
    ]
    expect(mainAgentSavedMemory(messages, undefined, isMemoryPath)).toBe(false)
  })

  test('only Edit and Write count: Patch and NotebookEdit aimed at the memory directory go unseen', () => {
    const messages = [
      assistantCalls({ tool: APPLY_PATCH_TOOL_NAME, input: { file_path: inMemory('a.md') } }),
      assistantCalls({ tool: NOTEBOOK_EDIT_TOOL_NAME, input: { file_path: inMemory('b.md') } }),
    ]
    expect(mainAgentSavedMemory(messages, undefined, isMemoryPath)).toBe(false)
  })
})

describe('savedMemoryFiles', () => {
  test('a write whose result came back as an error, as a denied one does, was not a save', () => {
    const refused = nextToolUseId()
    const accepted = nextToolUseId()
    const messages = [
      assistantCalls(writes(inMemory('refused.md'), refused), writes(inMemory('accepted.md'), accepted)),
      toolAnswers(refused, 'Permission denied', true),
      toolAnswers(accepted, 'File written', false),
    ]
    expect(savedMemoryFiles(messages, isMemoryPath)).toEqual([inMemory('accepted.md')])
  })

  test('a path outside the memory directory is never listed, even when the call went through', () => {
    const id = nextToolUseId()
    const messages = [assistantCalls(writes(join(ELSEWHERE, 'notes.md'), id)), toolAnswers(id, 'File written', false)]
    expect(savedMemoryFiles(messages, isMemoryPath)).toEqual([])
  })

  test('a call with no result yet counts as saved', () => {
    expect(savedMemoryFiles([assistantCalls(edits(inMemory('pending.md')))], isMemoryPath)).toEqual([
      inMemory('pending.md'),
    ])
  })

  test('each file once, in the order first saved, with the indexes of every folder left out', () => {
    const messages = [
      assistantCalls(writes(inMemory('b.md')), edits(inMemory('MEMORY.md'))),
      assistantCalls(edits(inMemory('a.md')), edits(inMemory('b.md'))),
      assistantCalls(writes(inMemory('team', 'MEMORY.md')), writes(inMemory('team', 'c.md'))),
      humanSays('user messages are not calls'),
    ]
    expect(savedMemoryFiles(messages, isMemoryPath)).toEqual([
      inMemory('b.md'),
      inMemory('a.md'),
      inMemory('team', 'c.md'),
    ])
  })
})
