import { describe, expect, test } from 'bun:test'

import { spliceMessageByUuid } from './QueryEngine.js'
import type { Message } from 'src/types/message.js'

// Covers the tombstone case in QueryEngine.submitMessage: the failed
// streaming attempt's partial must be dropped from mutableMessages and the
// recorded slice by uuid — reference equality misses, because query.ts
// yields a backfilled CLONE of each assistant message while tombstoning the
// original object. (The disk half of the tombstone is covered by
// sessionStorage/__tests__/project.test.ts "wins over a pending queued
// insert".)

function msg(uuid: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: { id: uuid, role: 'assistant', content: [] },
  } as unknown as Message
}

describe('spliceMessageByUuid', () => {
  test('removes a backfilled clone with the tombstoned uuid (no reference match)', () => {
    const original = msg('uuid-partial')
    const clone = { ...original } // what query.ts actually yields
    const history = [msg('uuid-a'), clone, msg('uuid-b')]

    expect(spliceMessageByUuid(history, original.uuid)).toBe(true)
    expect(history.map(m => m.uuid) as string[]).toEqual(['uuid-a', 'uuid-b'])
  })

  test('removes the LAST occurrence (the partial is the most recent)', () => {
    // Defensive: uuids should be unique, but if a replayed/duplicated entry
    // exists, the partial being tombstoned is the most recently appended.
    const history = [msg('uuid-x'), msg('uuid-a'), msg('uuid-x')]
    const lastRef = history[2]

    expect(spliceMessageByUuid(history, 'uuid-x')).toBe(true)
    expect(history).toHaveLength(2)
    expect(history.includes(lastRef!)).toBe(false)
    expect(history[0]!.uuid as string).toBe('uuid-x')
  })

  test('no-ops (returns false) when the uuid is absent', () => {
    const history = [msg('uuid-a')]
    expect(spliceMessageByUuid(history, 'uuid-missing')).toBe(false)
    expect(history).toHaveLength(1)
  })
})
