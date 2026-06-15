import { test, expect } from 'bun:test'
import { getTheme } from './theme.js'

test("'terminal' theme exposes the full palette", () => {
  const ref = Object.keys(getTheme('dark'))
  const terminal = getTheme('terminal')
  expect(Object.keys(terminal).length).toBe(ref.length)
  for (const key of ref) {
    expect(terminal).toHaveProperty(key)
  }
})

test("'terminal' theme inherits terminal fg and uses neutral gray for dimmed/border", () => {
  const t = getTheme('terminal')
  // Inherit the terminal's default foreground (sentinel → no escape in colorize)
  expect(t.text).toBe('terminal')
  expect(t.inverseText).toBe('terminal')
  // Neutral gray, legible on both light and dark terminals
  expect(t.inactive).toBe('ansi:blackBright')
  expect(t.subtle).toBe('ansi:blackBright')
  expect(t.promptBorder).toBe('ansi:blackBright')
})
