import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getInlineImageProtocol, setXtversionName } from 'src/terminal/ink/terminal.js'

describe('getInlineImageProtocol', () => {
  const origEnv = { ...process.env }
  const origIsTTY = process.stdout.isTTY

  // When stdout is a pipe (CI), `isTTY` is a read-only property and a plain
  // assignment throws "Attempted to assign to readonly property". Go through
  // defineProperty so the override works regardless of the underlying stream.
  const setIsTTY = (value: boolean | undefined): void => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
      writable: true,
    })
  }

  beforeEach(() => {
    setIsTTY(true)
    for (const key of [
      'TMUX',
      'TERM',
      'TERM_PROGRAM',
      'TERM_PROGRAM_VERSION',
      'WT_SESSION',
    ]) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    setIsTTY(origIsTTY)
    process.env = { ...origEnv }
  })

  test('returns null when stdout is not a TTY', () => {
    setIsTTY(false)
    process.env.TERM = 'xterm-kitty'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('detects kitty via TERM=xterm-kitty', () => {
    process.env.TERM = 'xterm-kitty'
    expect(getInlineImageProtocol()).toBe('kitty')
  })

  test('detects ghostty via TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'ghostty'
    expect(getInlineImageProtocol()).toBe('kitty')
  })

  test('detects WezTerm via TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'WezTerm'
    expect(getInlineImageProtocol()).toBe('kitty')
  })

  test('rejects when running inside tmux', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    process.env.TERM = 'xterm-kitty'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('rejects when TERM starts with screen', () => {
    process.env.TERM = 'screen-256color'
    process.env.TERM_PROGRAM = 'ghostty'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('rejects iTerm2 (own protocol, not implemented)', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('rejects Apple Terminal', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('rejects VS Code integrated terminal', () => {
    process.env.TERM_PROGRAM = 'vscode'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('rejects Windows Terminal', () => {
    process.env.WT_SESSION = '12345-abcde'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('falls through to null on unknown terminal', () => {
    process.env.TERM = 'xterm-256color'
    process.env.TERM_PROGRAM = 'Generic_Terminal'
    expect(getInlineImageProtocol()).toBeNull()
  })

  test('detects via XTVERSION reply (kitty over SSH)', () => {
    // XTVERSION cache is module-scoped and once-only; test in isolation.
    // The setXtversionName guard makes this idempotent across tests, so we
    // can only assert positive behavior if no prior test already set it.
    process.env.TERM = 'xterm-256color'
    // setXtversionName is no-op if already set — this test documents the
    // expected behavior when the probe wins. In practice the env-based path
    // covers our CI use case.
    setXtversionName('kitty/0.32')
    // After XTVERSION arrives, detection should accept kitty.
    expect(getInlineImageProtocol()).toBe('kitty')
  })
})
