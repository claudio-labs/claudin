/**
 * The decisions the shellRules rewrite applied on top of the characterized
 * behaviour (spec findings 1, 2, 3 and 6), plus the matcher's compiled-pattern
 * bound. Each test fails on the pre-rewrite behaviour.
 */
import { describe, expect, test } from 'bun:test'
import {
  findDangerousClassifierPermissions,
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { matchWildcardPattern } from 'src/permissions/shellRuleMatching.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Lists = Partial<Record<PermissionRuleSource, string[]>>

function context(allow: Lists, extra: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: allow,
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...extra,
  }
}

describe('finding 1: a non-canonical spelling is stripped on a mid-session switch into auto', () => {
  const spellings = ['Bash(*)', 'Bash()', 'Task', 'Task(x)', 'PowerShell(*)', 'Agent(*)']
  for (const typed of spellings) {
    test(`${typed} leaves the list and is stashed as typed`, () => {
      const after = stripDangerousPermissionsForAutoMode(context({ cliArg: [typed, 'Bash(ls)'] }))
      expect(after.alwaysAllowRules.cliArg).toEqual(['Bash(ls)'])
      expect(after.strippedDangerousRules).toEqual({ cliArg: [typed] })
    })
  }

  test('the round trip puts back the spelling that was taken, once', () => {
    const start = context({ cliArg: ['Bash(*)', 'Task(x)', 'Read'] })
    const back = restoreDangerousPermissions(stripDangerousPermissionsForAutoMode(start))
    expect(back.alwaysAllowRules.cliArg).toEqual(['Read', 'Bash(*)', 'Task(x)'])
  })

  test('removal of a finding matches every spelling of the same rule', () => {
    const after = removeDangerousPermissions(
      context({ session: ['Bash', 'Bash(*)', 'Bash()', 'Agent(Explore)', 'Task(Explore)', 'Bash(ls)'] }),
      [
        { ruleValue: { toolName: 'Bash' }, source: 'session', ruleDisplay: 'Bash(*)', sourceDisplay: 'session' },
        {
          ruleValue: { toolName: 'Task', ruleContent: 'Explore' },
          source: 'session',
          ruleDisplay: 'Task(Explore)',
          sourceDisplay: 'session',
        },
      ],
    )
    expect(after.alwaysAllowRules.session).toEqual(['Bash(ls)'])
  })

  test('the startup scan removes an entry already canonicalized in the context', () => {
    // Startup stores `Bash(*)` as `Bash`; the scan reports it as typed.
    const findings = findDangerousClassifierPermissions([], ['Bash(*)', 'Task(Explore)'])
    const after = removeDangerousPermissions(context({ cliArg: ['Bash', 'Agent(Explore)', 'Read'] }), findings)
    expect(after.alwaysAllowRules.cliArg).toEqual(['Read'])
  })
})

describe('finding 2: a second strip adds to the stash instead of replacing it', () => {
  test('rules stripped earlier survive a strip that finds new ones', () => {
    const after = stripDangerousPermissionsForAutoMode(
      context(
        { session: ['Bash(node *)', 'Bash(ls)'] },
        { strippedDangerousRules: { localSettings: ['Bash(python:*)'] } },
      ),
    )
    expect(after.strippedDangerousRules).toEqual({
      localSettings: ['Bash(python:*)'],
      session: ['Bash(node *)'],
    })
  })

  test('within one source the new strings follow the kept ones, without repeats', () => {
    const after = stripDangerousPermissionsForAutoMode(
      context(
        { session: ['Bash(sudo:*)', 'Bash(node *)'] },
        { strippedDangerousRules: { session: ['Bash(node *)'] } },
      ),
    )
    expect(after.strippedDangerousRules).toEqual({ session: ['Bash(node *)', 'Bash(sudo:*)'] })
  })

  test('two strips then one restore give back every rule', () => {
    const first = stripDangerousPermissionsForAutoMode(context({ localSettings: ['Bash(python:*)'] }))
    const readded = { ...first, alwaysAllowRules: { ...first.alwaysAllowRules, session: ['Agent'] } }
    const back = restoreDangerousPermissions(stripDangerousPermissionsForAutoMode(readded))
    expect(back.alwaysAllowRules).toEqual({ localSettings: ['Bash(python:*)'], session: ['Agent'] })
  })
})

describe('finding 3: leaving auto mode skips rules already present', () => {
  test('a rule re-added while in auto mode is not listed twice', () => {
    const out = restoreDangerousPermissions(
      context({ session: ['Bash(python:*)'] }, { strippedDangerousRules: { session: ['Bash(python:*)', 'Agent'] } }),
    )
    expect(out.alwaysAllowRules.session).toEqual(['Bash(python:*)', 'Agent'])
  })

  test('duplicates the user already had are left alone', () => {
    const out = restoreDangerousPermissions(
      context({ session: ['Read', 'Read'] }, { strippedDangerousRules: { session: ['Agent'] } }),
    )
    expect(out.alwaysAllowRules.session).toEqual(['Read', 'Read', 'Agent'])
  })
})

describe('finding 6: an --allowed-tools entry with ")" in its body is scanned', () => {
  const rows: Array<[entry: string, toolName: string, ruleContent: string]> = [
    ['Agent(a(b))', 'Agent', 'a(b)'],
    // The form startup hands over after canonicalizing the entry.
    ['Agent(a\\(b\\))', 'Agent', 'a(b)'],
    ['Task(x(y))', 'Agent', 'x(y)'],
    ['Bash(python -c print(1):*)', 'Bash', 'python -c print(1):*'],
  ]
  for (const [entry, toolName, ruleContent] of rows) {
    test(`${entry} is read with the permission-check parser`, () => {
      const found = findDangerousClassifierPermissions([], [entry])
      expect(found).toEqual([
        { ruleValue: { toolName, ruleContent }, source: 'cliArg', ruleDisplay: entry, sourceDisplay: '--allowed-tools' },
      ])
    })
  }

  test('and is removed from the startup context', () => {
    const findings = findDangerousClassifierPermissions([], ['Agent(a(b))'])
    const after = removeDangerousPermissions(context({ cliArg: ['Agent(a\\(b\\))', 'Read'] }), findings)
    expect(after.alwaysAllowRules.cliArg).toEqual(['Read'])
  })

  test('an entry the parser reads as a harmless rule still yields nothing', () => {
    expect(findDangerousClassifierPermissions([], ['Bash(python:*)(x)', 'Bash(ls (x))'])).toEqual([])
  })
})

describe('matcher compiled-pattern bound', () => {
  test('answers stay right after the cache is cleared', () => {
    for (let n = 0; n < 600; n++) {
      expect(matchWildcardPattern(`cmd${n} *`, `cmd${n} arg`)).toBe(true)
    }
    expect(matchWildcardPattern('git *', 'gitx')).toBe(false)
    expect(matchWildcardPattern('cmd0 *', 'cmd0')).toBe(true)
  })
})
