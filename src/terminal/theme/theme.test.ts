import { test, expect } from 'bun:test'
import { getTheme, THEME_NAMES } from 'src/terminal/theme/theme.js'

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

// A two-field fingerprint per palette. The tests above all pass if two palettes
// are swapped for each other, which is the failure a relocation can introduce
// without touching a single colour: `getTheme`'s switch keeps compiling and
// every key is still present. `success` alone does not separate 'dark-ansi'
// from 'terminal' — they share `ansi:greenBright` — so `text` is pinned too.
const PALETTE_FINGERPRINTS: Record<string, { success: string; text: string }> = {
  dark: { success: 'rgb(78,186,101)', text: 'rgb(255,255,255)' },
  light: { success: 'rgb(44,122,57)', text: 'rgb(0,0,0)' },
  'light-daltonized': { success: 'rgb(0,102,153)', text: 'rgb(0,0,0)' },
  'dark-daltonized': { success: 'rgb(51,153,255)', text: 'rgb(255,255,255)' },
  'light-ansi': { success: 'ansi:green', text: 'ansi:black' },
  'dark-ansi': { success: 'ansi:greenBright', text: 'ansi:whiteBright' },
  terminal: { success: 'ansi:greenBright', text: 'terminal' },
  dracula: { success: 'rgb(80,250,123)', text: 'rgb(248,248,242)' },
  'catppuccin-mocha': { success: 'rgb(166,227,161)', text: 'rgb(205,214,244)' },
  'catppuccin-latte': { success: 'rgb(64,160,43)', text: 'rgb(76,79,105)' },
  'tokyo-night': { success: 'rgb(158,206,106)', text: 'rgb(192,202,245)' },
  nord: { success: 'rgb(163,190,140)', text: 'rgb(236,239,244)' },
  'gruvbox-dark': { success: 'rgb(184,187,38)', text: 'rgb(235,219,178)' },
}

test('every theme name resolves to its own palette', () => {
  // Every name is fingerprinted, so adding a theme without pinning it fails here
  // rather than silently going unguarded.
  expect(Object.keys(PALETTE_FINGERPRINTS).sort()).toEqual([...THEME_NAMES].sort())
  for (const name of THEME_NAMES) {
    const t = getTheme(name)
    const expected = PALETTE_FINGERPRINTS[name]!
    expect(`${name}.success: ${t.success}`).toBe(`${name}.success: ${expected.success}`)
    expect(`${name}.text: ${t.text}`).toBe(`${name}.text: ${expected.text}`)
  }
})

test('no two themes resolve to the same palette', () => {
  // Catches an aliased or duplicated import, where two names return one object.
  const seen = new Map<string, string>()
  for (const name of THEME_NAMES) {
    const key = JSON.stringify(getTheme(name))
    const previous = seen.get(key)
    expect(`${name} duplicates ${previous ?? 'nothing'}`).toBe(`${name} duplicates nothing`)
    seen.set(key, name)
  }
  expect(seen.size).toBe(THEME_NAMES.length)
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
