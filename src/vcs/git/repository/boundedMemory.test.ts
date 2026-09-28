import { describe, expect, test } from 'bun:test'
import { BoundedMemory, rememberLookups } from 'src/vcs/git/repository/boundedMemory.js'

describe('BoundedMemory', () => {
  test('once full it forgets the least recently used entry, and reading counts as use', () => {
    const memory = new BoundedMemory<string, number>(2)
    memory.set('a', 1)
    memory.set('b', 2)
    expect(memory.get('a')).toBe(1)
    memory.set('c', 3)
    expect([memory.has('a'), memory.has('b'), memory.has('c')]).toEqual([true, false, true])
    expect(memory.size).toBe(2)
  })

  test('setting a known key refreshes it instead of adding a second entry', () => {
    const memory = new BoundedMemory<string, number>(2)
    memory.set('a', 1)
    memory.set('b', 2)
    memory.set('a', 10)
    memory.set('c', 3)
    expect(memory.get('a')).toBe(10)
    expect(memory.has('b')).toBe(false)
  })

  test('null is a value it keeps; delete and clear forget', () => {
    const memory = new BoundedMemory<string, string | null>(4)
    memory.set('none', null)
    expect(memory.has('none')).toBe(true)
    expect(memory.get('none')).toBeNull()
    expect(memory.delete('none')).toBe(true)
    expect(memory.get('none')).toBeUndefined()
    memory.set('x', 'y')
    memory.clear()
    expect(memory.size).toBe(0)
  })
})

describe('rememberLookups', () => {
  test('asks once per key, null answers included, until the key is forgotten', () => {
    const asked: string[] = []
    const lookup = rememberLookups((key: string) => {
      asked.push(key)
      return key === 'nothing' ? null : key.toUpperCase()
    }, 8)
    expect([lookup('nothing'), lookup('nothing'), lookup('some'), lookup('some')]).toEqual([
      null,
      null,
      'SOME',
      'SOME',
    ])
    expect(asked).toEqual(['nothing', 'some'])
    lookup.cache.delete('nothing')
    lookup('nothing')
    lookup.cache.clear()
    lookup('some')
    expect(asked).toEqual(['nothing', 'some', 'nothing', 'some'])
  })
})
