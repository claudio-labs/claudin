import { describe, expect, test } from 'bun:test'
import { posix, win32 } from 'node:path'
import { validateMemoryDirOverride } from 'src/memory/memdir/location/overrideValidation.js'

describe('the Windows rules, checked on any host', () => {
  const windows = { expandHome: true, homeDir: 'C:\\Users\\Ann', paths: win32 }

  test.each([
    ['C:\\', 'drive-root'],
    ['C:', 'relative'],
    ['\\\\server\\share\\memory', 'unc-path'],
    ['//server/share/memory', 'unc-path'],
    ['~\\', 'home-or-above'],
    ['~/..', 'home-or-above'],
  ] as const)('%p is rejected as %p', (value, reason) => {
    expect(validateMemoryDirOverride(value, windows)).toEqual({ ok: false, reason })
  })

  test('a drive path is accepted without its trailing separators', () => {
    expect(validateMemoryDirOverride('D:\\memory\\\\', windows)).toEqual({
      ok: true,
      dir: 'D:\\memory',
    })
    expect(validateMemoryDirOverride('~\\notes', windows)).toEqual({
      ok: true,
      dir: 'C:\\Users\\Ann\\notes',
    })
  })
})

describe('on POSIX', () => {
  const posixOptions = { expandHome: false, homeDir: '/home/ann', paths: posix }

  test('a leading // is an ordinary absolute path after normalization', () => {
    expect(validateMemoryDirOverride('//srv/memory', posixOptions)).toEqual({
      ok: true,
      dir: '/srv/memory',
    })
  })

  test('a value that is not a string is rejected', () => {
    expect(validateMemoryDirOverride(42, posixOptions)).toEqual({
      ok: false,
      reason: 'not-a-string',
    })
  })
})
