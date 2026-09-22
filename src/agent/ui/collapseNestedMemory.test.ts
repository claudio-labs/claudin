import { describe, expect, test } from 'bun:test'
import {
  collapseNestedMemory,
  nestedMemoryBatchLabel,
} from 'src/agent/ui/collapseNestedMemory.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import type { RenderableMessage } from 'src/shared/types/message.js'

type BatchFile = Extract<
  Attachment,
  { type: 'nested_memory_batch' }
>['files'][number]

let counter = 0

function nestedMemory(
  displayPath: string,
  type: BatchFile['type'] = 'Project',
): RenderableMessage {
  counter++
  return {
    type: 'attachment',
    uuid: `uuid-${counter}`,
    timestamp: `2026-09-02T00:00:0${counter}.000Z`,
    attachment: {
      type: 'nested_memory',
      path: `/repo/${displayPath}`,
      displayPath,
      content: { path: `/repo/${displayPath}`, content: 'body', type },
    },
  } as RenderableMessage
}

function assistantText(text: string): RenderableMessage {
  counter++
  return {
    type: 'assistant',
    uuid: `uuid-${counter}`,
    timestamp: '2026-09-02T00:00:00.000Z',
    message: { content: [{ type: 'text', text }] },
  } as RenderableMessage
}

function batchOf(msg: RenderableMessage): BatchFile[] {
  if (msg.type !== 'attachment' || msg.attachment.type !== 'nested_memory_batch') {
    throw new Error(`expected a nested_memory_batch, got ${msg.type}`)
  }
  return msg.attachment.files
}

function file(
  displayPath: string,
  type: BatchFile['type'] = 'Project',
): BatchFile {
  return { path: `/repo/${displayPath}`, displayPath, type }
}

describe('collapseNestedMemory', () => {
  test('collapses a consecutive run into one batch, preserving order', () => {
    const messages = [
      nestedMemory('.claudin/rules/a.md'),
      nestedMemory('.claudin/rules/b.md'),
      nestedMemory('.claudin/rules/c.md'),
    ]

    const result = collapseNestedMemory(messages)

    expect(result).toHaveLength(1)
    expect(batchOf(result[0]!).map(f => f.displayPath)).toEqual([
      '.claudin/rules/a.md',
      '.claudin/rules/b.md',
      '.claudin/rules/c.md',
    ])
    expect(result[0]!.uuid).toBe(messages[0]!.uuid)
  })

  test('carries each file\'s memory type into the batch', () => {
    // The type is what the count line reads to tell "3 team bug memories"
    // from "3 rules"; the batch entry is the only thing the renderer gets.
    const result = collapseNestedMemory([
      nestedMemory('.claudin/rules/a.md', 'Project'),
      nestedMemory('.claudin/memory/team/bugs/b.md', 'TeamMem'),
    ])
    expect(batchOf(result[0]!).map(f => f.type)).toEqual(['Project', 'TeamMem'])
  })

  test('leaves a lone attachment untouched', () => {
    const messages = [nestedMemory('.claudin/rules/a.md')]
    expect(collapseNestedMemory(messages)).toEqual(messages)
  })

  test('does not merge across an intervening message', () => {
    const messages = [
      nestedMemory('.claudin/rules/a.md'),
      nestedMemory('.claudin/rules/b.md'),
      assistantText('hello'),
      nestedMemory('.claudin/rules/c.md'),
      nestedMemory('.claudin/rules/d.md'),
    ]

    const result = collapseNestedMemory(messages)

    expect(result).toHaveLength(3)
    expect(batchOf(result[0]!)).toHaveLength(2)
    expect(result[1]).toBe(messages[2]!)
    expect(batchOf(result[2]!)).toHaveLength(2)
  })

  test('passes through a message list with no nested memory', () => {
    const messages = [assistantText('a'), assistantText('b')]
    expect(collapseNestedMemory(messages)).toEqual(messages)
  })
})

describe('nestedMemoryBatchLabel', () => {
  test('counts rules when every file is under a rules directory', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/rules/a.md'),
        file('.claudin/rules/b.md'),
      ]),
    ).toBe('2 rules')
  })

  test('keeps "memory file" for a nested CLAUDE.md beside the rules', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/rules/a.md'),
        file('pkg/CLAUDE.md'),
      ]),
    ).toBe('1 rule, 1 memory file')
  })

  test('singularizes a one-file batch', () => {
    expect(nestedMemoryBatchLabel([file('pkg/CLAUDE.md')])).toBe('1 memory file')
  })

  test('a private memory is a "memory", by its type rather than its path', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/memory/a.md', 'AutoMem'),
        file('.claudin/memory/b.md', 'AutoMem'),
        file('.claudin/memory/c.md', 'AutoMem'),
      ]),
    ).toBe('3 memories')
    // A `bugs/` under the PRIVATE dir is not a team category.
    expect(nestedMemoryBatchLabel([file('.claudin/memory/bugs/x.md', 'AutoMem')])).toBe(
      '1 memory',
    )
  })

  test('a team file at the team root is a "team memory"', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/memory/team/a.md', 'TeamMem'),
        file('.claudin/memory/team/b.md', 'TeamMem'),
      ]),
    ).toBe('2 team memories')
  })

  test('a team file in a category subdirectory names the category', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/memory/team/bugs/a.md', 'TeamMem'),
        file('.claudin/memory/team/bugs/b.md', 'TeamMem'),
        file('.claudin/memory/team/bugs/c.md', 'TeamMem'),
        file('.claudin/memory/team/bugs/d.md', 'TeamMem'),
      ]),
    ).toBe('4 team bug memories')
    expect(nestedMemoryBatchLabel([file('.claudin/memory/team/bugs/a.md', 'TeamMem')])).toBe(
      '1 team bug memory',
    )
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/memory/team/decisions/a.md', 'TeamMem'),
        file('.claudin/memory/team/decisions/b.md', 'TeamMem'),
      ]),
    ).toBe('2 team decision memories')
    expect(nestedMemoryBatchLabel([file('.claudin/memory/team/docs/a.md', 'TeamMem')])).toBe(
      '1 team doc memory',
    )
  })

  test('a mixed run lists every group in a fixed order, whatever order it arrived in', () => {
    expect(
      nestedMemoryBatchLabel([
        file('.claudin/memory/team/bugs/a.md', 'TeamMem'),
        file('.claudin/rules/a.md'),
        file('.claudin/memory/team/c.md', 'TeamMem'),
        file('.claudin/memory/b.md', 'AutoMem'),
        file('.claudin/rules/b.md'),
        file('.claudin/memory/team/docs/d.md', 'TeamMem'),
      ]),
    ).toBe('2 rules, 1 memory, 1 team memory, 1 team bug memory, 1 team doc memory')
  })
})
