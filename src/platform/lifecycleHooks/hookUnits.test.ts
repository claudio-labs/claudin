import { describe, expect, test } from 'bun:test'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  foldPermissionRequestUnits,
  foldPreToolUseUnits,
} from 'src/platform/lifecycleHooks/hookUnits.js'
import type { PermissionUpdate } from 'src/shared/types/permissions.js'
import type { HookUnits } from 'src/tools/Tool.js'

const HOOK = 'PreToolUse:Read'

/** Units named by `labels`; merge records what it was handed, or refuses. */
function unitsNamed(labels: string[], refusal?: string): HookUnits & { merged: unknown[] } {
  const merged: unknown[] = []
  return {
    merged,
    inputs: labels.map(label => ({ file_path: `/r/${label}` })),
    label: i => labels[i] ?? '',
    merge: updated => {
      merged.push(updated)
      return refusal ? { refusal } : { input: { file_paths: updated.map((u, i) => u?.file_path ?? `/r/${labels[i]}`) } }
    },
  }
}

const allow = (extra: Partial<PermissionResult> = {}): PermissionResult =>
  ({ behavior: 'allow', decisionReason: { type: 'hook', hookName: HOOK }, ...extra }) as PermissionResult
const ask = (message: string, hookSource?: string): PermissionResult => ({
  behavior: 'ask',
  message,
  decisionReason: { type: 'hook', hookName: HOOK, ...(hookSource && { hookSource }) },
})
const deny = (message: string): PermissionResult => ({
  behavior: 'deny',
  message,
  decisionReason: { type: 'hook', hookName: HOOK, reason: message },
})

describe('foldPreToolUseUnits', () => {
  test('any deny denies the call, naming each denied unit with its reason', () => {
    const units = unitsNamed(['a.ts', 'b.secret', 'c.secret'])
    const verdict = foldPreToolUseUnits(units, [allow(), deny('no'), deny('never')], [], HOOK)
    expect(verdict).toEqual({
      permission: {
        behavior: 'deny',
        message:
          'PreToolUse:Read hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
          '- b.secret: no\n- c.secret: never',
        decisionReason: {
          type: 'hook',
          hookName: HOOK,
          reason:
            'PreToolUse:Read hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
            '- b.secret: no\n- c.secret: never',
        },
      },
    })
    // A deny outranks an ask, and nothing is merged for a call that will not run.
    expect(foldPreToolUseUnits(units, [ask('?'), deny('no')], [{ file_path: '/x' }], HOOK).permission?.behavior).toBe(
      'deny',
    )
    expect(units.merged).toEqual([])
  })

  test('a deny of every unit says so', () => {
    const units = unitsNamed(['a.secret', 'b.secret'])
    const verdict = foldPreToolUseUnits(units, [deny('no'), deny('no')], [], HOOK)
    expect(verdict.permission).toMatchObject({
      behavior: 'deny',
      message: 'PreToolUse:Read hook denied every part of this call:\n- a.secret: no\n- b.secret: no',
    })
  })

  test('any ask is ONE ask naming the units that asked', () => {
    const units = unitsNamed(['a.ts', 'b.ts', 'c.ts'])
    const verdict = foldPreToolUseUnits(units, [ask('check a', 'settings'), undefined, ask('check c')], [], HOOK)
    const message = 'PreToolUse:Read hook asks before part of this call:\n- a.ts: check a\n- c.ts: check c'
    expect(verdict).toEqual({
      permission: {
        behavior: 'ask',
        message,
        decisionReason: { type: 'hook', hookName: HOOK, hookSource: 'settings', reason: message },
      },
    })
  })

  test('an allow from every unit allows the call; an allow from some decides nothing', () => {
    const units = unitsNamed(['a.ts', 'b.ts'])
    expect(foldPreToolUseUnits(units, [allow(), allow()], [], HOOK)).toEqual({
      permission: { behavior: 'allow', decisionReason: { type: 'hook', hookName: HOOK } },
    })
    expect(foldPreToolUseUnits(units, [allow(), undefined], [], HOOK)).toEqual({})
    expect(foldPreToolUseUnits(units, [], [], HOOK)).toEqual({})
  })

  test("a unit's updatedInput is its decision's, else its passthrough one; the call gets the merge", () => {
    const units = unitsNamed(['a.ts', 'b.ts', 'c.ts'])
    const verdict = foldPreToolUseUnits(
      units,
      [allow({ updatedInput: { file_path: '/r/A.ts' } } as Partial<PermissionResult>), undefined, undefined],
      [{ file_path: '/r/ignored.ts' }, { file_path: '/r/B.ts' }, undefined],
      HOOK,
    )
    expect(units.merged).toEqual([[{ file_path: '/r/A.ts' }, { file_path: '/r/B.ts' }, undefined]])
    expect(verdict).toEqual({ updatedInput: { file_paths: ['/r/A.ts', '/r/B.ts', '/r/c.ts'] } })
  })

  test('a merge the call cannot carry denies it with the reason', () => {
    const units = unitsNamed(['a.ts', 'b.ts'], 'cannot carry a.ts')
    expect(foldPreToolUseUnits(units, [allow(), allow()], [{ file_path: '/r/x' }], HOOK)).toEqual({
      permission: {
        behavior: 'deny',
        message: 'cannot carry a.ts',
        decisionReason: { type: 'hook', hookName: HOOK, reason: 'cannot carry a.ts' },
      },
    })
  })
})

describe('foldPermissionRequestUnits', () => {
  test('any deny is the decision, naming each file; an interrupt from any unit interrupts', () => {
    const units = unitsNamed(['a.ts', 'b.secret'])
    expect(
      foldPermissionRequestUnits(units, [
        { behavior: 'allow' },
        { behavior: 'deny', message: 'no secrets', interrupt: true },
      ]),
    ).toEqual({
      behavior: 'deny',
      message:
        'PermissionRequest hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
        '- b.secret: no secrets',
      interrupt: true,
    })
    expect(foldPermissionRequestUnits(units, [undefined, { behavior: 'deny' }])).toEqual({
      behavior: 'deny',
      message:
        'PermissionRequest hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
        '- b.secret: Permission denied by hook',
    })
  })

  test('an allow from every unit allows, with the merged input and each rule once', () => {
    const units = unitsNamed(['a.ts', 'b.ts'])
    const rule: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'Read' }],
      behavior: 'allow',
      destination: 'session',
    }
    expect(
      foldPermissionRequestUnits(units, [
        { behavior: 'allow', updatedPermissions: [rule] },
        { behavior: 'allow', updatedInput: { file_path: '/r/B.ts' }, updatedPermissions: [rule] },
      ]),
    ).toEqual({
      behavior: 'allow',
      updatedInput: { file_paths: ['/r/a.ts', '/r/B.ts'] },
      updatedPermissions: [rule],
    })
    expect(foldPermissionRequestUnits(units, [{ behavior: 'allow' }, { behavior: 'allow' }])).toEqual({
      behavior: 'allow',
    })
  })

  test('an allow from some units leaves the call to the prompt', () => {
    const units = unitsNamed(['a.ts', 'b.ts'])
    expect(foldPermissionRequestUnits(units, [{ behavior: 'allow' }, undefined])).toBeUndefined()
    expect(foldPermissionRequestUnits(units, [])).toBeUndefined()
  })

  test('an allow whose input the call cannot carry is a deny', () => {
    const units = unitsNamed(['a.ts', 'b.ts'], 'cannot carry b.ts')
    expect(
      foldPermissionRequestUnits(units, [
        { behavior: 'allow' },
        { behavior: 'allow', updatedInput: { file_path: '/r/b.ts', view: 'outline' } },
      ]),
    ).toEqual({ behavior: 'deny', message: 'cannot carry b.ts' })
  })
})
