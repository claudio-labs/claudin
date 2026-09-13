import { describe, expect, test } from 'bun:test'
import { onBackground } from 'src/terminal/ansiBackground.js'

const BG = '\u001B[48;2;26;28;36m'
const RESET = '\u001B[0m'
const DEFAULT_BG = '\u001B[49m'

describe('onBackground', () => {
  test('opens on the tint and closes on the terminal default', () => {
    expect(onBackground('plain', BG)).toBe(`${BG}plain${DEFAULT_BG}`)
  })

  test('re-asserts the tint after every full reset', () => {
    // A reset drops the background too, so the rest of the row would render on
    // the terminal's own colour.
    expect(onBackground(`a${RESET}b${RESET}c`, BG)).toBe(
      `${BG}a${RESET}${BG}b${RESET}${BG}c${DEFAULT_BG}`,
    )
  })

  test('replaces the terminal-default-background sentinel with the tint', () => {
    // `native-ts/color-diff` emits \x1b[49m for a block with no background of
    // its own; left alone it punches a hole through the pane's fill.
    expect(onBackground(`x${DEFAULT_BG}y`, BG)).toBe(`${BG}x${BG}y${DEFAULT_BG}`)
  })

  test('leaves a block that carries its own background alone', () => {
    const own = '\u001B[48;2;60;20;20m'
    expect(onBackground(`${own}hit`, BG)).toBe(`${BG}${own}hit${DEFAULT_BG}`)
  })
})
