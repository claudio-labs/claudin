import { describe, expect, test } from 'bun:test'

import { validatePermissionRule } from 'src/platform/settings/permissionValidation.js'
import { getCustomValidation } from 'src/platform/settings/toolValidationConfig.js'
import { filterInvalidPermissionRules } from 'src/platform/settings/validation.js'

/**
 * `getCustomValidation` used to index its table directly, so a permission rule
 * named `__proto__` resolved to `Object.prototype` — truthy, and then invoked.
 * The uppercase gate does not stop it (`'_'.toUpperCase() === '_'`), and the
 * resulting TypeError escapes all the way to `parseSettingsFileUncached`,
 * whose catch returns `{ settings: null, errors: [] }`: the entire settings
 * file is discarded, deny rules included, with nothing reported.
 */
describe('permission rules named after prototype-chain keys', () => {
  test('getCustomValidation answers undefined, not Object.prototype', () => {
    expect(getCustomValidation('__proto__')).toBeUndefined()
    expect(getCustomValidation('constructor')).toBeUndefined()
    expect(getCustomValidation('toString')).toBeUndefined()
  })

  test('the real validators are still reachable', () => {
    expect(typeof getCustomValidation('WebSearch')).toBe('function')
    expect(getCustomValidation('WebSearch')!('a*b').valid).toBe(false)
  })

  test('a __proto__ rule validates like any other unknown tool', () => {
    expect(() => validatePermissionRule('__proto__(x)')).not.toThrow()
    expect(validatePermissionRule('__proto__(x)')).toEqual(
      validatePermissionRule('Unknowntool(x)'),
    )
  })

  // The blast radius: one such rule anywhere in the file used to take every
  // other rule down with it.
  test('a __proto__ rule does not void the rest of the permission lists', () => {
    const data = {
      permissions: {
        deny: ['__proto__(x)', 'Bash(rm:*)'],
        allow: ['Read(**)'],
      },
    }

    expect(() =>
      filterInvalidPermissionRules(data, '/tmp/settings.json'),
    ).not.toThrow()
    expect(data.permissions.deny).toContain('Bash(rm:*)')
    expect(data.permissions.allow).toContain('Read(**)')
  })
})
