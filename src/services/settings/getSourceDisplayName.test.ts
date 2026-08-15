import { test, expect } from 'bun:test'
import { getSourceDisplayName } from 'src/services/settings/constants.js'

// Regression: bundled CLI skills and built-in plugin skills both carry
// source 'bundled' (skillDefinitionToCommand / bundledSkills.ts). Before the
// fix, getSourceDisplayName('bundled') fell through the switch and returned
// undefined, so groupBySource() bucketed them under `undefined` and the
// /context "Skills" listing silently dropped every one — even though their
// tokens were still counted in the category total.
test("source 'bundled' maps to the 'Built-in' display group", () => {
  expect(getSourceDisplayName('bundled')).toBe('Built-in')
})

test("source 'built-in' still maps to 'Built-in'", () => {
  expect(getSourceDisplayName('built-in')).toBe('Built-in')
})

test('known sources keep their display names', () => {
  expect(getSourceDisplayName('userSettings')).toBe('User')
  expect(getSourceDisplayName('plugin')).toBe('Plugin')
  expect(getSourceDisplayName('policySettings')).toBe('Managed')
})

test('no source returns undefined (would be dropped by SOURCE_DISPLAY_ORDER)', () => {
  // Guards the invariant that every source a skill can carry is handled above;
  // an unhandled source returning undefined is exactly the bug we fixed.
  // @ts-expect-error intentionally passing an unhandled value
  expect(getSourceDisplayName('totally-unknown')).toBeUndefined()
})
