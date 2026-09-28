/**
 * Characterization of `src/memory/instructions/ruleFrontmatter.ts`: what the
 * rule loader, the rules linter and path-scoped memories learn from the
 * frontmatter of a rule file. Pure string in, record out; two of the inputs
 * are real files under `__fixtures__/rewrite/`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { inspectRuleFrontmatter, RULE_FRONTMATTER_SUPPORTED_KEYS } from 'src/memory/instructions/ruleFrontmatter.js'

const fixture = (name: string): string => readFileSync(join(import.meta.dir, '__fixtures__', 'rewrite', name), 'utf8')

/** A rule file whose frontmatter is the YAML given, over a one-line body. */
const ruleWith = (yaml: string): string => `---\n${yaml}\n---\nKeep handlers small.\n`

const scopeOf = (yaml: string): string[] | undefined => inspectRuleFrontmatter(ruleWith(yaml)).paths

describe('RULE_FRONTMATTER_SUPPORTED_KEYS', () => {
  test('paths is the one key a rule may set', () => {
    expect([...RULE_FRONTMATTER_SUPPORTED_KEYS]).toEqual(['paths'])
  })
})

describe('inspectRuleFrontmatter: real rule files', () => {
  const HANDLERS_BODY = 'Conventions for the HTTP handlers\n\nHandlers validate input before touching storage.\n'

  test('a rule the Cursor import wrote: a scoped rule with a YAML list of paths', () => {
    expect(inspectRuleFrontmatter(fixture('scoped-rule.md'))).toEqual({
      content: HANDLERS_BODY,
      paths: ['server/**/*.ts', 'server/**/*.tsx', 'docs/api'],
      unsupportedKeys: [],
      malformedPaths: false,
    })
  })

  test('the same rule with CRLF line endings', () => {
    const inspected = inspectRuleFrontmatter(fixture('scoped-rule.md').replaceAll('\n', '\r\n'))
    expect(inspected.paths).toEqual(['server/**/*.ts', 'server/**/*.tsx', 'docs/api'])
    expect(inspected.content).toBe(HANDLERS_BODY.replaceAll('\n', '\r\n'))
  })

  test('a Cursor rule copied in unconverted: every key is ignored and the rule applies everywhere', () => {
    expect(inspectRuleFrontmatter(fixture('cursor-rule.md'))).toEqual({
      content: 'Handlers validate input before touching storage.\n',
      unsupportedKeys: ['description', 'globs', 'alwaysApply'],
      malformedPaths: false,
    })
  })
})

describe('inspectRuleFrontmatter: the patterns of a scoped rule', () => {
  test('a single pattern', () => {
    expect(scopeOf('paths: src/**/*.ts')).toEqual(['src/**/*.ts'])
  })

  test('a comma-separated string: parts are trimmed and empty ones dropped', () => {
    expect(scopeOf('paths: "  src/**/*.ts  ,  lib  ,, "')).toEqual(['src/**/*.ts', 'lib'])
  })

  test('braces expand, every group of them, and a comma inside braces does not split', () => {
    expect(scopeOf('paths: "lib/*.{ts,tsx}, {api,web}/{a,b}.md"')).toEqual(['lib/*.ts', 'lib/*.tsx', 'api/a.md', 'api/b.md', 'web/a.md', 'web/b.md'])
  })

  test('a YAML list, whose entries are split and expanded the same way', () => {
    expect(scopeOf('paths:\n  - "cli, sdk"\n  - docs/*.{md,txt}')).toEqual(['cli', 'sdk', 'docs/*.md', 'docs/*.txt'])
  })

  test('one trailing /** is removed from each pattern', () => {
    expect(scopeOf('paths: "src/**, a/**/**, b/**/*.md"')).toEqual(['src', 'a/**', 'b/**/*.md'])
  })

  test('a pattern that is only /** disappears', () => {
    expect(scopeOf('paths: "/**, docs"')).toEqual(['docs'])
  })

  test('a match-all ** next to a narrower pattern is kept', () => {
    expect(scopeOf('paths: "src/**, **"')).toEqual(['src', '**'])
  })

  test('an unquoted pattern that starts with * still parses', () => {
    expect(scopeOf('paths: **/*.test.ts')).toEqual(['**/*.test.ts'])
  })
})

describe('inspectRuleFrontmatter: rules that apply everywhere', () => {
  const EVERYWHERE = { content: 'Keep handlers small.\n', unsupportedKeys: [], malformedPaths: false }

  test('a file without frontmatter is all content', () => {
    const text = '# Style\n\npaths: not frontmatter here\n'
    expect(inspectRuleFrontmatter(text)).toEqual({ content: text, unsupportedKeys: [], malformedPaths: false })
  })

  test('frontmatter must open on the very first line', () => {
    const text = '\n---\npaths: src\n---\nKeep handlers small.\n'
    const inspected = inspectRuleFrontmatter(text)
    expect(inspected.paths).toBeUndefined()
    expect(inspected.content).toBe(text)
  })

  test('an empty string, an empty list or a bare `paths:`', () => {
    for (const yaml of ['paths: ""', 'paths: []', 'paths:']) expect(inspectRuleFrontmatter(ruleWith(yaml))).toEqual(EVERYWHERE)
  })

  test('patterns that all match everything once /** is gone', () => {
    for (const yaml of ['paths: "**"', 'paths: "**/**"', 'paths: "**, /**, **/**"']) expect(inspectRuleFrontmatter(ruleWith(yaml))).toEqual(EVERYWHERE)
  })

  test('an empty frontmatter block', () => {
    expect(inspectRuleFrontmatter('---\n---\nKeep handlers small.\n')).toEqual(EVERYWHERE)
  })

  test('frontmatter that is not YAML: no keys at all, and the body after the closing line', () => {
    expect(inspectRuleFrontmatter('---\npaths: [src\nglobs: : :\n  - a\n---\nKeep handlers small.\n')).toEqual(EVERYWHERE)
  })
})

describe('inspectRuleFrontmatter: a paths value of the wrong shape', () => {
  test('a number, zero, a boolean or a mapping is malformed, and the rule applies everywhere', () => {
    for (const yaml of ['paths: 5', 'paths: 0', 'paths: false', 'paths: true', 'paths:\n  src: yes']) {
      const inspected = inspectRuleFrontmatter(ruleWith(yaml))
      expect(inspected.malformedPaths).toBe(true)
      expect(inspected.paths).toBeUndefined()
    }
  })

  test('a list holding a non-string is malformed, and its strings still scope the rule', () => {
    const inspected = inspectRuleFrontmatter(ruleWith('paths:\n  - src\n  - 3\n  - lib/**'))
    expect(inspected.malformedPaths).toBe(true)
    expect(inspected.paths).toEqual(['src', 'lib'])
  })

  test('a string, a list of strings, an empty value or no key at all is well formed', () => {
    for (const yaml of ['paths: src', 'paths: [a, b]', 'paths:', 'other: 1']) expect(inspectRuleFrontmatter(ruleWith(yaml)).malformedPaths).toBe(false)
  })
})

describe('inspectRuleFrontmatter: keys the loader ignores', () => {
  test('every key but paths, in the order written, a key without a value included', () => {
    const inspected = inspectRuleFrontmatter(ruleWith('globs:\ndescription: API rules\npaths: src\nalwaysApply: true'))
    expect(inspected.unsupportedKeys).toEqual(['globs', 'description', 'alwaysApply'])
    expect(inspected.paths).toEqual(['src'])
  })

  test('key names are case-sensitive: Paths is ignored, and so the rule applies everywhere', () => {
    const inspected = inspectRuleFrontmatter(ruleWith('Paths: src'))
    expect(inspected.unsupportedKeys).toEqual(['Paths'])
    expect(inspected.paths).toBeUndefined()
  })
})

describe('inspectRuleFrontmatter: the content', () => {
  test('is the text after the frontmatter as written, whether the rule is scoped or not', () => {
    const body = 'First line.\n\n   indented later\t\nLast line without newline'
    expect(inspectRuleFrontmatter(`---\npaths: src\n---\n${body}`).content).toBe(body)
    expect(inspectRuleFrontmatter(`---\nglobs: src\n---\n${body}`).content).toBe(body)
  })

  test('blank lines between the frontmatter and the first text are not part of it', () => {
    expect(inspectRuleFrontmatter('---\npaths: src\n---\n\n\nFirst line.\n').content).toBe('First line.\n')
  })
})
