/**
 * The auto-mode dangerous-rule stash: strip on the way in, restore on the way
 * out, and never persist a removal to a source that cannot be written.
 *
 * All three functions are pure transforms over ToolPermissionContext —
 * `applyPermissionUpdate` is in-memory only, persistence is a separate call —
 * so nothing here touches disk or settings.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import {
  findDangerousClassifierPermissions,
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

function ctx(
  alwaysAllowRules: Record<string, string[]>,
  extra: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules,
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...extra,
  } as ToolPermissionContext
}

function allowRule(
  toolName: string,
  ruleContent: string | undefined,
  source: PermissionRule['source'],
): PermissionRule {
  return { source, ruleBehavior: 'allow', ruleValue: { toolName, ruleContent } }
}

describe('removeDangerousPermissions', () => {
  test('removes the rule from the source it came from', () => {
    const before = ctx({
      localSettings: ['Bash(python:*)', 'Bash(git status:*)'],
    })
    const after = removeDangerousPermissions(
      before,
      findDangerousClassifierPermissions(
        [allowRule('Bash', 'python:*', 'localSettings')],
        [],
      ),
    )
    expect(after.alwaysAllowRules.localSettings).toEqual(['Bash(git status:*)'])
  })

  test('leaves the other sources untouched', () => {
    const before = ctx({
      localSettings: ['Bash(python:*)'],
      userSettings: ['Bash(python:*)'],
    })
    const after = removeDangerousPermissions(
      before,
      findDangerousClassifierPermissions(
        [allowRule('Bash', 'python:*', 'localSettings')],
        [],
      ),
    )
    expect(after.alwaysAllowRules.localSettings).toEqual([])
    expect(after.alwaysAllowRules.userSettings).toEqual(['Bash(python:*)'])
  })

  test('a source that is not a valid update destination is skipped', () => {
    // policySettings/flagSettings/command are managed elsewhere — writing a
    // removal against them would be a no-op on disk and a lie in memory.
    const before = ctx({ policySettings: ['Bash(python:*)'] })
    const after = removeDangerousPermissions(
      before,
      findDangerousClassifierPermissions(
        [allowRule('Bash', 'python:*', 'policySettings')],
        [],
      ),
    )
    expect(after.alwaysAllowRules.policySettings).toEqual(['Bash(python:*)'])
  })

  test('removals from several sources are all applied', () => {
    const before = ctx({
      localSettings: ['Bash(python:*)'],
      userSettings: ['Agent'],
    })
    const after = removeDangerousPermissions(
      before,
      findDangerousClassifierPermissions(
        [
          allowRule('Bash', 'python:*', 'localSettings'),
          allowRule('Agent', undefined, 'userSettings'),
        ],
        [],
      ),
    )
    expect(after.alwaysAllowRules.localSettings).toEqual([])
    expect(after.alwaysAllowRules.userSettings).toEqual([])
  })
})

describe('stripDangerousPermissionsForAutoMode', () => {
  test('removes the dangerous rule and keeps the harmless one', () => {
    const after = stripDangerousPermissionsForAutoMode(
      ctx({ localSettings: ['Bash(python:*)', 'Bash(git status:*)'] }),
    )
    expect(after.alwaysAllowRules.localSettings).toEqual(['Bash(git status:*)'])
  })

  test('stashes exactly what it removed, under the same source', () => {
    const after = stripDangerousPermissionsForAutoMode(
      ctx({ localSettings: ['Bash(python:*)'], userSettings: ['Agent'] }),
    )
    expect(after.strippedDangerousRules).toEqual({
      localSettings: ['Bash(python:*)'],
      userSettings: ['Agent'],
    })
  })

  test('a context with nothing dangerous still gets an empty stash', () => {
    // Not `undefined`: restoreDangerousPermissions treats an absent stash as
    // "never stripped", and a later exit would then skip the restore path.
    const after = stripDangerousPermissionsForAutoMode(
      ctx({ localSettings: ['Bash(git status:*)'] }),
    )
    expect(after.strippedDangerousRules).toEqual({})
    expect(after.alwaysAllowRules.localSettings).toEqual(['Bash(git status:*)'])
  })

  test('an existing stash is preserved when there is nothing new to strip', () => {
    const after = stripDangerousPermissionsForAutoMode(
      ctx({}, { strippedDangerousRules: { userSettings: ['Agent'] } }),
    )
    expect(after.strippedDangerousRules).toEqual({ userSettings: ['Agent'] })
  })

  test('the stash mirrors the destination filter — an unwritable source is neither removed nor stashed', () => {
    const after = stripDangerousPermissionsForAutoMode(
      ctx({ policySettings: ['Bash(python:*)'] }),
    )
    expect(after.alwaysAllowRules.policySettings).toEqual(['Bash(python:*)'])
    expect(after.strippedDangerousRules).toEqual({})
  })

  test('a tool-wide allow is stashed by its canonical string, not as Tool(*)', () => {
    const after = stripDangerousPermissionsForAutoMode(
      ctx({ session: ['Bash'] }),
    )
    expect(after.strippedDangerousRules).toEqual({ session: ['Bash'] })
  })
})

describe('restoreDangerousPermissions', () => {
  test('strip then restore returns the original rule set', () => {
    const before = ctx({
      localSettings: ['Bash(python:*)', 'Bash(git status:*)'],
      userSettings: ['Agent'],
    })
    const restored = restoreDangerousPermissions(
      stripDangerousPermissionsForAutoMode(before),
    )
    expect([...restored.alwaysAllowRules.localSettings!].sort()).toEqual(
      ['Bash(git status:*)', 'Bash(python:*)'].sort(),
    )
    expect(restored.alwaysAllowRules.userSettings).toEqual(['Agent'])
  })

  test('restore clears the stash so a second exit is a no-op', () => {
    const restored = restoreDangerousPermissions(
      stripDangerousPermissionsForAutoMode(
        ctx({ localSettings: ['Bash(python:*)'] }),
      ),
    )
    expect(restored.strippedDangerousRules).toBeUndefined()

    const again = restoreDangerousPermissions(restored)
    expect(again.alwaysAllowRules.localSettings).toEqual(['Bash(python:*)'])
  })

  test('a context that was never stripped comes back unchanged, by identity', () => {
    const before = ctx({ localSettings: ['Bash(python:*)'] })
    expect(restoreDangerousPermissions(before)).toBe(before)
  })

  test('an empty per-source list does not create a key', () => {
    const restored = restoreDangerousPermissions(
      ctx({}, { strippedDangerousRules: { localSettings: [] } }),
    )
    expect(restored.alwaysAllowRules.localSettings).toBeUndefined()
  })

  test('a rule is written back to its own source, not to the session', () => {
    const restored = restoreDangerousPermissions(
      ctx({}, { strippedDangerousRules: { userSettings: ['Agent'] } }),
    )
    expect(restored.alwaysAllowRules.userSettings).toEqual(['Agent'])
    expect(restored.alwaysAllowRules.session).toBeUndefined()
  })

  test('only a source the stash names is restored — nothing unwritable can enter', () => {
    // stripDangerousPermissionsForAutoMode never stashes policySettings, so
    // the round trip cannot resurrect a rule into a source it may not write.
    const stripped = stripDangerousPermissionsForAutoMode(
      ctx({ policySettings: ['Bash(python:*)'] }),
    )
    const restored = restoreDangerousPermissions(stripped)
    expect(restored.alwaysAllowRules.policySettings).toEqual([
      'Bash(python:*)',
    ])
  })
})
