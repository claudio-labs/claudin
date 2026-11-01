import { describe, expect, test } from 'bun:test'
import { editedFile } from 'src/tools/FileEditTool/utils.js'

// What an Edit leaves, for the memory write notes (FileEditTool advise): the
// same matching validateInput and call() do, so a note sizes the real result.
describe('editedFile', () => {
  test('one occurrence is replaced, every one under replace_all; several without it apply nowhere', () => {
    expect(editedFile('x y\n', 'x', 'z', false)).toBe('z y\n')
    expect(editedFile('x y x\n', 'x', 'z', true)).toBe('z y z\n')
    expect(editedFile('x y x\n', 'x', 'z', false)).toBeNull()
    expect(editedFile('x y\n', 'q', 'z', false)).toBeNull()
    expect(editedFile('x y\n', 'x', '$&$&', false)).toBe('$&$& y\n')
  })

  test('a curly-quoted file matches straight quotes and keeps its style', () => {
    expect(editedFile('say \u201chi\u201d\n', 'say "hi"', 'say "bye"', false)).toBe('say \u201cbye\u201d\n')
  })

  test('trailing whitespace the model dropped still matches, by the whitespace-tolerant pass', () => {
    expect(editedFile('a  \nb\nz\n', 'a\nb', 'a\nc', false)).toBe('a\nc\nz\n')
  })

  test('deleting a line takes its newline along, as call() does', () => {
    expect(editedFile('a\nb\nc\n', 'b', '', false)).toBe('a\nc\n')
  })
})
