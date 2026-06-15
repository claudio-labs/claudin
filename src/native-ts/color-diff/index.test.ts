import { test, expect } from 'bun:test'
import { ColorDiff, getSyntaxTheme } from './index.js'

const hunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 1,
  newLines: 1,
  lines: ['+const greeting = "hello";'],
}

function render(theme: string): string {
  return (new ColorDiff(hunk, null, 'demo.js').render(theme, 120, false) ?? []).join('\n')
}

test("'terminal' theme renders like an ANSI theme (terminal-default bg)", () => {
  const out = render('terminal')
  // ANSI path uses terminal-default backgrounds, never truecolor rgb bg fills
  expect(out.includes('48;2;')).toBe(false)
  // And no forced light/dark rgb diff line backgrounds
  expect(out.includes('220;255;220')).toBe(false)
  expect(out.includes('2;40;0')).toBe(false)
})

test("getSyntaxTheme routes 'terminal' to the ansi syntax theme", () => {
  expect(getSyntaxTheme('terminal').theme).toBe('ansi')
})
