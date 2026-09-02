import { expect, test } from 'bun:test'

import {
  ruleNameFromFileName,
  translateCursorRule,
} from 'src/platform/import/translate/rules.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'

function expectOk(translation: ReturnType<typeof translateCursorRule>) {
  if (!translation.ok) {
    throw new Error(`expected a translation, got: ${translation.reason}`)
  }
  return translation.rule
}

test('a globs rule becomes a paths rule the loader actually scopes', () => {
  const rule = expectOk(
    translateCursorRule(
      'typescript.mdc',
      [
        '---',
        'description: TS conventions',
        'globs: src/**/*.ts,src/**/*.tsx',
        'alwaysApply: false',
        '---',
        '',
        'Use zod at boundaries.',
      ].join('\n'),
    ),
  )
  expect(rule.name).toBe('typescript')
  expect(rule.relativePath).toBe('typescript.md')
  expect(rule.paths).toEqual(['src/**/*.ts', 'src/**/*.tsx'])

  const inspection = inspectRuleFrontmatter(rule.markdown)
  expect(inspection.paths).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
})

test('the output carries NO unsupported frontmatter key, which verify:rules errors on', () => {
  const rule = expectOk(
    translateCursorRule(
      'x.mdc',
      [
        '---',
        'description: d',
        'globs:',
        '  - "**/*.py"',
        'alwaysApply: false',
        '---',
        '',
        'body',
      ].join('\n'),
    ),
  )
  const inspection = inspectRuleFrontmatter(rule.markdown)
  expect(inspection.unsupportedKeys).toEqual([])
  expect(inspection.malformedPaths).toBe(false)
})

test('the description survives in the body, since it cannot survive in frontmatter', () => {
  const rule = expectOk(
    translateCursorRule(
      'x.mdc',
      '---\ndescription: Why this exists\nglobs: "*.ts"\n---\n\nThe rule.',
    ),
  )
  const inspection = inspectRuleFrontmatter(rule.markdown)
  expect(inspection.content).toContain('Why this exists')
  expect(inspection.content).toContain('The rule.')
  expect(rule.notes.join(' ')).toContain('description moved into the body')
})

test('alwaysApply produces an unconditional rule and says what that costs', () => {
  const rule = expectOk(
    translateCursorRule('always.mdc', '---\nalwaysApply: true\n---\n\nAlways.'),
  )
  expect(rule.paths).toBeUndefined()
  expect(rule.markdown.startsWith('---')).toBe(false)
  expect(rule.notes.join(' ')).toContain('loads every turn')
  expect(inspectRuleFrontmatter(rule.markdown).unsupportedKeys).toEqual([])
})

test('alwaysApply beats globs rather than silently narrowing the rule', () => {
  const rule = expectOk(
    translateCursorRule(
      'both.mdc',
      '---\nalwaysApply: true\nglobs: "*.ts"\n---\n\nBody.',
    ),
  )
  expect(rule.paths).toBeUndefined()
  expect(rule.notes.join(' ')).toContain('overrides its globs')
})

test('an Agent Requested rule is refused, and the reason names the alternative', () => {
  const result = translateCursorRule(
    'ar.mdc',
    '---\ndescription: Use when reviewing\nalwaysApply: false\n---\n\nBody.',
  )
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('Agent Requested')
  expect(result.reason).toContain('skill')
})

test('a Manual rule is refused and named as such', () => {
  const result = translateCursorRule('m.mdc', '---\n---\n\nBody.')
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('Manual')
})

test('a nested rule path collapses into one flat rule name', () => {
  expect(ruleNameFromFileName('backend/api.mdc')).toBe('backend-api')
  expect(ruleNameFromFileName('React Rules.mdc')).toBe('react-rules')
})

test('an empty body is refused', () => {
  const result = translateCursorRule('e.mdc', '---\nalwaysApply: true\n---\n\n')
  expect(result.ok).toBe(false)
})
