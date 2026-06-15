import { test, expect } from 'bun:test'
import { colorize } from './colorize.js'

test("'terminal' sentinel emits no escape (inherits terminal default)", () => {
  // Passthrough regardless of chalk's color level — the sentinel must never
  // wrap the string, so the terminal's own default fg/bg shows through.
  expect(colorize('hello', 'terminal', 'foreground')).toBe('hello')
  expect(colorize('hello', 'terminal', 'background')).toBe('hello')
})
