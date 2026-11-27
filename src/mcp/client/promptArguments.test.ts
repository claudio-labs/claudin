import { describe, expect, test } from 'bun:test'
import { splitPromptArguments } from 'src/mcp/client/promptArguments.js'

describe('splitPromptArguments', () => {
  test('splits on whitespace, any amount', () => {
    expect(splitPromptArguments('a b')).toEqual(['a', 'b'])
    expect(splitPromptArguments('  a \t  b  ')).toEqual(['a', 'b'])
  })

  test('a word that opens with a quote runs to the matching one', () => {
    expect(splitPromptArguments('src/a.ts "error handling"')).toEqual(['src/a.ts', 'error handling'])
    expect(splitPromptArguments("src/a.ts 'error handling'")).toEqual(['src/a.ts', 'error handling'])
    expect(splitPromptArguments('"it\'s fine" next')).toEqual(["it's fine", 'next'])
    expect(splitPromptArguments('"" b')).toEqual(['', 'b'])
  })

  test('nothing else is syntax', () => {
    expect(splitPromptArguments('#123 src/*.ts x>1 y|z a;b $HOME C:\\Users\\me regex\\d+')).toEqual([
      '#123',
      'src/*.ts',
      'x>1',
      'y|z',
      'a;b',
      '$HOME',
      'C:\\Users\\me',
      'regex\\d+',
    ])
  })

  test('a quote inside a word, or one never closed, is part of the word', () => {
    expect(splitPromptArguments("don't stop")).toEqual(["don't", 'stop'])
    expect(splitPromptArguments('a"b c"')).toEqual(['a"b', 'c"'])
    expect(splitPromptArguments('"open ended')).toEqual(['"open', 'ended'])
  })

  test('an empty line is one empty argument', () => {
    expect(splitPromptArguments('')).toEqual([''])
    expect(splitPromptArguments('   ')).toEqual([''])
  })
})
