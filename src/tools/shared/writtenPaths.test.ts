import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { patchHeaderPaths, writtenPaths } from 'src/tools/shared/writtenPaths.js'

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

describe('writtenPaths — by input shape, not tool name', () => {
  test('a Write and an Edit write their file_path', () => {
    expect(writtenPaths({ file_path: '/m/a.md', content: 'x' }, '/')).toEqual(['/m/a.md'])
    expect(writtenPaths({ file_path: '/m/a.md', old_string: 'a', new_string: 'b' }, '/')).toEqual(['/m/a.md'])
    // An empty text is still a write: a Write that empties the file, an Edit that deletes
    expect(writtenPaths({ file_path: '/m/a.md', content: '' }, '/')).toEqual(['/m/a.md'])
    expect(writtenPaths({ file_path: '/m/a.md', old_string: 'a', new_string: '' }, '/')).toEqual(['/m/a.md'])
  })

  test('a file_path alone, or with a read’s fields, is a read', () => {
    expect(writtenPaths({ file_path: '/m/a.md' }, '/')).toEqual([])
    expect(writtenPaths({ file_path: '/m/a.md', offset: 1, limit: 2 }, '/')).toEqual([])
    expect(writtenPaths({ file_path: 42, content: 'x' }, '/')).toEqual([])
  })

  test('a Patch writes every path its headers name: Add, Update, Delete, and both sides of a Move', () => {
    const text = patch(
      '*** Add File: /m/new.md',
      '+---',
      '*** Update File: /m/edited.md',
      '@@',
      '-a',
      '+b',
      '*** Delete File: /m/gone.md',
      '*** Update File: /m/old-name.md',
      '*** Move to: /g/new-name.md',
      '@@',
      ' x',
    )
    expect(writtenPaths({ patchText: text }, '/')).toEqual([
      '/m/new.md',
      '/m/edited.md',
      '/m/gone.md',
      '/m/old-name.md',
      '/g/new-name.md',
    ])
  })

  test('a line a Patch adds that looks like a header is not one', () => {
    expect(writtenPaths({ patchText: patch('*** Add File: /m/a.md', '+*** Add File: /m/b.md') }, '/')).toEqual(['/m/a.md'])
  })

  test('a path named twice is listed once', () => {
    const text = patch('*** Update File: /m/a.md', '@@', '-a', '+b', '*** Update File: /m/a.md', '@@', '-c', '+d')
    expect(writtenPaths({ patchText: text }, '/')).toEqual(['/m/a.md'])
  })

  test('a relative path resolves against cwd, `~` against home, CRLF and spaces trimmed', () => {
    expect(writtenPaths({ file_path: 'notes/a.md', content: 'x' }, '/repo')).toEqual(['/repo/notes/a.md'])
    expect(writtenPaths({ patchText: patch('*** Add File: .claudin/memory/a.md\r', '+x') }, '/repo')).toEqual([
      '/repo/.claudin/memory/a.md',
    ])
    expect(writtenPaths({ patchText: patch('*** Update File: ~/.claudin/memory/a.md  ', '*** Move to: b.md') }, '/repo')).toEqual([
      join(homedir(), '.claudin/memory/a.md'),
      '/repo/b.md',
    ])
  })

  test('anything else writes nothing', () => {
    for (const input of [null, undefined, 'x', 42, {}, { command: 'echo x > /m/a.md' }, { patchText: 'not a patch' }]) {
      expect(writtenPaths(input, '/')).toEqual([])
    }
    // A null byte is refused by the tool, and named by none
    expect(writtenPaths({ file_path: '/m/a\0.md', content: 'x' }, '/')).toEqual([])
  })
})

describe('patchHeaderPaths', () => {
  test('the paths as written, in order, from a patch that would not parse too', () => {
    expect(patchHeaderPaths('*** Update File: a.md\n*** Move to: b.md\n*** Delete File: c.md')).toEqual(['a.md', 'b.md', 'c.md'])
    expect(patchHeaderPaths('*** Add File: \n*** Add File:x.md')).toEqual([])
    // Padding is trimmed, and a header naming only spaces names nothing
    expect(patchHeaderPaths('*** Add File:   \n*** Update File:  a.md  ')).toEqual(['a.md'])
  })
})
