/**
 * The memory fork's permission policy beyond what the characterization
 * reaches: it is fenced to the directory it is given, which the callers
 * today always pass as the auto-memory directory.
 */
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'

import { assistantSays, nextToolUseId, useScene } from 'src/memory/extract/__testutils__/extractionHarness.js'
import {
  createAutoMemCanUseTool,
  decideMemoryForkToolUse,
  isInsideDirectory,
  type ToolUnderReview,
} from 'src/memory/extract/fork/permissions.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'

const scene = useScene()

function ask(memoryDir: string, tool: Tool, input: Record<string, unknown>) {
  return createAutoMemCanUseTool(memoryDir)(
    tool,
    input,
    {} as ToolUseContext,
    assistantSays('asking') as AssistantMessage,
    nextToolUseId(),
  )
}

describe('the directory it is given', () => {
  test('is the one writes are fenced to, even when it is not the auto-memory directory', async () => {
    const given = join(scene().root, 'consolidation-target') + sep
    const inGiven = { file_path: join(given, 'a.md'), content: 'x' }
    const inAutoMemory = { file_path: join(scene().memoryDir, 'a.md'), content: 'x' }

    expect(await ask(given, FileWriteTool, inGiven)).toStrictEqual({ behavior: 'allow', updatedInput: inGiven })
    expect(await ask(given, FileEditTool, inGiven)).toMatchObject({ behavior: 'allow' })
    expect(await ask(given, FileWriteTool, inAutoMemory)).toMatchObject({ behavior: 'deny' })
    expect(await ask(scene().memoryDir, FileWriteTool, inAutoMemory)).toMatchObject({ behavior: 'allow' })
  })

  test('is the one a denial names', async () => {
    const given = join(scene().root, 'consolidation-target') + sep
    const decision = await ask(given, FileWriteTool, { file_path: join(scene().memoryDir, 'a.md'), content: 'x' })
    expect((decision as { message: string }).message).toContain(given)
    expect((decision as { message: string }).message).not.toContain(scene().memoryDir)
  })
})

describe('isInsideDirectory', () => {
  const directory = join(sep, 'virtual-project', 'memory')

  test('a directory given without its trailing separator is still bounded by one', () => {
    expect(isInsideDirectory(join(directory, 'a.md'), directory)).toBe(true)
    expect(isInsideDirectory(`${directory}-shadow${sep}a.md`, directory)).toBe(false)
    expect(isInsideDirectory(`${directory}${sep}..${sep}memory-shadow${sep}a.md`, directory)).toBe(false)
  })

  test('only an absolute path string can be inside', () => {
    expect(isInsideDirectory(`memory${sep}a.md`, directory)).toBe(false)
    expect(isInsideDirectory(undefined, directory)).toBe(false)
    expect(isInsideDirectory({ path: join(directory, 'a.md') }, directory)).toBe(false)
  })

  test('a relative path is outside even a relative directory it seems to sit in: what it names depends on the cwd', () => {
    expect(isInsideDirectory(join('memory', 'a.md'), 'memory')).toBe(false)
  })
})

test('a Bash tool that cannot give its read-only verdict is denied, not a crash', () => {
  const broken: ToolUnderReview = {
    name: BASH_TOOL_NAME,
    inputSchema: FileWriteTool.inputSchema,
    isReadOnly: () => {
      throw new Error('the classifier fell over')
    },
  }
  const decision = decideMemoryForkToolUse(broken, { file_path: '/tmp/a', content: 'x' }, join(sep, 'memory') + sep)
  expect(decision).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/read-only/) })
})
