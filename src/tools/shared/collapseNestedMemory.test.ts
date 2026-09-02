import { describe, expect, test } from 'bun:test'
import {
  collapseNestedMemory,
  nestedMemoryBatchNoun,
} from 'src/tools/shared/collapseNestedMemory.js'
import type { RenderableMessage } from 'src/shared/types/message.js'

let counter = 0

function nestedMemory(displayPath: string): RenderableMessage {
  counter++
  return {
    type: 'attachment',
    uuid: `uuid-${counter}`,
    timestamp: `2026-09-02T00:00:0${counter}.000Z`,
    attachment: {
      type: 'nested_memory',
      path: `/repo/${displayPath}`,
      displayPath,
      content: { path: `/repo/${displayPath}`, content: 'body' },
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

function batchOf(msg: RenderableMessage): { displayPath: string }[] {
  if (msg.type !== 'attachment' || msg.attachment.type !== 'nested_memory_batch') {
    throw new Error(`expected a nested_memory_batch, got ${msg.type}`)
  }
  return msg.attachment.files
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

describe('nestedMemoryBatchNoun', () => {
  test('says "rules" when every file is under a rules directory', () => {
    expect(
      nestedMemoryBatchNoun([
        { path: '/repo/.claudin/rules/a.md', displayPath: '.claudin/rules/a.md' },
        { path: '/repo/.claudin/rules/b.md', displayPath: '.claudin/rules/b.md' },
      ]),
    ).toBe('rules')
  })

  test('falls back to "memory files" when the run is mixed', () => {
    expect(
      nestedMemoryBatchNoun([
        { path: '/repo/.claudin/rules/a.md', displayPath: '.claudin/rules/a.md' },
        { path: '/repo/pkg/CLAUDE.md', displayPath: 'pkg/CLAUDE.md' },
      ]),
    ).toBe('memory files')
  })

  test('singularizes a one-file batch', () => {
    expect(
      nestedMemoryBatchNoun([
        { path: '/repo/pkg/CLAUDE.md', displayPath: 'pkg/CLAUDE.md' },
      ]),
    ).toBe('memory file')
  })
})
