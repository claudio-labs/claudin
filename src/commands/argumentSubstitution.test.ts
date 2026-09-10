import { describe, expect, test } from 'bun:test'

import { substituteArguments } from 'src/commands/argumentSubstitution.js'

/**
 * Slash-command arguments are user text, and user text is not a replacement
 * pattern. `String.prototype.replace`/`replaceAll` interpret `$$`, `$&`,
 * `` $` ``, `$'` and `$n` in the REPLACEMENT operand, so passing an argument
 * there spliced fragments of the prompt into itself. The indexed forms in this
 * module always used function replacers; `$ARGUMENTS` and the named arguments
 * did not.
 */
describe('substituteArguments keeps argument text literal', () => {
  test('$ARGUMENTS does not interpret $& as the matched text', () => {
    expect(substituteArguments('Search for $ARGUMENTS now', 'a$&b')).toBe(
      'Search for a$&b now',
    )
  })

  test('$ARGUMENTS does not interpret $` as the preceding text', () => {
    expect(substituteArguments('run $ARGUMENTS', 'a$`b')).toBe('run a$`b')
  })

  test('$$ in an argument stays two dollars', () => {
    expect(substituteArguments('cost: $ARGUMENTS', '$$5')).toBe('cost: $$5')
  })

  test("$' in an argument is not the following text", () => {
    expect(substituteArguments('say $ARGUMENTS end', "a$'b")).toBe(
      "say a$'b end",
    )
  })

  test('a named argument keeps $& literal', () => {
    expect(substituteArguments('query: $q', "'a$&b'", true, ['q'])).toBe(
      'query: a$&b',
    )
  })

  // Guardrails: the ordinary paths must not change.
  test('plain substitution is unchanged', () => {
    expect(substituteArguments('hello $ARGUMENTS', 'world')).toBe('hello world')
    expect(substituteArguments('a $0 b $1', 'one two')).toBe('a one b two')
    expect(substituteArguments('n: $name', 'bob', true, ['name'])).toBe('n: bob')
  })

  test('content without placeholders still gets the appended arguments', () => {
    expect(substituteArguments('do the thing', 'now')).toBe(
      'do the thing\n\nARGUMENTS: now',
    )
  })
})
