import { afterEach, expect, test } from 'bun:test'

import { autocompact, autocompactNonInteractive } from 'src/commands/autocompact/index.ts'
import { getIsNonInteractiveSession, setIsInteractive } from 'src/platform/bootstrap/state.js'

const wasInteractive = !getIsNonInteractiveSession()
afterEach(() => setIsInteractive(wasInteractive))

test('the dialog in the TUI, the text twin under -p, never both', () => {
  setIsInteractive(true)
  expect(autocompact.isEnabled?.()).toBe(true)
  expect(autocompactNonInteractive.isEnabled?.()).toBe(false)
  expect(autocompactNonInteractive.isHidden).toBe(true)
  setIsInteractive(false)
  expect(autocompact.isEnabled?.()).toBe(false)
  expect(autocompactNonInteractive.isEnabled?.()).toBe(true)
  expect(autocompactNonInteractive.isHidden).toBe(false)
})

test('runs mid-turn like Claude Code, instead of waiting in the queue', () => {
  expect(autocompact.type === 'local-jsx' && autocompact.immediate).toBe(true)
})
