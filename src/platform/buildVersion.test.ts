import { afterEach, describe, expect, test } from 'bun:test'

import { getDisplayVersion } from 'src/platform/buildVersion.js'

// Other suites install a `MACRO` global and leave it, so each test sets the
// one it needs and the file puts the original back.
const saved = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')

function setMacro(descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as { MACRO?: unknown }).MACRO
  if (descriptor) Object.defineProperty(globalThis, 'MACRO', descriptor)
}

afterEach(() => setMacro(saved))

describe('getDisplayVersion', () => {
  test('reads the version the build inlined', () => {
    setMacro({ value: { DISPLAY_VERSION: '1.2.3' }, configurable: true, writable: true })

    expect(getDisplayVersion()).toBe('1.2.3')
  })

  test('is undefined where nothing defines MACRO', () => {
    setMacro(undefined)

    expect(getDisplayVersion()).toBeUndefined()
  })

  test('is undefined where a suite left MACRO holding undefined', () => {
    // What `globalThis.MACRO = original` leaves when the original was unset
    // (StartupScreen.test.ts, claudinInstallSurfaces.test.ts): the property
    // exists, and reading through it is a TypeError, not a ReferenceError.
    setMacro({ value: undefined, configurable: true, writable: true })

    expect(getDisplayVersion()).toBeUndefined()
  })

  test('lets any other failure through', () => {
    setMacro({
      get() {
        throw new TypeError('not a reference error')
      },
      configurable: true,
    })

    expect(() => getDisplayVersion()).toThrow(TypeError)
  })
})
