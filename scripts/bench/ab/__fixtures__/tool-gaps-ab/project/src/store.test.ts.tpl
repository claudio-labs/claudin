import { describe, expect, test } from 'bun:test'
import { ApiError, type Item, Store } from './store.ts'

const seed: Item[] = [
  { id: 'itm_10', name: 'Ten', qty: 10, tags: ['b'], updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'itm_2', name: 'Two', qty: 2, tags: ['a'], updatedAt: '2026-01-01T00:00:00.000Z' },
]

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err.code
    throw err
  }
  return undefined
}

describe('Store', () => {
  test('lists items sorted by the numeric part of the id', () => {
    expect(new Store(seed).list().map((i) => i.id)).toEqual(['itm_2', 'itm_10'])
  })

  test('create assigns the next id and normalizes fields', () => {
    const store = new Store(seed)
    const item = store.create({ name: '  Eleven ', qty: 0, tags: ['X', 'a', 'x'] })
    expect(item).toMatchObject({ id: 'itm_11', name: 'Eleven', qty: 0, tags: ['a', 'x'] })
    expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false)
  })

  test('create rejects a blank name', () => {
    expect(codeOf(() => new Store().create({ name: '   ', qty: 1 }))).toBe('invalid_name')
  })

  test('create rejects a qty that is not an integer >= 0', () => {
    const store = new Store()
    expect(codeOf(() => store.create({ name: 'a', qty: -1 }))).toBe('invalid_qty')
    expect(codeOf(() => store.create({ name: 'a', qty: 1.5 }))).toBe('invalid_qty')
    expect(codeOf(() => store.create({ name: 'a', qty: '3' }))).toBe('invalid_qty')
  })

  test('reads hand out copies', () => {
    const store = new Store(seed)
    store.get('itm_2')!.tags.push('mutated')
    expect(store.get('itm_2')!.tags).toEqual(['a'])
  })

  test('remove deletes an item', () => {
    const store = new Store(seed)
    expect(store.remove('itm_2')).toBe(true)
    expect(store.get('itm_2')).toBeUndefined()
  })
})
