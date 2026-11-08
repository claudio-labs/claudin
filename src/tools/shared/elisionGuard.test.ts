import { afterEach, describe, expect, test } from 'bun:test'
import {
  elisionRefusal,
  findElisionPlaceholder,
} from 'src/tools/shared/elisionGuard.js'

const savedKillswitch = process.env.CLAUDIN_ELISION_GUARD

afterEach(() => {
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_ELISION_GUARD
  else process.env.CLAUDIN_ELISION_GUARD = savedKillswitch
})

describe('findElisionPlaceholder', () => {
  test.each([
    ['// ... existing code ...'],
    ['  // ...rest of the file'],
    ['# ... remaining methods unchanged'],
    ['-- other columns ...'],
    ['; ... same as before'],
    ['/* ... existing helpers ... */'],
    [' * ... previous cases'],
    ['<!-- ... -->'],
    ['{/* ... existing JSX ... */}'],
    ['// …'],
    ['// ...'],
    ['    # ... (omitted)'],
  ])('flags %p', line => {
    const found = findElisionPlaceholder(`function a() {\n${line}\n}`, 'function a() {\n  return 1\n}', 'a.ts')
    expect(found).toEqual({ line: 2, text: line.trim() })
  })

  test.each([
    ['// handles the remaining cases'],
    ['// Loading...'],
    ['# ... then retry'],
    ['// ellipsis... in the middle of existing prose'],
    ['const rest = { ...existing }'],
    ['  ...'],
    ["expect(out).toContain('// ... existing code ...')"],
    ['// TODO: wire the cache'],
    ['/* ... */ foo()'],
    ['/* ... existing */ foo()'],
    ['<!-- ... existing --> <div/>'],
  ])('leaves %p alone', line => {
    expect(findElisionPlaceholder(`${line}\n`, '', 'a.ts')).toBeNull()
  })

  test('a placeholder the old text already holds is kept, not flagged', () => {
    const old = 'class A {\n  // ... existing code ...\n}'
    expect(findElisionPlaceholder('class A {\n    // ... existing code ...\n  x = 1\n}', old, 'a.ts')).toBeNull()
  })

  test('a new file has no old text, so any placeholder is flagged', () => {
    expect(findElisionPlaceholder('a\n# ... rest of the script\n', '', 'run.sh')).toEqual({
      line: 2,
      text: '# ... rest of the script',
    })
  })

  test('a thunk for the old text is read only when a candidate line turns up', () => {
    let reads = 0
    const old = () => {
      reads++
      return ''
    }
    expect(findElisionPlaceholder('const a = 1\n', old, 'a.ts')).toBeNull()
    expect(reads).toBe(0)
    expect(findElisionPlaceholder('// ...\n// ... existing code ...\n', old, 'a.ts')?.line).toBe(1)
    expect(reads).toBe(1)
  })

  test('reports the first placeholder', () => {
    expect(findElisionPlaceholder('// ...\nx\n// ... existing code ...', '', 'a.ts')?.line).toBe(1)
  })

  test.each([['README.md'], ['notes.TXT'], ['docs/guide.mdx'], ['a.rst'], ['b.adoc'], ['c.org'], ['d.markdown']])(
    'never checks the prose file %p',
    path => {
      expect(findElisionPlaceholder('// ... existing code ...', '', path)).toBeNull()
    },
  )

  test('CLAUDIN_ELISION_GUARD=0 turns it off', () => {
    process.env.CLAUDIN_ELISION_GUARD = '0'
    expect(findElisionPlaceholder('// ... existing code ...', '', 'a.ts')).toBeNull()
  })

  test('CLAUDIN_ELISION_GUARD=1 keeps it on', () => {
    process.env.CLAUDIN_ELISION_GUARD = '1'
    expect(findElisionPlaceholder('// ... existing code ...', '', 'a.ts')).not.toBeNull()
  })
})

describe('elisionRefusal', () => {
  test('names where the line sits, shows it, and says how to get a literal comment through', () => {
    expect(elisionRefusal('Edit refused: new_string line 14', { line: 14, text: '// ... existing code ...' })).toBe(
      'Edit refused: new_string line 14 is an elision placeholder:\n' +
        '    // ... existing code ...\n' +
        'Edits replace text literally — this line would be written into the file and the code it stands for deleted. ' +
        'Write the full code instead. If the comment is meant literally, write it without the ellipsis.',
    )
  })
})
