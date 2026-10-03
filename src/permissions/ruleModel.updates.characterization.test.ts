/**
 * Permission updates: the message the dialogs, the CLI and SDK hosts use to
 * change what is allowed. One update is applied to the session's permission
 * context in memory, and persisted to a settings file when its destination
 * is a file.
 *
 * Contexts are built from scratch; files live in a temp world (see
 * __testutils__/ruleModelWorld).
 */
import { describe, expect, test } from 'bun:test'
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  createReadRuleSuggestion,
  extractRules,
  persistPermissionUpdate,
  persistPermissionUpdates,
  supportsPersistence,
} from 'src/permissions/PermissionUpdate.js'
import {
  permissionUpdateDestinationSchema,
  permissionUpdateSchema,
  type PermissionUpdate,
} from 'src/permissions/PermissionUpdateSchema.js'
import { type Layer, useRuleModelWorld } from 'src/permissions/__testutils__/ruleModelWorld.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = useRuleModelWorld('rule-updates')

const KIND = { allow: 'alwaysAllowRules', deny: 'alwaysDenyRules', ask: 'alwaysAskRules' } as const

function contextWith(rules: Partial<Record<keyof typeof KIND, Record<string, string[]>>> = {}): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  return {
    ...base,
    alwaysAllowRules: rules.allow ?? {},
    alwaysDenyRules: rules.deny ?? {},
    alwaysAskRules: rules.ask ?? {},
    additionalWorkingDirectories: new Map([['/work/old', { path: '/work/old', source: 'userSettings' }]]),
  } as ToolPermissionContext
}

const dirsOf = (ctx: ToolPermissionContext) => Object.fromEntries(ctx.additionalWorkingDirectories)

describe('applying an update in memory', () => {
  const behaviors: Array<'allow' | 'deny' | 'ask'> = ['allow', 'deny', 'ask']

  test.each(behaviors)('adding %s rules appends their strings to that destination only', behavior => {
    const ctx = contextWith({ [behavior]: { session: ['Glob'], userSettings: ['Read'] } })
    const next = applyPermissionUpdate(ctx, {
      type: 'addRules',
      behavior,
      destination: 'session',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }, { toolName: 'Bash', ruleContent: 'a(b)' }, { toolName: 'Edit' }],
    })
    expect(next[KIND[behavior]]).toEqual({
      session: ['Glob', 'Bash(git status)', String.raw`Bash(a\(b\))`, 'Edit'],
      userSettings: ['Read'],
    })
    for (const other of behaviors.filter(b => b !== behavior)) expect(next[KIND[other]]).toEqual(ctx[KIND[other]])
  })

  test('adding to a destination with no list yet starts one', () => {
    const next = applyPermissionUpdate(contextWith(), { type: 'addRules', behavior: 'deny', destination: 'cliArg', rules: [{ toolName: 'WebFetch' }] })
    expect(next.alwaysDenyRules).toEqual({ cliArg: ['WebFetch'] })
  })

  test.each(behaviors)('replacing %s rules swaps that destination list and nothing else', behavior => {
    const ctx = contextWith({ [behavior]: { localSettings: ['A', 'B'], projectSettings: ['C'] } })
    const next = applyPermissionUpdate(ctx, { type: 'replaceRules', behavior, destination: 'localSettings', rules: [{ toolName: 'D', ruleContent: 'x' }] })
    expect(next[KIND[behavior]]).toEqual({ localSettings: ['D(x)'], projectSettings: ['C'] })
    const cleared = applyPermissionUpdate(ctx, { type: 'replaceRules', behavior, destination: 'localSettings', rules: [] })
    expect(cleared[KIND[behavior]]).toEqual({ localSettings: [], projectSettings: ['C'] })
  })

  test.each(behaviors)('removing %s rules drops matching strings from that destination only', behavior => {
    const ctx = contextWith({ [behavior]: { session: ['Bash', 'Bash(ls)', String.raw`Bash(a\(b\))`, 'Read'], userSettings: ['Bash'] } })
    const next = applyPermissionUpdate(ctx, {
      type: 'removeRules',
      behavior,
      destination: 'session',
      rules: [{ toolName: 'Bash' }, { toolName: 'Bash', ruleContent: 'a(b)' }, { toolName: 'Nope' }],
    })
    expect(next[KIND[behavior]]).toEqual({ session: ['Bash(ls)', 'Read'], userSettings: ['Bash'] })
  })

  test('removing from a destination with no list leaves an empty one', () => {
    const next = applyPermissionUpdate(contextWith(), { type: 'removeRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] })
    expect(next.alwaysAllowRules).toEqual({ session: [] })
  })

  test('setting the mode changes the mode only', () => {
    const ctx = contextWith({ allow: { session: ['Read'] } })
    const next = applyPermissionUpdate(ctx, { type: 'setMode', mode: 'acceptEdits', destination: 'session' })
    expect(next).toEqual({ ...ctx, mode: 'acceptEdits' })
  })

  test('adding directories records each with the update destination as its source', () => {
    const next = applyPermissionUpdate(contextWith(), { type: 'addDirectories', destination: 'session', directories: ['/work/a', '/work/old'] })
    expect(dirsOf(next)).toEqual({
      '/work/old': { path: '/work/old', source: 'session' },
      '/work/a': { path: '/work/a', source: 'session' },
    })
  })

  test('removing directories forgets them, and unknown ones are ignored', () => {
    const ctx = applyPermissionUpdate(contextWith(), { type: 'addDirectories', destination: 'localSettings', directories: ['/work/a'] })
    const next = applyPermissionUpdate(ctx, { type: 'removeDirectories', destination: 'localSettings', directories: ['/work/old', '/never'] })
    expect(dirsOf(next)).toEqual({ '/work/a': { path: '/work/a', source: 'localSettings' } })
  })

  test('the context given is never changed', () => {
    const ctx = contextWith({ allow: { session: ['Read'] }, deny: { session: ['Bash'] }, ask: { session: ['Edit'] } })
    const snapshot = { ...ctx, dirs: dirsOf(ctx), allow: structuredClone(ctx.alwaysAllowRules), deny: structuredClone(ctx.alwaysDenyRules), ask: structuredClone(ctx.alwaysAskRules) }
    const updates: PermissionUpdate[] = [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Glob' }] },
      { type: 'replaceRules', behavior: 'deny', destination: 'session', rules: [] },
      { type: 'removeRules', behavior: 'ask', destination: 'session', rules: [{ toolName: 'Edit' }] },
      { type: 'addDirectories', destination: 'session', directories: ['/x'] },
      { type: 'removeDirectories', destination: 'session', directories: ['/work/old'] },
      { type: 'setMode', destination: 'session', mode: 'plan' },
    ]
    for (const update of updates) expect(applyPermissionUpdate(ctx, update)).not.toBe(ctx)
    expect(ctx.mode).toBe(snapshot.mode)
    expect(dirsOf(ctx)).toEqual(snapshot.dirs)
    expect([ctx.alwaysAllowRules, ctx.alwaysDenyRules, ctx.alwaysAskRules]).toEqual([snapshot.allow, snapshot.deny, snapshot.ask])
  })

  test('an update of an unknown type returns the very same context', () => {
    const ctx = contextWith()
    expect(applyPermissionUpdate(ctx, { type: 'grantEverything' } as unknown as PermissionUpdate)).toBe(ctx)
  })

  test('a list of updates is applied in order', () => {
    const add: PermissionUpdate = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }
    const remove: PermissionUpdate = { type: 'removeRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }
    expect(applyPermissionUpdates(contextWith(), [add, remove]).alwaysAllowRules).toEqual({ session: [] })
    expect(applyPermissionUpdates(contextWith(), [remove, add]).alwaysAllowRules).toEqual({ session: ['Bash'] })
    expect(applyPermissionUpdates(contextWith(), [
      { type: 'setMode', destination: 'session', mode: 'plan' },
      { type: 'setMode', destination: 'session', mode: 'dontAsk' },
    ]).mode).toBe('dontAsk')
  })

  test('an empty list of updates changes nothing', () => {
    const ctx = contextWith({ deny: { session: ['Bash'] } })
    expect(applyPermissionUpdates(ctx, [])).toEqual(ctx)
  })
})

describe('the rules an update list adds', () => {
  test('only rules from addRules updates count, in order', () => {
    const updates: PermissionUpdate[] = [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Read' }] },
      { type: 'replaceRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Edit' }] },
      { type: 'removeRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Glob' }] },
      { type: 'setMode', destination: 'session', mode: 'plan' },
      { type: 'addDirectories', destination: 'session', directories: ['/x'] },
      { type: 'addRules', behavior: 'deny', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'rm' }, { toolName: 'Grep' }] },
    ]
    expect(extractRules(updates)).toEqual([{ toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'rm' }, { toolName: 'Grep' }])
  })

  test('no list means no rules', () => {
    expect(extractRules(undefined)).toEqual([])
    expect(extractRules([])).toEqual([])
  })
})

describe('where an update can be saved', () => {
  const destinations: Array<[destination: string, persists: boolean]> = [
    ['userSettings', true],
    ['projectSettings', true],
    ['localSettings', true],
    ['session', false],
    ['cliArg', false],
    ['policySettings', false],
    ['flagSettings', false],
  ]
  test.each(destinations)('%s is a file: %p', (destination, persists) => {
    expect(supportsPersistence(destination as 'session')).toBe(persists)
  })
})

describe('a Read rule suggested for a directory', () => {
  test('the suggestion is one session allow rule for Read', () => {
    expect(createReadRuleSuggestion('/home/me/project')).toEqual({
      type: 'addRules',
      rules: [{ toolName: 'Read', ruleContent: '//home/me/project/**' }],
      behavior: 'allow',
      destination: 'session',
    })
  })

  test('an absolute directory gets a leading double slash, a relative one stays relative', () => {
    const patternFor = (dir: string) => {
      const suggestion = createReadRuleSuggestion(dir)
      return suggestion?.type === 'addRules' ? suggestion.rules.map(rule => rule.ruleContent).join() : undefined
    }
    expect({
      absolute: ['/tmp', '/home/me/project'].map(patternFor),
      relative: ['src', 'packages/app', '.'].map(patternFor),
    }).toEqual({
      absolute: ['//tmp/**', '//home/me/project/**'],
      relative: ['src/**', 'packages/app/**', './**'],
    })
  })

  test('the destination can be chosen', () => {
    expect(createReadRuleSuggestion('/a', 'localSettings')?.destination).toBe('localSettings')
  })

  test('the filesystem root is never suggested', () => {
    expect(createReadRuleSuggestion('/')).toBeUndefined()
    expect(createReadRuleSuggestion('/', 'userSettings')).toBeUndefined()
  })
})

describe('the update schema', () => {
  const valid: PermissionUpdate[] = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' },
    { type: 'replaceRules', rules: [], behavior: 'deny', destination: 'userSettings' },
    { type: 'removeRules', rules: [{ toolName: 'Read' }], behavior: 'ask', destination: 'projectSettings' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/a', 'b'], destination: 'cliArg' },
    { type: 'removeDirectories', directories: [], destination: 'session' },
  ]
  test.each(valid)('accepts a $type update', update => {
    expect(permissionUpdateSchema().parse(update)).toEqual(update)
  })

  test('the destinations are the three files, the session and the command line', () => {
    const accepted = ['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg', 'policySettings', 'flagSettings', 'command', '']
      .filter(d => permissionUpdateDestinationSchema().safeParse(d).success)
    expect(accepted).toEqual(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
  })

  const invalid: Array<[why: string, update: unknown]> = [
    ['an unknown type', { type: 'grant', destination: 'session' }],
    ['a managed destination', { type: 'addRules', rules: [], behavior: 'allow', destination: 'policySettings' }],
    ['the --settings destination', { type: 'setMode', mode: 'plan', destination: 'flagSettings' }],
    ['a passthrough behavior', { type: 'addRules', rules: [], behavior: 'passthrough', destination: 'session' }],
    ['the internal auto mode', { type: 'setMode', mode: 'auto', destination: 'session' }],
    ['the internal bubble mode', { type: 'setMode', mode: 'bubble', destination: 'session' }],
    ['a rule without a tool name', { type: 'addRules', rules: [{ ruleContent: 'x' }], behavior: 'allow', destination: 'session' }],
    ['a rule given as a string', { type: 'addRules', rules: ['Bash'], behavior: 'allow', destination: 'session' }],
    ['a directory that is not a string', { type: 'addDirectories', directories: [1], destination: 'session' }],
    ['no destination', { type: 'setMode', mode: 'plan' }],
  ]
  test.each(invalid)('rejects %s', (_why, update) => {
    expect(permissionUpdateSchema().safeParse(update).success).toBe(false)
  })
})

describe('persisting an update', () => {
  const files: Layer[] = ['user', 'project', 'local', 'managed']
  const snapshot = () => files.map(l => world.text(l))

  test('session and command-line updates write no file', () => {
    const updates: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'cliArg' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'addDirectories', directories: ['/x'], destination: 'cliArg' },
    ]
    persistPermissionUpdates(updates)
    expect(snapshot()).toEqual([null, null, null, null])
  })

  test('added rules land in the file, after the rules already there, without repeats', () => {
    world.put('local', { permissions: { allow: ['Read', 'Bash(*)'] } })
    persistPermissionUpdate({ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash' }, { toolName: 'Edit' }] })
    expect(world.json('local').permissions.allow).toEqual(['Read', 'Bash(*)', 'Edit'])
  })

  test('added rules are refused while only managed rules count', () => {
    world.put('managed', { allowManagedPermissionRulesOnly: true })
    persistPermissionUpdate({ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash' }] })
    expect(world.text('user')).toBeNull()
  })

  test('removed rules leave the file under every spelling, other lists untouched', () => {
    world.put('project', { permissions: { deny: ['Bash', 'Bash(*)', 'KillShell', 'Read'], allow: ['Bash'] }, model: 'm' })
    persistPermissionUpdate({ type: 'removeRules', behavior: 'deny', destination: 'projectSettings', rules: [{ toolName: 'Bash' }, { toolName: 'TaskStop' }] })
    expect(world.json('project')).toEqual({ permissions: { deny: ['Read'], allow: ['Bash'] }, model: 'm' })
  })

  test('replaced rules overwrite that behavior list in written form', () => {
    world.put('user', { permissions: { ask: ['Old'], deny: ['Keep'] } })
    persistPermissionUpdate({ type: 'replaceRules', behavior: 'ask', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'f(x)' }, { toolName: 'Edit' }] })
    expect(world.json('user').permissions).toEqual({ ask: [String.raw`Bash(f\(x\))`, 'Edit'], deny: ['Keep'] })
  })

  test('the mode is written as the default mode', () => {
    world.put('local', { permissions: { allow: ['Read'] } })
    persistPermissionUpdate({ type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' })
    expect(world.json('local').permissions).toEqual({ allow: ['Read'], defaultMode: 'acceptEdits' })
  })

  test('added directories go after the existing ones, without repeats', () => {
    world.put('user', { permissions: { additionalDirectories: ['/a'], allow: ['Read'] } })
    persistPermissionUpdate({ type: 'addDirectories', destination: 'userSettings', directories: ['/a', '/b', '/c'] })
    expect(world.json('user').permissions).toEqual({ additionalDirectories: ['/a', '/b', '/c'], allow: ['Read'] })
  })

  test('directories already listed leave the file as it was', () => {
    const before = JSON.stringify({ permissions: { additionalDirectories: ['/a'] } })
    world.put('user', before)
    persistPermissionUpdate({ type: 'addDirectories', destination: 'userSettings', directories: ['/a'] })
    expect(world.text('user')).toBe(before)
  })

  test('removed directories leave the list', () => {
    world.put('project', { permissions: { additionalDirectories: ['/a', '/b', '/c'] } })
    persistPermissionUpdate({ type: 'removeDirectories', destination: 'projectSettings', directories: ['/b', '/zz'] })
    expect(world.json('project').permissions.additionalDirectories).toEqual(['/a', '/c'])
  })

  test('a list of updates is persisted in order', () => {
    persistPermissionUpdates([
      { type: 'addRules', behavior: 'deny', destination: 'localSettings', rules: [{ toolName: 'WebFetch' }, { toolName: 'Bash' }] },
      { type: 'removeRules', behavior: 'deny', destination: 'localSettings', rules: [{ toolName: 'WebFetch' }] },
      { type: 'setMode', mode: 'plan', destination: 'userSettings' },
    ])
    expect(world.json('local').permissions).toEqual({ deny: ['Bash'] })
    expect(world.json('user').permissions).toEqual({ defaultMode: 'plan' })
  })
})
