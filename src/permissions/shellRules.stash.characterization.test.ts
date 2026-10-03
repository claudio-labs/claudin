/**
 * Characterization of the dangerous-rule stash: entering auto mode takes the
 * dangerous allow rules out of the in-memory context and keeps them on the
 * context; leaving it puts them back. Everything here is a transform of the
 * context value: nothing is read from or written to settings files.
 */
import { describe, expect, test } from 'bun:test'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Lists = Partial<Record<PermissionRuleSource, string[]>>

function context(allow: Lists, extra: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map([['/w', { path: '/w', source: 'session' }]]),
    alwaysAllowRules: allow,
    alwaysDenyRules: { session: ['Bash(rm:*)'] },
    alwaysAskRules: { userSettings: ['Bash'] },
    isBypassPermissionsModeAvailable: true,
    ...extra,
  }
}

function info(source: PermissionRuleSource, toolName: string, ruleContent?: string): DangerousPermissionInfo {
  return {
    ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
    source,
    ruleDisplay: 'unused',
    sourceDisplay: 'unused',
  }
}

const ESCAPED = 'Bash(python -c\\(\\)*)'

describe('entering auto mode', () => {
  test('dangerous rules leave every writable source and are kept per source; safe ones stay in order', () => {
    const before = context({
      userSettings: ['Bash(ls)', 'Bash(python:*)', 'Read'],
      projectSettings: ['Agent(Explore)'],
      localSettings: ['PowerShell(iex:*)', 'Bash(git *)'],
      cliArg: ['Bash', 'Edit'],
      session: ['Bash(node *)', ESCAPED, 'Bash(npm test)'],
    })
    const after = stripDangerousPermissionsForAutoMode(before)
    expect(after.alwaysAllowRules).toEqual({
      userSettings: ['Bash(ls)', 'Read'],
      projectSettings: [],
      localSettings: ['Bash(git *)'],
      cliArg: ['Edit'],
      session: ['Bash(npm test)'],
    })
    expect(after.strippedDangerousRules).toEqual({
      userSettings: ['Bash(python:*)'],
      projectSettings: ['Agent(Explore)'],
      localSettings: ['PowerShell(iex:*)'],
      cliArg: ['Bash'],
      session: ['Bash(node *)', ESCAPED],
    })
  })

  test('everything but the allow rules and the stash is left as it was', () => {
    const before = context({ session: ['Bash(python:*)'] }, { mode: 'auto' })
    const after = stripDangerousPermissionsForAutoMode(before)
    expect(after.mode).toBe('auto')
    expect(after.alwaysDenyRules).toEqual({ session: ['Bash(rm:*)'] })
    expect(after.alwaysAskRules).toEqual({ userSettings: ['Bash'] })
    expect(after.additionalWorkingDirectories).toEqual(before.additionalWorkingDirectories)
    expect(after.isBypassPermissionsModeAvailable).toBe(true)
    // The input is not mutated.
    expect(before.alwaysAllowRules).toEqual({ session: ['Bash(python:*)'] })
    expect(before.strippedDangerousRules).toBeUndefined()
  })

  test('rules from sources that cannot be written stay in force and are not kept', () => {
    const before = context({
      flagSettings: ['Bash(python:*)'],
      policySettings: ['Bash'],
      command: ['Agent'],
      session: ['Bash(sudo:*)'],
    })
    const after = stripDangerousPermissionsForAutoMode(before)
    expect(after.alwaysAllowRules).toEqual({
      flagSettings: ['Bash(python:*)'],
      policySettings: ['Bash'],
      command: ['Agent'],
      session: [],
    })
    expect(after.strippedDangerousRules).toEqual({ session: ['Bash(sudo:*)'] })
  })

  test('with nothing dangerous, the rules are untouched and the stash becomes an empty record', () => {
    const before = context({ session: ['Bash(ls)', 'Bash(npm:*)'] })
    const after = stripDangerousPermissionsForAutoMode(before)
    expect(after).not.toBe(before)
    expect(after.alwaysAllowRules).toEqual({ session: ['Bash(ls)', 'Bash(npm:*)'] })
    expect(after.strippedDangerousRules).toEqual({})
  })

  test('with nothing dangerous, a stash already on the context is kept', () => {
    const kept = { localSettings: ['Bash(python:*)'] }
    const after = stripDangerousPermissionsForAutoMode(
      context({ session: ['Bash(ls)'] }, { strippedDangerousRules: kept }),
    )
    expect(after.strippedDangerousRules).toEqual({ localSettings: ['Bash(python:*)'] })
    expect(after.alwaysAllowRules).toEqual({ session: ['Bash(ls)'] })
  })

  test('every copy of a stripped rule leaves the list', () => {
    const after = stripDangerousPermissionsForAutoMode(
      context({ session: ['Bash(python:*)', 'Bash(ls)', 'Bash(python:*)'] }),
    )
    expect(after.alwaysAllowRules.session).toEqual(['Bash(ls)'])
  })

  test('deny and ask rules are never stripped, however dangerous they look', () => {
    const after = stripDangerousPermissionsForAutoMode(
      context({}, { alwaysDenyRules: { session: ['Bash(python:*)'] }, alwaysAskRules: { session: ['Agent'] } }),
    )
    expect(after.alwaysDenyRules).toEqual({ session: ['Bash(python:*)'] })
    expect(after.alwaysAskRules).toEqual({ session: ['Agent'] })
    expect(after.strippedDangerousRules).toEqual({})
  })
})

describe('leaving auto mode', () => {
  test('kept rules are appended to their source and the stash is cleared', () => {
    const inAuto = context(
      { session: ['Bash(ls)'], userSettings: [] },
      { strippedDangerousRules: { session: ['Bash(python:*)', ESCAPED], userSettings: ['Agent'], cliArg: ['Bash'] } },
    )
    const out = restoreDangerousPermissions(inAuto)
    expect(out.alwaysAllowRules).toEqual({
      session: ['Bash(ls)', 'Bash(python:*)', ESCAPED],
      userSettings: ['Agent'],
      cliArg: ['Bash'],
    })
    expect('strippedDangerousRules' in out).toBe(true)
    expect(out.strippedDangerousRules).toBeUndefined()
    expect(out.alwaysDenyRules).toEqual({ session: ['Bash(rm:*)'] })
    expect(out.alwaysAskRules).toEqual({ userSettings: ['Bash'] })
    expect(out.mode).toBe('default')
  })

  test('with no stash the very same context comes back, so a second exit is a no-op', () => {
    const plain = context({ session: ['Bash(ls)'] })
    expect(restoreDangerousPermissions(plain)).toBe(plain)

    const once = restoreDangerousPermissions(context({}, { strippedDangerousRules: { session: ['Bash'] } }))
    expect(restoreDangerousPermissions(once)).toBe(once)
    expect(once.alwaysAllowRules).toEqual({ session: ['Bash'] })
  })

  test('an empty stash or empty source lists add nothing, not even an empty list', () => {
    const out = restoreDangerousPermissions(
      context({ session: ['Bash(ls)'] }, { strippedDangerousRules: { localSettings: [], userSettings: [] } }),
    )
    expect(out.alwaysAllowRules).toEqual({ session: ['Bash(ls)'] })
    expect(out.strippedDangerousRules).toBeUndefined()

    const fromEmpty = restoreDangerousPermissions(context({}, { strippedDangerousRules: {} }))
    expect(fromEmpty.alwaysAllowRules).toEqual({})
    expect(fromEmpty.strippedDangerousRules).toBeUndefined()
  })

  test('a round trip gives back every rule, the restored ones last', () => {
    const start = context({
      localSettings: ['Bash(python:*)', 'Bash(ls)'],
      session: [ESCAPED, 'Agent(Explore)', 'Read'],
    })
    const back = restoreDangerousPermissions(stripDangerousPermissionsForAutoMode(start))
    expect(back.alwaysAllowRules).toEqual({
      localSettings: ['Bash(ls)', 'Bash(python:*)'],
      session: ['Read', ESCAPED, 'Agent(Explore)'],
    })
    expect(back.strippedDangerousRules).toBeUndefined()
  })
})

describe('removing a list of findings', () => {
  test('each finding is removed from its own source only, as an allow rule', () => {
    const before = context({
      userSettings: ['Bash(python:*)', 'Bash(ls)'],
      localSettings: ['Bash(python:*)', 'Agent'],
      session: ['PowerShell(iex:*)', 'Bash(node *)'],
    })
    const after = removeDangerousPermissions(before, [
      info('userSettings', 'Bash', 'python:*'),
      info('localSettings', 'Agent'),
      info('session', 'PowerShell', 'iex:*'),
      info('session', 'Bash', 'node *'),
    ])
    expect(after.alwaysAllowRules).toEqual({
      userSettings: ['Bash(ls)'],
      localSettings: ['Bash(python:*)'],
      session: [],
    })
    expect(after.alwaysDenyRules).toEqual({ session: ['Bash(rm:*)'] })
    expect(after.alwaysAskRules).toEqual({ userSettings: ['Bash'] })
    expect(after.strippedDangerousRules).toBeUndefined()
  })

  test('findings from flag, policy or command sources are skipped', () => {
    const before = context({ flagSettings: ['Bash'], policySettings: ['Bash'], command: ['Bash'] })
    const after = removeDangerousPermissions(before, [
      info('flagSettings', 'Bash'),
      info('policySettings', 'Bash'),
      info('command', 'Bash'),
    ])
    expect(after.alwaysAllowRules).toEqual({ flagSettings: ['Bash'], policySettings: ['Bash'], command: ['Bash'] })
  })

  test('no findings, the very same context comes back', () => {
    const before = context({ session: ['Bash'] })
    expect(removeDangerousPermissions(before, [])).toBe(before)
  })

  test('a finding with no matching rule leaves the list as it was', () => {
    const after = removeDangerousPermissions(context({ session: ['Bash(ls)'] }), [info('session', 'Bash', 'python:*')])
    expect(after.alwaysAllowRules).toEqual({ session: ['Bash(ls)'] })
  })

  test('the startup scan of --allowed-tools removes those entries as they were typed', () => {
    const typed = ['Bash(*)', 'Bash(python:*)', 'Agent', 'Bash(ls)']
    const findings = findDangerousClassifierPermissions([], typed)
    const after = removeDangerousPermissions(context({ cliArg: [...typed] }), findings)
    expect(after.alwaysAllowRules).toEqual({ cliArg: ['Bash(ls)'] })
  })

  test('a body with parentheses is matched in its escaped stored form', () => {
    const after = removeDangerousPermissions(context({ session: [ESCAPED, 'Bash(ls)'] }), [
      info('session', 'Bash', 'python -c()*'),
    ])
    expect(after.alwaysAllowRules).toEqual({ session: ['Bash(ls)'] })
  })
})
