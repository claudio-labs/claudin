/**
 * Permission modes as callers see them: the names a setting or a flag may
 * carry, how a mode is labelled in the footer, the settings pane and the
 * "requires approval" message the model reads, and how an internal mode is
 * reported to an SDK host.
 *
 * Auto mode exists only in a build with the TRANSCRIPT_CLASSIFIER flag. The
 * shipped build turns it on (`scripts/build/build.ts`), plain `bun test`
 * leaves it off. So this file runs twice: in-process with the flag off, and
 * in a child `bun test --feature=TRANSCRIPT_CLASSIFIER`, started by the first
 * run, where auto mode is checked. The first run fails if the child does.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  externalPermissionModeSchema,
  getModeColor,
  isDefaultMode,
  isExternalPermissionMode,
  permissionModeFromString,
  permissionModeSchema,
  permissionModeSymbol,
  permissionModeTitle,
  toExternalPermissionMode,
  type PermissionMode,
} from 'src/permissions/PermissionMode.js'

// `feature()` must sit directly in a ternary condition under `bun test`.
const CLASSIFIER_BUILD = feature('TRANSCRIPT_CLASSIFIER') ? true : false

type Face = { title: string; symbol: string; color: string; external: string }
const DEFAULT_FACE: Face = { title: 'Default', symbol: '', color: 'text', external: 'default' }

const faces: Array<[mode: string, face: Face]> = [
  ['default', DEFAULT_FACE],
  ['plan', { title: 'Plan Mode', symbol: '\u23f8', color: 'planMode', external: 'plan' }],
  ['acceptEdits', { title: 'Accept edits', symbol: '\u23f5\u23f5', color: 'autoAccept', external: 'acceptEdits' }],
  ['bypassPermissions', { title: 'Bypass Permissions', symbol: '\u23f5\u23f5', color: 'error', external: 'bypassPermissions' }],
  ['dontAsk', { title: "Don't Ask", symbol: '\u23f5\u23f5', color: 'error', external: 'dontAsk' }],
]

const faceOf = (mode: string): Face => {
  const m = mode as PermissionMode
  return {
    title: permissionModeTitle(m),
    symbol: permissionModeSymbol(m),
    color: getModeColor(m),
    external: toExternalPermissionMode(m),
  }
}

describe('in every build', () => {
  test.each(faces)('%s has its title, symbol, colour and external name', (mode, face) => {
    expect(faceOf(mode)).toEqual(face)
    expect(isExternalPermissionMode(mode as PermissionMode)).toBe(true)
  })

  test('the external modes are exactly five, in this order', () => {
    expect([...EXTERNAL_PERMISSION_MODES]).toEqual(['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
  })

  test('the bubble mode and unknown names fall back to the default face', () => {
    for (const mode of ['bubble', 'nonsense', '']) expect(faceOf(mode)).toEqual(DEFAULT_FACE)
  })

  test('only default, or no mode at all, counts as the default mode', () => {
    const named = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'bubble']
    expect(named.filter(m => isDefaultMode(m as PermissionMode))).toEqual(['default'])
    expect(isDefaultMode(undefined)).toBe(true)
  })

  test('each external mode name reads as itself', () => {
    expect(EXTERNAL_PERMISSION_MODES.map(permissionModeFromString)).toEqual([...EXTERNAL_PERMISSION_MODES])
  })

  test('any other string, near misses included, falls back to default', () => {
    const strays = ['Plan', 'PLAN', ' plan', 'plan ', 'accept-edits', 'DontAsk', 'bubble', '', '__proto__', 'constructor']
    const read = new Set(strays.map(permissionModeFromString))
    expect([...read]).toEqual(['default'])
  })

  test('an SDK host may only name an external mode', () => {
    const schema = externalPermissionModeSchema()
    const ok = ['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan', 'auto', 'bubble', 'Plan', '']
      .filter(v => schema.safeParse(v).success)
    expect(ok).toEqual(['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'])
  })

  test('the mode schema accepts exactly the addressable modes', () => {
    const schema = permissionModeSchema()
    for (const mode of PERMISSION_MODES) expect(schema.safeParse(mode).success).toBe(true)
    for (const v of ['bubble', 'Default', '', 7, null]) expect(schema.safeParse(v).success).toBe(false)
  })
})

if (!CLASSIFIER_BUILD) {
  describe('without the classifier build flag', () => {
    test('auto mode is not addressable', () => {
      expect([...PERMISSION_MODES]).toEqual([...EXTERNAL_PERMISSION_MODES])
      expect(permissionModeFromString('auto')).toBe('default')
      expect(permissionModeSchema().safeParse('auto').success).toBe(false)
    })

    test('auto, if it shows up anyway, looks like the default mode but is not external', () => {
      expect(faceOf('auto')).toEqual(DEFAULT_FACE)
      expect(isExternalPermissionMode('auto')).toBe(false)
    })
  })

  test('with the classifier build flag, auto mode behaves as shipped', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path],
      {
        cwd: resolve(import.meta.dir, '..', '..'),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (code !== 0 || failed !== 0 || passed < 16) {
      throw new Error(`the TRANSCRIPT_CLASSIFIER run failed (exit ${code}):\n${report.slice(-6_000)}`)
    }
  }, 120_000)
} else {
  describe('with the classifier build flag', () => {
    test('auto joins the addressable modes, last', () => {
      expect([...PERMISSION_MODES]).toEqual([...EXTERNAL_PERMISSION_MODES, 'auto'])
      expect(permissionModeFromString('auto')).toBe('auto')
      expect(permissionModeSchema().safeParse('auto').success).toBe(true)
    })

    test('auto has its own face and reports itself to an SDK host as default', () => {
      expect(faceOf('auto')).toEqual({ title: 'Auto mode', symbol: '\u23f5\u23f5', color: 'warning', external: 'default' })
    })

    test('auto is internal: not external, and not accepted from an SDK host', () => {
      expect(isExternalPermissionMode('auto')).toBe(false)
      expect(externalPermissionModeSchema().safeParse('auto').success).toBe(false)
    })

    test('auto is not the default mode', () => {
      expect(isDefaultMode('auto')).toBe(false)
    })
  })
}
