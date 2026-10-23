import { describe, expect, test } from 'bun:test'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parsePositiveIntFromFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from 'src/shared/frontmatterParser.js'

describe('parseFrontmatter — delimiters', () => {
  test('markdown without frontmatter comes back whole, with an empty frontmatter', () => {
    const md = '# Title\n\nname: not frontmatter\n'
    expect(parseFrontmatter(md)).toEqual({ frontmatter: {}, content: md })
  })

  test('a block that does not start the file is not frontmatter', () => {
    const md = '\n---\nname: x\n---\nbody'
    expect(parseFrontmatter(md)).toEqual({ frontmatter: {}, content: md })
  })

  test('the frontmatter is parsed and the content starts after the closing line', () => {
    const md = '---\nname: reviewer\ndescription: Reviews diffs\n---\nBody line\nmore\n'
    expect(parseFrontmatter(md)).toEqual({
      frontmatter: { name: 'reviewer', description: 'Reviews diffs' },
      content: 'Body line\nmore\n',
    })
  })

  test('trailing whitespace on the delimiter lines is tolerated', () => {
    const md = '---  \nname: x\n---   \nbody'
    expect(parseFrontmatter(md)).toEqual({ frontmatter: { name: 'x' }, content: 'body' })
  })

  test('a closing delimiter at end of file, with no newline, still closes', () => {
    expect(parseFrontmatter('---\nname: x\n---')).toEqual({
      frontmatter: { name: 'x' },
      content: '',
    })
  })

  test('an empty frontmatter block parses to an empty object', () => {
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ frontmatter: {}, content: 'body' })
  })

  test('only the first block is frontmatter; a later --- line stays in the content', () => {
    const md = '---\nname: x\n---\nintro\n---\nname: y\n---\n'
    const { frontmatter, content } = parseFrontmatter(md)
    expect(frontmatter).toEqual({ name: 'x' })
    expect(content).toBe('intro\n---\nname: y\n---\n')
  })
})

describe('parseFrontmatter — values', () => {
  test('YAML lists, numbers, booleans and nested maps keep their YAML types', () => {
    const md = [
      '---',
      'allowed-tools:',
      '  - Read',
      '  - Grep',
      'maxTurns: 5',
      'user-invocable: true',
      'hooks:',
      '  Stop:',
      '    - matcher: x',
      '---',
      '',
    ].join('\n')
    // Widened: YAML hands back whatever the text says, not the declared field types.
    const frontmatter: Record<string, unknown> = parseFrontmatter(md).frontmatter
    expect(frontmatter).toEqual({
      'allowed-tools': ['Read', 'Grep'],
      maxTurns: 5,
      'user-invocable': true,
      hooks: { Stop: [{ matcher: 'x' }] },
    })
  })

  test('a key with nothing after it is null', () => {
    expect(parseFrontmatter('---\nmodel:\n---\n').frontmatter).toEqual({ model: null })
  })

  test('colons that are not followed by a space stay plain (times, URLs)', () => {
    const md = '---\ntime: 12:34\nurl: https://x.y/z\n---\n'
    expect(parseFrontmatter(md).frontmatter).toEqual({ time: '12:34', url: 'https://x.y/z' })
  })

  test('a frontmatter that is a YAML list is discarded, the content is kept', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\nbody')).toEqual({
      frontmatter: {},
      content: 'body',
    })
  })

  test('a frontmatter that is a bare scalar is discarded', () => {
    expect(parseFrontmatter('---\njust text\n---\nbody')).toEqual({
      frontmatter: {},
      content: 'body',
    })
  })
})

describe('parseFrontmatter — quoting fallback after a YAML error', () => {
  test('a glob that starts with * (a YAML alias) is read as a string', () => {
    const md = '---\npaths: **/*.{ts,tsx}\n---\nbody'
    expect(parseFrontmatter(md)).toEqual({
      frontmatter: { paths: '**/*.{ts,tsx}' },
      content: 'body',
    })
  })

  test('a ": " in the middle of a value is read as part of the value', () => {
    const md = '---\ndescription: Use when: the user asks\n---\n'
    expect(parseFrontmatter(md).frontmatter).toEqual({ description: 'Use when: the user asks' })
  })

  test('a value that looks like two flow sequences is read as a string', () => {
    const md = '---\nargument-hint: [file] [mode]\n---\n'
    expect(parseFrontmatter(md).frontmatter).toEqual({ 'argument-hint': '[file] [mode]' })
  })

  test('values starting with & or @ are read as strings', () => {
    const md = '---\nname: & anchor\ndescription: @mention someone\n---\n'
    expect(parseFrontmatter(md).frontmatter).toEqual({
      name: '& anchor',
      description: '@mention someone',
    })
  })

  test('double quotes and backslashes inside a re-quoted value survive', () => {
    const md = '---\ndescription: Use when: say "hi" at c:\\dir\n---\n'
    expect(parseFrontmatter(md).frontmatter).toEqual({
      description: 'Use when: say "hi" at c:\\dir',
    })
  })

  test('already-quoted values are left alone while a sibling line is re-quoted', () => {
    const md = [
      '---',
      'name: "double: quoted"',
      "title: 'single: quoted'",
      'paths: **/*.ts',
      '---',
      '',
    ].join('\n')
    expect(parseFrontmatter(md).frontmatter).toEqual({
      name: 'double: quoted',
      title: 'single: quoted',
      paths: '**/*.ts',
    })
  })

  test('plain lines and indented list items pass through the fallback unchanged', () => {
    const md = [
      '---',
      'name: plain',
      'paths: **/*.ts',
      'allowed-tools:',
      '  - Read',
      '  - Grep',
      '---',
      '',
    ].join('\n')
    expect(parseFrontmatter(md).frontmatter).toEqual({
      name: 'plain',
      paths: '**/*.ts',
      'allowed-tools': ['Read', 'Grep'],
    })
  })

  test('a frontmatter the fallback cannot repair parses to an empty object', () => {
    const md = '---\na: b\n  c: d\n---\nbody'
    expect(parseFrontmatter(md, '/x/SKILL.md')).toEqual({ frontmatter: {}, content: 'body' })
  })

  test('an unclosed flow sequence is not repaired by quoting either', () => {
    expect(parseFrontmatter('---\nkey: [unclosed\n  more\n---\nbody')).toEqual({
      frontmatter: {},
      content: 'body',
    })
  })
})

describe('splitPathInFrontmatter', () => {
  test('splits on commas and trims each part', () => {
    expect(splitPathInFrontmatter('a,  b ,c')).toEqual(['a', 'b', 'c'])
  })

  test('drops empty and whitespace-only parts', () => {
    expect(splitPathInFrontmatter('a,, ,b,')).toEqual(['a', 'b'])
    expect(splitPathInFrontmatter('')).toEqual([])
    expect(splitPathInFrontmatter('   ')).toEqual([])
  })

  test('a single pattern with no braces comes back as-is', () => {
    expect(splitPathInFrontmatter('src/**/*.ts')).toEqual(['src/**/*.ts'])
  })

  test('commas inside braces do not split, and the braces expand', () => {
    expect(splitPathInFrontmatter('a, src/*.{ts,tsx}')).toEqual(['a', 'src/*.ts', 'src/*.tsx'])
    expect(splitPathInFrontmatter('src/{a,b}.ts, lib')).toEqual(['src/a.ts', 'src/b.ts', 'lib'])
  })

  test('two sibling brace groups expand to their cross product, in order', () => {
    expect(splitPathInFrontmatter('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d'])
  })

  test('alternatives are trimmed', () => {
    expect(splitPathInFrontmatter('src/*.{ ts , tsx }')).toEqual(['src/*.ts', 'src/*.tsx'])
  })

  test('a brace group with one alternative just drops the braces', () => {
    expect(splitPathInFrontmatter('src/{lib}/x.ts')).toEqual(['src/lib/x.ts'])
  })

  test('a YAML list is split and expanded element by element', () => {
    expect(splitPathInFrontmatter(['a', 'src/*.{ts,tsx}', 'b, c'])).toEqual([
      'a',
      'src/*.ts',
      'src/*.tsx',
      'b',
      'c',
    ])
  })

  test('a non-string value yields no patterns', () => {
    expect(splitPathInFrontmatter(42 as unknown as string)).toEqual([])
    expect(splitPathInFrontmatter([null, 'a'] as unknown as string[])).toEqual(['a'])
  })
})

describe('parsePositiveIntFromFrontmatter', () => {
  test('absent values are undefined', () => {
    expect(parsePositiveIntFromFrontmatter(undefined)).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter(null)).toBeUndefined()
  })

  test('positive integers, as numbers or strings, are returned', () => {
    expect(parsePositiveIntFromFrontmatter(5)).toBe(5)
    expect(parsePositiveIntFromFrontmatter('7')).toBe(7)
    expect(parsePositiveIntFromFrontmatter(' 12 ')).toBe(12)
  })

  test('zero, negatives, fractions and non-numbers are rejected', () => {
    expect(parsePositiveIntFromFrontmatter(0)).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter('0')).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter(-3)).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter('-3')).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter(2.5)).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter('abc')).toBeUndefined()
    expect(parsePositiveIntFromFrontmatter(true)).toBeUndefined()
  })

  test('a string goes through parseInt, so a numeric prefix wins', () => {
    expect(parsePositiveIntFromFrontmatter('2.9')).toBe(2)
    expect(parsePositiveIntFromFrontmatter('12abc')).toBe(12)
  })
})

describe('coerceDescriptionToString', () => {
  test('null and undefined are null', () => {
    expect(coerceDescriptionToString(null)).toBeNull()
    expect(coerceDescriptionToString(undefined)).toBeNull()
  })

  test('strings are trimmed; an empty or blank string is null', () => {
    expect(coerceDescriptionToString('  does a thing  ')).toBe('does a thing')
    expect(coerceDescriptionToString('')).toBeNull()
    expect(coerceDescriptionToString(' \n\t ')).toBeNull()
  })

  test('numbers and booleans are stringified', () => {
    expect(coerceDescriptionToString(42)).toBe('42')
    expect(coerceDescriptionToString(0)).toBe('0')
    expect(coerceDescriptionToString(false)).toBe('false')
  })

  test('arrays and objects are omitted', () => {
    expect(coerceDescriptionToString(['a', 'b'], 'skill')).toBeNull()
    expect(coerceDescriptionToString({ a: 1 }, 'skill', 'plugin')).toBeNull()
    expect(coerceDescriptionToString({})).toBeNull()
  })
})

describe('parseBooleanFrontmatter', () => {
  test('only literal true and the string "true" are true', () => {
    expect(parseBooleanFrontmatter(true)).toBe(true)
    expect(parseBooleanFrontmatter('true')).toBe(true)
    for (const v of ['TRUE', 'True', 'yes', '1', 1, false, 'false', null, undefined, '']) {
      expect(parseBooleanFrontmatter(v)).toBe(false)
    }
  })
})

describe('parseShellFrontmatter', () => {
  test('absent, null and blank values are undefined', () => {
    expect(parseShellFrontmatter(undefined, 'x.md')).toBeUndefined()
    expect(parseShellFrontmatter(null, 'x.md')).toBeUndefined()
    expect(parseShellFrontmatter('', 'x.md')).toBeUndefined()
    expect(parseShellFrontmatter('   ', 'x.md')).toBeUndefined()
  })

  test('bash and powershell are accepted, trimmed and case-folded', () => {
    expect(parseShellFrontmatter('bash', 'x.md')).toBe('bash')
    expect(parseShellFrontmatter(' PowerShell ', 'x.md')).toBe('powershell')
    expect(parseShellFrontmatter('BASH', 'x.md')).toBe('bash')
  })

  test('an unknown shell falls back to undefined (the caller defaults to bash)', () => {
    expect(parseShellFrontmatter('zsh', 'x.md')).toBeUndefined()
    expect(parseShellFrontmatter('pwsh', 'x.md')).toBeUndefined()
    expect(parseShellFrontmatter(1, 'x.md')).toBeUndefined()
  })
})
