/**
 * The pure matcher and the search-pattern views, driven with explicit anchors:
 * no session state, no disk, no HOME. The characterization suites cover the
 * same behaviour through the barrel; these pin what they cannot reach (the
 * Windows drive anchor) and the fix decisions at the matcher level.
 */
import { describe, expect, test } from 'bun:test'

import type { PermissionRule, PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import type { RuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'
import { findCoveringRule } from 'src/permissions/filePermissions/fileRules/ruleMatcher.js'
import type { FileRule, RuleBehavior } from 'src/permissions/filePermissions/fileRules/ruleSelection.js'
import {
  patternsByAnchor,
  patternsForSearchRoot,
} from 'src/permissions/filePermissions/fileRules/searchPatterns.js'

const ANCHORS: RuleAnchors = {
  currentDir: '/work/project/pkg',
  startingDir: '/work/project',
  homeDir: '/home/me',
  configHomeDir: '/home/me/.claudin',
  settingsFileDir: '/etc/claudin',
  windows: false,
}

function ruleOf(text: string, source: PermissionRuleSource = 'session', behavior: RuleBehavior = 'deny'): FileRule {
  const rule: PermissionRule = {
    source,
    ruleBehavior: behavior,
    ruleValue: { toolName: 'Read', ruleContent: text },
  }
  return { rule, text }
}

function hit(path: string, rules: FileRule[], behavior: RuleBehavior = 'deny', anchors = ANCHORS): string | null {
  const found = findCoveringRule(path, rules, anchors, behavior)
  return found === null ? null : `${found.source} ${found.ruleValue.ruleContent}`
}

describe('anchors per source', () => {
  const rows: { source: PermissionRuleSource; covers: string; misses: string }[] = [
    { source: 'userSettings', covers: '/home/me/.claudin/v/a', misses: '/work/project/v/a' },
    { source: 'flagSettings', covers: '/etc/claudin/v/a', misses: '/work/project/v/a' },
    { source: 'projectSettings', covers: '/work/project/v/a', misses: '/home/me/.claudin/v/a' },
    { source: 'localSettings', covers: '/work/project/v/a', misses: '/etc/claudin/v/a' },
    { source: 'policySettings', covers: '/work/project/v/a', misses: '/etc/claudin/v/a' },
    { source: 'cliArg', covers: '/work/project/v/a', misses: '/work/project/pkg/v/a' },
    { source: 'command', covers: '/work/project/v/a', misses: '/work/project/pkg/v/a' },
    { source: 'session', covers: '/work/project/v/a', misses: '/work/project/pkg/v/a' },
  ]
  for (const row of rows) {
    test(`a / rule from ${row.source}`, () => {
      const rules = [ruleOf('/v/**', row.source)]
      expect([hit(row.covers, rules), hit(row.misses, rules)]).toEqual([`${row.source} /v/**`, null])
    })
  }

  test('~/, //, ./ and bare patterns', () => {
    expect(hit('/home/me/.ssh/id', [ruleOf('~/.ssh/**')])).toBe('session ~/.ssh/**')
    expect(hit('/etc/passwd', [ruleOf('//etc/**')])).toBe('session //etc/**')
    expect(hit('/work/project/pkg/.env', [ruleOf('./.env')])).toBe('session ./.env')
    expect(hit('/work/project/.env', [ruleOf('./.env')])).toBeNull()
  })
})

describe('F1: the whole anchor', () => {
  const rows: { text: string; path: string }[] = [
    { text: '/**', path: '/work/project/src/a.ts' },
    { text: '//**', path: '/var/anything' },
    { text: '~/**', path: '/home/me/notes/today.md' },
  ]
  for (const row of rows) {
    test(`${row.text} covers everything below its anchor for deny and ask, nothing for allow`, () => {
      const seen = (['deny', 'ask', 'allow'] as const).map(b => hit(row.path, [ruleOf(row.text, 'session', b)], b))
      expect(seen).toEqual([`session ${row.text}`, `session ${row.text}`, null])
    })
  }

  test('the anchor itself stays uncovered', () => {
    expect(hit('/home/me', [ruleOf('~/**')])).toBeNull()
  })
})

describe('F3: paths at or above an anchor answer null instead of throwing', () => {
  const rows: { text: string; path: string }[] = [
    { text: '*.pem', path: '/work/project' },
    { text: '/v/**', path: '/work' },
    { text: '~/.ssh/**', path: '/home' },
    { text: '**', path: '/' },
  ]
  for (const row of rows) {
    test(`${row.text} at ${row.path}`, () => {
      for (const behavior of ['deny', 'ask', 'allow'] as const) {
        expect(() => findCoveringRule(row.path, [ruleOf(row.text, 'session', behavior)], ANCHORS, behavior)).not.toThrow()
        expect(hit(row.path, [ruleOf(row.text, 'session', behavior)], behavior)).toBeNull()
      }
    })
  }
})

describe('several rules', () => {
  test('a later ! line exempts across sources sharing the anchor', () => {
    const rules = [ruleOf('*.pem', 'projectSettings'), ruleOf('!public.pem', 'session')]
    expect(hit('/work/project/pkg/keys/public.pem', rules)).toBeNull()
    expect(hit('/work/project/pkg/keys/private.pem', rules)).toBe('projectSettings *.pem')
  })

  test('the reported rule is the last positive line that matches', () => {
    const rules = [ruleOf('*.pem'), ruleOf('id*')]
    expect(hit('/work/project/pkg/id.pem', rules)).toBe('session id*')
  })

  test('the same text from two sources keeps both anchors', () => {
    const rules = [ruleOf('/v/**', 'userSettings'), ruleOf('/v/**', 'session')]
    expect(hit('/home/me/.claudin/v/a', rules)).toBe('userSettings /v/**')
    expect(hit('/work/project/v/a', rules)).toBe('session /v/**')
  })
})

describe('Windows', () => {
  const windows: RuleAnchors = {
    ...ANCHORS,
    currentDir: 'C:\\work\\project',
    startingDir: 'C:\\work\\project',
    homeDir: 'C:\\Users\\me',
    windows: true,
  }

  test('//c/... is anchored at drive C:, and backslash paths are matched in POSIX form', () => {
    const rules = [ruleOf('//c/Secrets/**')]
    expect(hit('C:\\Secrets\\key.txt', rules, 'deny', windows)).toBe('session //c/Secrets/**')
    expect(hit('D:\\Secrets\\key.txt', rules, 'deny', windows)).toBeNull()
  })

  test('a path on another drive is outside an anchor and does not throw', () => {
    expect(hit('D:\\work\\project\\a.pem', [ruleOf('*.pem')], 'deny', windows)).toBeNull()
    expect(hit('C:\\work\\project\\a.pem', [ruleOf('*.pem')], 'deny', windows)).toBe('session *.pem')
  })

  test('the search key for //c/ is the drive root', () => {
    expect([...patternsByAnchor([ruleOf('//c/Secrets/**')], windows).entries()]).toEqual([['C:\\', ['/Secrets/**']]])
  })
})

describe('patternsForSearchRoot, beyond the characterized cases', () => {
  const rows: { name: string; byRoot: [string | null, string[]][]; root: string; expected: string[] }[] = [
    {
      name: 'a pattern naming the search root itself hides the whole search',
      byRoot: [['/', ['/repo']]],
      root: '/repo',
      expected: ['/**'],
    },
    {
      name: 'a pattern that reaches every depth below the anchor reaches the root too',
      byRoot: [['/', ['/**', '/**/id_rsa']]],
      root: '/repo',
      expected: ['/**', '/**/id_rsa'],
    },
    {
      name: 'an anchored pattern written without its leading slash is treated as anchored',
      byRoot: [['/repo/pkg', ['dist/**']]],
      root: '/repo',
      expected: ['/pkg/dist/**'],
    },
  ]
  for (const row of rows) {
    test(row.name, () => {
      expect(patternsForSearchRoot(new Map(row.byRoot), row.root)).toEqual(row.expected)
    })
  }
})
