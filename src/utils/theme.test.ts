import { test, expect } from 'bun:test'
import { getTheme, THEME_NAMES } from './theme.js'

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

test('bashBorder is a mode accent, never the error color', () => {
  // The prompt border, the `!` char and the Bash label all take bashBorder. If a
  // theme aliases it to `error`, entering bash mode looks like a failure instead
  // of a mode. Tokyo Night, Nord and Gruvbox Dark each used to do exactly that.
  for (const name of THEME_NAMES) {
    const t = getTheme(name)
    expect(`${name}: ${t.bashBorder}`).not.toBe(`${name}: ${t.error}`)
  }
})
