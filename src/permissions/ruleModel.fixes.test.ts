/**
 * The "fix" decisions of the permissions/ruleModel spec (Findings 2 and 4–9).
 * The characterization suites pin the behaviour that was kept; these pin
 * what the rewrite changed on purpose.
 */
import { describe, expect, test } from 'bun:test'
import { isExternalPermissionMode, type PermissionMode } from 'src/permissions/PermissionMode.js'
import {
  applyPermissionUpdate,
  createReadRuleSuggestion,
  persistPermissionUpdate,
} from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  addPermissionRulesToSettings,
  deletePermissionRuleFromSettings,
  type PermissionRuleFromEditableSettings,
} from 'src/permissions/permissionsLoader.js'
import { type Layer, useRuleModelWorld } from 'src/permissions/__testutils__/ruleModelWorld.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = useRuleModelWorld('rule-fixes')

function sessionAllowing(rules: string[]): ToolPermissionContext {
  return { ...getEmptyToolPermissionContext(), alwaysAllowRules: { session: rules } }
}

describe('Finding 2: session rules are stored and removed by canonical form', () => {
  const stored: Array<[why: string, update: PermissionUpdate, expected: string[]]> = [
    ['a tool-wide star is stored as the bare tool', { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: '*' }] }, ['Bash']],
    ['an old tool name is stored as today\'s', { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Task', ruleContent: 'x' }] }, ['Agent(x)']],
    ['a replacement is stored canonical too', { type: 'replaceRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'KillShell' }, { toolName: 'Bash', ruleContent: '' }] }, ['TaskStop', 'Bash']],
  ]
  test.each(stored)('%s', (_why, update, expected) => {
    expect(applyPermissionUpdate(sessionAllowing([]), update).alwaysAllowRules.session).toEqual(expected)
  })

  test('a Bash(*) allow sent by an SDK host goes away when the user removes Bash', () => {
    const added = applyPermissionUpdate(sessionAllowing([]), {
      type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: '*' }],
    })
    const removed = applyPermissionUpdate(added, {
      type: 'removeRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }],
    })
    expect(removed.alwaysAllowRules.session).toEqual([])
  })

  test('removal matches entries stored under any spelling', () => {
    const ctx = sessionAllowing(['Bash(*)', 'KillShell', 'Bash(print(1))', 'Bash(ls)'])
    const next = applyPermissionUpdate(ctx, {
      type: 'removeRules',
      behavior: 'allow',
      destination: 'session',
      rules: [{ toolName: 'Bash' }, { toolName: 'TaskStop' }, { toolName: 'Bash', ruleContent: 'print(1)' }],
    })
    expect(next.alwaysAllowRules.session).toEqual(['Bash(ls)'])
  })
})

describe('Finding 4: the Read suggestion never covers a root', () => {
  const roots = ['/', '//', '///', '', 'C:\\', 'C:/', 'c:', 'D:\\\\']
  test.each(roots)('%p gets no suggestion', root => {
    expect(createReadRuleSuggestion(root)).toBeUndefined()
  })

  // Trailing slashes collapse; an absolute directory gains the `//` root anchor.
  const suggestions: Record<string, string> = {
    '/a/b/': '//a/b/**',
    '/a/b//': '//a/b/**',
    'src/': 'src/**',
    '/a': '//a/**',
  }
  const trimmed = Object.entries(suggestions)
  test.each(trimmed)('%p is suggested as %p', (dir, pattern) => {
    const suggestion = createReadRuleSuggestion(dir)
    expect(suggestion?.type === 'addRules' ? suggestion.rules : undefined).toEqual([{ toolName: 'Read', ruleContent: pattern }])
  })
})

describe('Finding 5: only the five external modes are external', () => {
  test.each(['bubble', 'auto', 'nonsense'])('%p is not external', mode => {
    expect(isExternalPermissionMode(mode as PermissionMode)).toBe(false)
  })
})

describe('Finding 6: adding keeps the entries validation skipped', () => {
  test('every list keeps its skipped entries, the written-to list included', () => {
    world.put('user', { permissions: { allow: ['Bash(foo', 42, 'Read'], deny: ['bash(rm)', 'Bash'], ask: [''] } })
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Edit' }] }, 'userSettings')).toBe(true)
    expect(world.json('user').permissions).toEqual({ allow: ['Bash(foo', 42, 'Read', 'Edit'], deny: ['bash(rm)', 'Bash'], ask: [''] })
  })

  test('deleting keeps them as well', () => {
    world.put('local', { permissions: { allow: ['Bash(foo', 'Read'], deny: [7, 'Glob'] } })
    const rule = { source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Read' } } as PermissionRuleFromEditableSettings
    expect(deletePermissionRuleFromSettings(rule)).toBe(true)
    expect(world.json('local').permissions).toEqual({ allow: ['Bash(foo'], deny: [7, 'Glob'] })
  })
})

describe('Finding 7: added rules are de-duplicated and canonical', () => {
  const adds: Array<[why: string, values: Array<{ toolName: string; ruleContent?: string }>, expected: string[]]> = [
    ['a repeat within the batch is written once', [{ toolName: 'Read' }, { toolName: 'Read' }], ['Read']],
    ['two spellings of one rule are written once', [{ toolName: 'Bash' }, { toolName: 'Bash', ruleContent: '*' }], ['Bash']],
    ['an old tool name is written as today\'s', [{ toolName: 'Task', ruleContent: 'r' }], ['Agent(r)']],
  ]
  test.each(adds)('%s', (_why, ruleValues, expected) => {
    expect(addPermissionRulesToSettings({ ruleBehavior: 'deny', ruleValues }, 'projectSettings')).toBe(true)
    expect(world.json('project').permissions.deny).toEqual(expected)
  })

  test('an old name already present under its new name is not added', () => {
    const before = JSON.stringify({ permissions: { allow: ['Agent'] } })
    world.put('user', before)
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Task' }] }, 'userSettings')).toBe(true)
    expect(world.text('user')).toBe(before)
  })
})

describe('Finding 8: managed rules only refuses saved replacements too', () => {
  const lock = () => world.put('managed', { allowManagedPermissionRulesOnly: true })

  test('a replaceRules update is not saved', () => {
    lock()
    const before = JSON.stringify({ permissions: { allow: ['Read'] } })
    world.put('user', before)
    persistPermissionUpdate({ type: 'replaceRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash' }] })
    persistPermissionUpdate({ type: 'replaceRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash' }] })
    expect([world.text('user'), world.text('local')]).toEqual([before, null])
  })

  test('removals, modes and directories are still saved', () => {
    lock()
    world.put('user', { permissions: { allow: ['Bash', 'Read'], additionalDirectories: ['/a'] } })
    persistPermissionUpdate({ type: 'removeRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash' }] })
    persistPermissionUpdate({ type: 'setMode', mode: 'plan', destination: 'userSettings' })
    persistPermissionUpdate({ type: 'addDirectories', directories: ['/b'], destination: 'userSettings' })
    expect(world.json('user').permissions).toEqual({ allow: ['Read'], additionalDirectories: ['/a', '/b'], defaultMode: 'plan' })
  })
})

describe('Finding 9: a removal that removes nothing writes nothing', () => {
  const removals: Array<[why: string, layer: Layer, body: string | null, update: PermissionUpdate]> = [
    ['rules from a missing file', 'local', null, { type: 'removeRules', behavior: 'deny', destination: 'localSettings', rules: [{ toolName: 'Bash' }] }],
    ['directories from a missing file', 'project', null, { type: 'removeDirectories', directories: ['/a'], destination: 'projectSettings' }],
    ['directories that are not listed', 'project', JSON.stringify({ permissions: { additionalDirectories: ['/a'] } }), { type: 'removeDirectories', directories: ['/zz'], destination: 'projectSettings' }],
    ['rules from a file without that list', 'user', JSON.stringify({ permissions: { allow: ['Bash'] } }), { type: 'removeRules', behavior: 'deny', destination: 'userSettings', rules: [{ toolName: 'Bash' }] }],
    ['a rule that is not listed', 'user', JSON.stringify({ permissions: { deny: ['Read'] } }), { type: 'removeRules', behavior: 'deny', destination: 'userSettings', rules: [{ toolName: 'Bash' }] }],
  ]
  test.each(removals)('removing %s', (_why, layer, body, update) => {
    if (body !== null) world.put(layer, body)
    persistPermissionUpdate(update)
    expect(world.text(layer)).toBe(body)
  })
})

describe('files that cannot be edited safely are left alone', () => {
  const unusable = ['[]', '"text"', '{ "permissions": "all" }', '{ "permissions": { "allow": ["Read"] ']
  test.each(unusable)('%p is never overwritten', body => {
    world.put('user', body)
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Edit' }] }, 'userSettings')).toBe(false)
    persistPermissionUpdate({ type: 'setMode', mode: 'plan', destination: 'userSettings' })
    expect(world.text('user')).toBe(body)
  })

  test('an empty file is edited like a new one', () => {
    world.put('user', '')
    expect(addPermissionRulesToSettings({ ruleBehavior: 'ask', ruleValues: [{ toolName: 'Edit' }] }, 'userSettings')).toBe(true)
    expect(world.json('user')).toEqual({ permissions: { ask: ['Edit'] } })
  })
})
