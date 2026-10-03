/**
 * Which permission rules are in force, read from the settings files on disk,
 * and how a rule is added to or deleted from one of them.
 *
 * Every test runs in its own temp world (see __testutils__/ruleModelWorld):
 * real settings files for the user, project, local, --settings and managed
 * layers, and the registry layers fed through their cache.
 *
 * The managed layer can switch every other layer off
 * (`allowManagedPermissionRulesOnly`), so the "who may say what" cases below
 * matter as much as the happy path.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import {
  addPermissionRulesToSettings,
  deletePermissionRuleFromSettings,
  getPermissionRulesForSource,
  loadAllPermissionRulesFromDisk,
  shouldAllowManagedPermissionRulesOnly,
  shouldShowAlwaysAllowOptions,
  type PermissionRuleFromEditableSettings,
} from 'src/permissions/permissionsLoader.js'
import { type Layer, useRuleModelWorld } from 'src/permissions/__testutils__/ruleModelWorld.js'

const world = useRuleModelWorld('rule-loader')
const fixture = (name: string): string => readFileSync(join(import.meta.dir, '__fixtures__', 'rewrite', name), 'utf8')

/** A compact view of a loaded rule: `source behavior Tool(content)`. */
const show = (rule: PermissionRule): string => {
  const { toolName, ruleContent } = rule.ruleValue
  return `${rule.source} ${rule.ruleBehavior} ${ruleContent === undefined ? toolName : `${toolName}[${ruleContent}]`}`
}
const loadedFrom = (source: Parameters<typeof getPermissionRulesForSource>[0]) =>
  getPermissionRulesForSource(source).map(show)
const loadedAll = () => loadAllPermissionRulesFromDisk().map(show)

const marker = (layer: string) => ({ permissions: { deny: [`Read(${layer})`] } })

function placeEveryLayer(): void {
  for (const layer of ['user', 'project', 'local', 'flag', 'managed'] as Layer[]) world.put(layer, marker(layer))
}

describe('reading one layer', () => {
  test('the rules of a file come allow first, then deny, then ask, each parsed', () => {
    world.put('project', fixture('rules-on-disk.settings.json'))
    expect(loadedFrom('projectSettings')).toEqual([
      'projectSettings allow Bash[npm test]',
      'projectSettings allow Bash[python -c "print(1)"]',
      'projectSettings allow Agent[reviewer]',
      'projectSettings allow Bash',
      'projectSettings allow mcp__docs',
      'projectSettings deny TaskStop',
      'projectSettings deny Bash[rm -rf:*]',
      'projectSettings deny Read[//etc/**]',
      'projectSettings ask WebFetch[domain:example.com]',
    ])
  })

  test('each layer is tagged with its own source', () => {
    placeEveryLayer()
    const sources = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const
    expect(sources.map(s => loadedFrom(s))).toEqual([
      ['userSettings deny Read[user]'],
      ['projectSettings deny Read[project]'],
      ['localSettings deny Read[local]'],
      ['flagSettings deny Read[flag]'],
      ['policySettings deny Read[managed]'],
    ])
  })

  const empty: Array<[why: string, body: object | string | null]> = [
    ['no file', null],
    ['an empty file', ''],
    ['a file with no permissions', { model: 'x' }],
    ['empty rule lists', { permissions: { allow: [], deny: [], ask: [] } }],
    ['broken JSON', '{ "permissions": { "deny": ["Bash"] '],
    ['a JSON array', '[]'],
  ]
  test.each(empty)('%s gives no rules', (_why, body) => {
    if (body !== null) world.put('user', body)
    expect(loadedFrom('userSettings')).toEqual([])
  })

  test('rules that fail validation are skipped and the rest still load', () => {
    world.put('local', {
      permissions: { deny: ['Bash(foo', '', 'bash(rm)', 42, 'Bash()', 'Read(.env)'], allow: [null, 'Edit'] },
    })
    expect(loadedFrom('localSettings')).toEqual(['localSettings allow Edit', 'localSettings deny Read[.env]'])
  })

  test('a deny rule that cannot be split loads as a rule for a tool with that literal name', () => {
    world.put('user', { permissions: { deny: ['Bash(rm:*) now', 'Bash(curl) x', 'Bash (rm *)'] } })
    expect(loadedFrom('userSettings')).toEqual([
      'userSettings deny Bash(rm:*) now',
      'userSettings deny Bash(curl) x',
      'userSettings deny Bash [rm *]',
    ])
  })

  test('one invalid field elsewhere in the file drops every rule in it', () => {
    world.put('project', { permissions: { deny: ['Bash'] }, hooks: { NotAnEvent: 5 } })
    expect(loadedFrom('projectSettings')).toEqual([])
  })

  test('the --settings layer adds rules handed over inline by an SDK host', () => {
    world.put('flag', { permissions: { deny: ['Read(file)'] } })
    world.inlineFlags({ permissions: { deny: ['Read(inline)'], ask: ['Edit'] } })
    expect(loadedFrom('flagSettings')).toEqual([
      'flagSettings deny Read[file]',
      'flagSettings deny Read[inline]',
      'flagSettings ask Edit',
    ])
  })

  test('inline rules load even with no --settings file', () => {
    world.inlineFlags({ permissions: { allow: ['Glob'] } })
    expect(loadedFrom('flagSettings')).toEqual(['flagSettings allow Glob'])
  })
})

describe('the managed layer', () => {
  test('managed drop-ins add to the managed file', () => {
    world.put('managed', { permissions: { deny: ['Read(base)'] } })
    world.putDropIn('20-b.json', { permissions: { deny: ['Read(b)'] } })
    world.putDropIn('10-a.json', { permissions: { deny: ['Read(a)'] } })
    expect(loadedFrom('policySettings')).toEqual([
      'policySettings deny Read[base]',
      'policySettings deny Read[a]',
      'policySettings deny Read[b]',
    ])
  })

  test('the admin registry replaces the managed file outright', () => {
    world.put('managed', { permissions: { deny: ['Read(file)'] } })
    world.registry({ permissions: { deny: ['Read(registry)'] } })
    expect(loadedFrom('policySettings')).toEqual(['policySettings deny Read[registry]'])
  })

  test('the user registry is read only when nothing else is managed', () => {
    world.registry({}, { permissions: { deny: ['Read(hkcu)'] } })
    expect(loadedFrom('policySettings')).toEqual(['policySettings deny Read[hkcu]'])
    world.put('managed', { permissions: { deny: ['Read(file)'] } })
    expect(loadedFrom('policySettings')).toEqual(['policySettings deny Read[file]'])
  })
})

describe('reading every layer', () => {
  test('with every source allowed: user, project, local, --settings, then managed', () => {
    placeEveryLayer()
    expect(loadedAll()).toEqual([
      'userSettings deny Read[user]',
      'projectSettings deny Read[project]',
      'localSettings deny Read[local]',
      'flagSettings deny Read[flag]',
      'policySettings deny Read[managed]',
    ])
  })

  const restricted: Array<[why: string, sources: Parameters<typeof world.onlySources>[0], expected: string[]]> = [
    ['user only', ['userSettings'], ['userSettings deny Read[user]', 'policySettings deny Read[managed]', 'flagSettings deny Read[flag]']],
    ['project and local', ['projectSettings', 'localSettings'], [
      'projectSettings deny Read[project]', 'localSettings deny Read[local]',
      'policySettings deny Read[managed]', 'flagSettings deny Read[flag]',
    ]],
    ['none', [], ['policySettings deny Read[managed]', 'flagSettings deny Read[flag]']],
  ]
  test.each(restricted)('restricted to %s, the managed and --settings layers still load, last', (_why, sources, expected) => {
    placeEveryLayer()
    world.onlySources(sources)
    expect(loadedAll()).toEqual(expected)
  })

  test('with no files anywhere, there are no rules', () => {
    expect(loadedAll()).toEqual([])
  })
})

describe('managed rules only', () => {
  test('when the managed layer says so, every other layer is ignored, inline rules included', () => {
    placeEveryLayer()
    world.inlineFlags({ permissions: { allow: ['Bash'] } })
    world.put('managed', { allowManagedPermissionRulesOnly: true, permissions: { deny: ['Read(managed)'], ask: ['Edit'] } })
    expect(loadedAll()).toEqual(['policySettings deny Read[managed]', 'policySettings ask Edit'])
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(true)
    expect(shouldShowAlwaysAllowOptions()).toBe(false)
  })

  test('managed-only with no managed rules leaves no rules at all', () => {
    placeEveryLayer()
    world.put('managed', { allowManagedPermissionRulesOnly: true })
    expect(loadedAll()).toEqual([])
  })

  test('a managed drop-in can switch it on', () => {
    world.put('user', marker('user'))
    world.putDropIn('50-lock.json', { allowManagedPermissionRulesOnly: true })
    expect(loadedAll()).toEqual([])
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(true)
  })

  test('the admin registry can switch it on', () => {
    world.put('user', marker('user'))
    world.registry({ allowManagedPermissionRulesOnly: true, permissions: { deny: ['Read(reg)'] } })
    expect(loadedAll()).toEqual(['policySettings deny Read[reg]'])
  })

  const ignored: Layer[] = ['user', 'project', 'local', 'flag']
  test.each(ignored)('the %s layer cannot switch it on', layer => {
    world.put('user', marker('user'))
    world.put(layer, { allowManagedPermissionRulesOnly: true, permissions: { deny: [`Read(${layer})`] } })
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(false)
    expect(shouldShowAlwaysAllowOptions()).toBe(true)
    expect(loadedAll()).toContain('userSettings deny Read[user]')
  })

  test('an inline SDK setting cannot switch it on', () => {
    world.inlineFlags({ allowManagedPermissionRulesOnly: true })
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(false)
  })

  const notTrue: unknown[] = ['true', 1, 'yes', false, null]
  test.each(notTrue)('only the value true switches it on, not %p', value => {
    world.put('user', marker('user'))
    world.registry({ allowManagedPermissionRulesOnly: value })
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(false)
    expect(loadedAll()).toEqual(['userSettings deny Read[user]'])
  })

  test('with nothing managed, always-allow options are shown', () => {
    expect(shouldAllowManagedPermissionRulesOnly()).toBe(false)
    expect(shouldShowAlwaysAllowOptions()).toBe(true)
  })
})

describe('adding rules to a settings file', () => {
  test('a new file is written in the settings format, rules escaped, in order', () => {
    expect(addPermissionRulesToSettings({
      ruleBehavior: 'allow',
      ruleValues: [{ toolName: 'Bash', ruleContent: 'npm run build' }, { toolName: 'Bash', ruleContent: 'python -c "print(1)"' }],
    }, 'projectSettings')).toBe(true)
    expect(addPermissionRulesToSettings({
      ruleBehavior: 'deny',
      ruleValues: [{ toolName: 'Read', ruleContent: '//home/me/.ssh/**' }],
    }, 'projectSettings')).toBe(true)
    expect(world.text('project')).toBe(fixture('rules-after-add.settings.json'))
  })

  const layers: Array<[source: 'userSettings' | 'projectSettings' | 'localSettings', layer: Layer]> = [
    ['userSettings', 'user'],
    ['projectSettings', 'project'],
    ['localSettings', 'local'],
  ]
  test.each(layers)('%s goes to its own file and nowhere else', (source, layer) => {
    expect(addPermissionRulesToSettings({ ruleBehavior: 'ask', ruleValues: [{ toolName: 'Edit' }] }, source)).toBe(true)
    expect(world.json(layer)).toEqual({ permissions: { ask: ['Edit'] } })
    for (const other of ['user', 'project', 'local'] as Layer[]) {
      if (other !== layer) expect(world.text(other)).toBeNull()
    }
  })

  test('new rules go after the existing ones, which are kept as written, with every other key', () => {
    world.put('user', { model: 'm', permissions: { allow: ['KillShell', 'Read'], deny: ['Bash(rm:*)'], defaultMode: 'plan' } })
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Glob' }] }, 'userSettings')).toBe(true)
    expect(world.json('user')).toEqual({
      model: 'm',
      permissions: { allow: ['KillShell', 'Read', 'Glob'], deny: ['Bash(rm:*)'], defaultMode: 'plan' },
    })
  })

  test('a rule already there under another spelling is not added again, and the file is not rewritten', () => {
    const before = JSON.stringify({ permissions: { deny: ['KillShell', 'Bash(*)', 'Task(x)', 'Bash(print(1))'] } })
    world.put('local', before)
    const again = [
      { toolName: 'TaskStop' },
      { toolName: 'Bash' },
      { toolName: 'Agent', ruleContent: 'x' },
      { toolName: 'Bash', ruleContent: 'print(1)' },
    ]
    expect(addPermissionRulesToSettings({ ruleBehavior: 'deny', ruleValues: again }, 'localSettings')).toBe(true)
    expect(world.text('local')).toBe(before)
  })

  test('the same rule under another behavior is a new rule', () => {
    world.put('user', { permissions: { allow: ['Bash'] } })
    expect(addPermissionRulesToSettings({ ruleBehavior: 'deny', ruleValues: [{ toolName: 'Bash' }] }, 'userSettings')).toBe(true)
    expect(world.json('user').permissions).toEqual({ allow: ['Bash'], deny: ['Bash'] })
  })

  test('an empty list succeeds without touching the disk', () => {
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [] }, 'projectSettings')).toBe(true)
    expect(world.text('project')).toBeNull()
  })

  test('nothing is added while only managed rules count', () => {
    world.put('managed', { allowManagedPermissionRulesOnly: true })
    world.put('user', { permissions: { allow: ['Read'] } })
    const before = world.text('user')
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Bash' }] }, 'userSettings')).toBe(false)
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Bash' }] }, 'localSettings')).toBe(false)
    expect(world.text('user')).toBe(before)
    expect(world.text('local')).toBeNull()
  })

  test('a file that fails validation elsewhere keeps its rules and its other fields', () => {
    world.put('user', { permissions: { allow: ['Read'] }, hooks: { NotAnEvent: 5 } })
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Edit' }] }, 'userSettings')).toBe(true)
    expect(world.json('user')).toEqual({ permissions: { allow: ['Read', 'Edit'] }, hooks: { NotAnEvent: 5 } })
  })

  test('a file with broken JSON is never overwritten', () => {
    const broken = '{ "permissions": { "deny": ["Bash"] '
    world.put('project', broken)
    expect(addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Edit' }] }, 'projectSettings')).toBe(false)
    expect(world.text('project')).toBe(broken)
  })

  test('the managed file is never written', () => {
    world.put('managed', { permissions: { deny: ['Bash'] } })
    const before = world.text('managed')
    addPermissionRulesToSettings({ ruleBehavior: 'allow', ruleValues: [{ toolName: 'Bash' }] }, 'policySettings' as 'userSettings')
    expect(world.text('managed')).toBe(before)
  })

  test('an added rule is in force on the next read', () => {
    addPermissionRulesToSettings({ ruleBehavior: 'deny', ruleValues: [{ toolName: 'WebFetch' }] }, 'localSettings')
    expect(loadedAll()).toEqual(['localSettings deny WebFetch'])
  })
})

describe('deleting a rule from a settings file', () => {
  const rule = (
    source: string,
    ruleBehavior: 'allow' | 'deny' | 'ask',
    toolName: string,
    ruleContent?: string,
  ): PermissionRuleFromEditableSettings =>
    ({ source, ruleBehavior, ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent } }) as PermissionRuleFromEditableSettings

  test('the rule leaves its behavior list, and everything else stays', () => {
    world.put('project', { model: 'm', permissions: { allow: ['Read', 'Edit'], deny: ['Read'], defaultMode: 'plan' } })
    expect(deletePermissionRuleFromSettings(rule('projectSettings', 'allow', 'Read'))).toBe(true)
    expect(world.json('project')).toEqual({ model: 'm', permissions: { allow: ['Edit'], deny: ['Read'], defaultMode: 'plan' } })
  })

  test('every spelling of the rule goes', () => {
    world.put('user', { permissions: { allow: ['Bash', 'Bash(*)', 'Read'], deny: ['KillShell', 'TaskStop', 'Glob'] } })
    expect(deletePermissionRuleFromSettings(rule('userSettings', 'allow', 'Bash'))).toBe(true)
    expect(deletePermissionRuleFromSettings(rule('userSettings', 'deny', 'TaskStop'))).toBe(true)
    expect(world.json('user').permissions).toEqual({ allow: ['Read'], deny: ['Glob'] })
  })

  const onlyOtherSpelling: Array<{ stored: string; target: PermissionRuleFromEditableSettings }> = [
    { stored: 'KillShell', target: rule('userSettings', 'deny', 'TaskStop') },
    { stored: 'Bash(*)', target: rule('userSettings', 'deny', 'Bash') },
    { stored: 'Task(reviewer)', target: rule('userSettings', 'deny', 'Agent', 'reviewer') },
    { stored: 'Bash(print(1))', target: rule('userSettings', 'deny', 'Bash', 'print(1)') },
  ]
  test.each(onlyOtherSpelling)('a file holding only $stored still gives the rule up', ({ stored, target }) => {
    world.put('user', { permissions: { deny: [stored, 'Glob'] } })
    expect(deletePermissionRuleFromSettings(target)).toBe(true)
    expect(world.json('user').permissions).toEqual({ deny: ['Glob'] })
  })

  test('content with parentheses matches its escaped and its plain spelling', () => {
    world.put('local', { permissions: { ask: [String.raw`Bash(print\(1\))`, 'Bash(print(1))', 'Bash(print)'] } })
    expect(deletePermissionRuleFromSettings(rule('localSettings', 'ask', 'Bash', 'print(1)'))).toBe(true)
    expect(world.json('local').permissions).toEqual({ ask: ['Bash(print)'] })
  })

  test('a scoped rule does not take the tool-wide rule with it', () => {
    world.put('user', { permissions: { deny: ['Bash', 'Bash(rm:*)'] } })
    expect(deletePermissionRuleFromSettings(rule('userSettings', 'deny', 'Bash', 'rm:*'))).toBe(true)
    expect(world.json('user').permissions).toEqual({ deny: ['Bash'] })
  })

  const misses: Array<[why: string, body: object | null, target: PermissionRuleFromEditableSettings]> = [
    ['no file', null, rule('userSettings', 'allow', 'Read')],
    ['no permissions', { model: 'm' }, rule('userSettings', 'allow', 'Read')],
    ['no list for that behavior', { permissions: { deny: ['Read'] } }, rule('userSettings', 'allow', 'Read')],
    ['the rule is under another behavior', { permissions: { deny: ['Read'] } }, rule('userSettings', 'ask', 'Read')],
    ['the rule is not there', { permissions: { allow: ['Read(src/**)'] } }, rule('userSettings', 'allow', 'Read')],
    ['the file fails validation', { permissions: { allow: ['Read'] }, hooks: { NotAnEvent: 1 } }, rule('userSettings', 'allow', 'Read')],
  ]
  test.each(misses)('when %s, nothing changes and the answer is false', (_why, body, target) => {
    if (body) world.put('user', body)
    const before = world.text('user')
    expect(deletePermissionRuleFromSettings(target)).toBe(false)
    expect(world.text('user')).toBe(before)
  })

  const readOnly = ['policySettings', 'flagSettings', 'session', 'cliArg', 'command']
  test.each(readOnly)('a rule from %s is never deleted from any file', source => {
    world.put('managed', { permissions: { deny: ['Bash'] } })
    world.put('flag', { permissions: { deny: ['Bash'] } })
    world.put('user', { permissions: { deny: ['Bash'] } })
    const before = (['managed', 'flag', 'user'] as Layer[]).map(l => world.text(l))
    expect(deletePermissionRuleFromSettings(rule(source, 'deny', 'Bash'))).toBe(false)
    expect((['managed', 'flag', 'user'] as Layer[]).map(l => world.text(l))).toEqual(before)
  })

  test('deleting still works while only managed rules count', () => {
    world.put('managed', { allowManagedPermissionRulesOnly: true })
    world.put('local', { permissions: { allow: ['Bash'] } })
    expect(deletePermissionRuleFromSettings(rule('localSettings', 'allow', 'Bash'))).toBe(true)
    expect(world.json('local').permissions).toEqual({ allow: [] })
  })

  test('a deleted deny rule is out of force on the next read', () => {
    world.put('project', { permissions: { deny: ['WebFetch', 'Bash'] } })
    deletePermissionRuleFromSettings(rule('projectSettings', 'deny', 'WebFetch'))
    expect(loadedAll()).toEqual(['projectSettings deny Bash'])
  })
})
