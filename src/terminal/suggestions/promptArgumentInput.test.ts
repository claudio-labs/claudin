import { describe, expect, test } from 'bun:test'

import { splitPromptArguments } from 'src/mcp/client/promptArguments.js'
import {
  acceptPromptArgumentValue,
  formatPromptArgumentHint,
  locatePromptArgument,
  quotePromptArgument,
} from 'src/terminal/suggestions/promptArgumentInput.js'

const NAMES = ['name', 'greeting']

function at(text: string, names: readonly string[] = NAMES) {
  return locatePromptArgument(text, text.length, names)
}

describe('locatePromptArgument', () => {
  test('nothing typed is the first argument, empty, at the cursor', () => {
    expect(at('')).toEqual({ index: 0, name: 'name', partial: '', start: 0, filled: {} })
    expect(at('   ')).toEqual({ index: 0, name: 'name', partial: '', start: 3, filled: {} })
  })

  test('a word without a trailing space is still being typed', () => {
    expect(at('Al')).toEqual({ index: 0, name: 'name', partial: 'Al', start: 0, filled: {} })
  })

  test('a trailing space finishes the argument and starts the next', () => {
    expect(at('Alice ')).toEqual({
      index: 1,
      name: 'greeting',
      partial: '',
      start: 6,
      filled: { name: 'Alice' },
    })
  })

  test('a quoted value counts as one argument, as the splitter sends it', () => {
    expect(at('"Mary Ann" Ho')).toEqual({
      index: 1,
      name: 'greeting',
      partial: 'Ho',
      start: 11,
      filled: { name: 'Mary Ann' },
    })
    expect(at("'Mary Ann' ")?.filled).toEqual({ name: 'Mary Ann' })
    expect(at('"" x')?.filled).toEqual({ name: '' })
  })

  test('a quote left open is the value being typed, spaces included', () => {
    expect(at('"Mary An')).toMatchObject({ index: 0, partial: 'Mary An', start: 0 })
    expect(at("x 'hi the")).toMatchObject({ index: 1, partial: 'hi the', start: 2 })
    expect(at('"')).toMatchObject({ index: 0, partial: '', start: 0 })
  })

  test('a closed quote at the cursor is still the argument under it', () => {
    expect(at('"Mary Ann"')).toMatchObject({ index: 0, partial: 'Mary Ann', start: 0 })
  })

  test('a quote inside a word is part of the word', () => {
    expect(at("don't st")).toMatchObject({
      index: 1,
      partial: 'st',
      start: 6,
      filled: { name: "don't" },
    })
  })

  test('only the text before the cursor counts', () => {
    expect(locatePromptArgument('Alice Bob', 3, NAMES)).toMatchObject({
      index: 0,
      partial: 'Ali',
      start: 0,
    })
  })

  test('null once every argument is typed', () => {
    expect(at('a b ')).toBeNull()
    expect(at('a b c')).toBeNull()
    expect(at('', [])).toBeNull()
  })

  test('the filled values match what the splitter sends', () => {
    const typed = `"a b" 'c d' e#1 don't `
    const names = ['w', 'x', 'y', 'z', 'next']
    expect(Object.values(at(typed, names)!.filled)).toEqual(splitPromptArguments(typed))
  })
})

describe('quotePromptArgument', () => {
  test('a plain word goes as is', () => {
    expect(quotePromptArgument('Alice')).toBe('Alice')
    expect(quotePromptArgument("don't")).toBe("don't")
  })

  test('whitespace, an empty value, or a leading quote get the quote the value lacks', () => {
    expect(quotePromptArgument('Mary Ann')).toBe('"Mary Ann"')
    expect(quotePromptArgument('')).toBe('""')
    expect(quotePromptArgument('say "hi" now')).toBe(`'say "hi" now'`)
    expect(quotePromptArgument('"quoted')).toBe(`'"quoted'`)
    expect(quotePromptArgument("'single")).toBe(`"'single"`)
  })

  test('whitespace with both quotes cannot be grouped and goes as typed', () => {
    expect(quotePromptArgument(`it's "x" y`)).toBe(`it's "x" y`)
  })
})

describe('acceptPromptArgumentValue', () => {
  test('replaces the partial and leaves a space for the next argument', () => {
    expect(acceptPromptArgumentValue('/p Al', 5, 3, 'Alice')).toEqual({
      text: '/p Alice ',
      cursor: 9,
    })
  })

  test('quotes a value with whitespace', () => {
    expect(acceptPromptArgumentValue('/p Ma', 5, 3, 'Mary Ann')).toEqual({
      text: '/p "Mary Ann" ',
      cursor: 14,
    })
  })

  test('fills an empty slot at the cursor', () => {
    expect(acceptPromptArgumentValue('/p a ', 5, 5, 'b')).toEqual({ text: '/p a b ', cursor: 7 })
  })

  test('takes the rest of the word under the cursor and keeps what follows', () => {
    expect(acceptPromptArgumentValue('/p Alice   Bob', 5, 3, 'Alicia')).toEqual({
      text: '/p Alicia Bob',
      cursor: 10,
    })
  })
})

describe('formatPromptArgumentHint', () => {
  const specs = [
    { name: 'name', required: true, description: 'Who\n  to greet' },
    { name: 'greeting', required: false },
  ]

  test('required in angle brackets, optional in square ones, then the current description', () => {
    expect(formatPromptArgumentHint(specs, 0)).toBe('<name> [greeting] · Who to greet')
  })

  test('starts at the argument being typed', () => {
    expect(formatPromptArgumentHint(specs, 1)).toBe('[greeting]')
  })

  test('nothing once every argument is typed', () => {
    expect(formatPromptArgumentHint(specs, 2)).toBeUndefined()
  })

  test('a long description is cut, a blank one is left out', () => {
    const long = formatPromptArgumentHint([{ name: 'q', required: true, description: 'x'.repeat(80) }], 0)
    expect(long).toBe(`<q> · ${'x'.repeat(59)}…`)
    expect(formatPromptArgumentHint([{ name: 'q', required: false, description: '  ' }], 0)).toBe('[q]')
  })
})
