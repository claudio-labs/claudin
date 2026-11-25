import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import {
  detectNerdFontTerminal,
  hasNerdFontGlyphs,
  isNerdFontForcedByEnv,
  resetNerdFontDetectionForTesting,
  resolveNerdFontGlyphs,
} from 'src/terminal/terminalFont.js'

// Everything the detection reads. The developer's own terminal sets some of
// these (GHOSTTY_RESOURCES_DIR, TERM_PROGRAM), so each test starts from none.
const ENV_KEYS = [
  'CLAUDIN_NERD_FONT',
  'TERM_PROGRAM',
  'TERM',
  'TMUX',
  'GHOSTTY_RESOURCES_DIR',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'LC_TERMINAL',
] as const
const saved: Record<string, string | undefined> = {}
let savedSetting: ReturnType<typeof getGlobalConfig>['nerdFontIcons']

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  savedSetting = getGlobalConfig().nerdFontIcons
  resetNerdFontDetectionForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  saveGlobalConfig(c => ({ ...c, nerdFontIcons: savedSetting }))
  resetNerdFontDetectionForTesting()
})

describe('detectNerdFontTerminal', () => {
  test.each([
    ['ghostty TERM_PROGRAM', { TERM_PROGRAM: 'ghostty' }],
    ['WezTerm TERM_PROGRAM', { TERM_PROGRAM: 'WezTerm' }],
    ['kitty TERM', { TERM: 'xterm-kitty' }],
    ['ghostty TERM', { TERM: 'xterm-ghostty' }],
    ['tmux inside Ghostty', { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }],
    ['tmux inside kitty', { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', KITTY_WINDOW_ID: '1' }],
    ['tmux inside WezTerm', { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', WEZTERM_PANE: '0' }],
    ['tmux inside iTerm2', { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', LC_TERMINAL: 'iTerm2' }],
    ['screen inside kitty', { TERM: 'screen-256color', KITTY_WINDOW_ID: '1' }],
    ['tmux with an xterm TERM', { TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }],
  ])('%s → on', (_name, env) => {
    expect(detectNerdFontTerminal(env)).toBe(true)
  })

  test.each([
    ['plain tmux', { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color' }],
    ['Alacritty', { TERM: 'alacritty' }],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }],
    ['an empty marker', { TERM: 'xterm', GHOSTTY_RESOURCES_DIR: '' }],
    ['another LC_TERMINAL', { LC_TERMINAL: 'Terminus' }],
    ['nothing at all', {}],
    // The markers reach every child of a shell in that terminal, so another
    // emulator started from one inherits them; on main these were all off.
    ['VS Code launched from a Ghostty shell', { TERM_PROGRAM: 'vscode', TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }],
    ['Alacritty launched from kitty', { TERM: 'alacritty', KITTY_WINDOW_ID: '1' }],
    ['xterm launched from WezTerm', { TERM: 'xterm-256color', WEZTERM_PANE: '0' }],
    ['ssh from iTerm2 without tmux', { TERM: 'xterm-256color', LC_TERMINAL: 'iTerm2' }],
  ])('%s → off', (_name, env) => {
    expect(detectNerdFontTerminal(env)).toBe(false)
  })
})

describe('resolveNerdFontGlyphs — precedence', () => {
  const never = () => {
    throw new Error('the heuristic must not run once something above decides')
  }

  test('the env override wins over the setting', () => {
    expect(resolveNerdFontGlyphs('1', 'off', never)).toBe(true)
    expect(resolveNerdFontGlyphs('off', 'on', never)).toBe(false)
  })

  test('the setting wins over the heuristic', () => {
    expect(resolveNerdFontGlyphs(undefined, 'on', never)).toBe(true)
    expect(resolveNerdFontGlyphs(undefined, 'off', never)).toBe(false)
  })

  test('auto and unset fall through to the heuristic', () => {
    expect(resolveNerdFontGlyphs(undefined, 'auto', () => true)).toBe(true)
    expect(resolveNerdFontGlyphs(undefined, undefined, () => false)).toBe(false)
  })

  test('an override that is neither truthy nor falsy is ignored', () => {
    expect(resolveNerdFontGlyphs('maybe', undefined, () => true)).toBe(true)
  })
})

describe('isNerdFontForcedByEnv', () => {
  test('true for an on or off value, false when unset or unrecognized', () => {
    process.env.CLAUDIN_NERD_FONT = 'on'
    expect(isNerdFontForcedByEnv()).toBe(true)
    process.env.CLAUDIN_NERD_FONT = '0'
    expect(isNerdFontForcedByEnv()).toBe(true)
    process.env.CLAUDIN_NERD_FONT = 'maybe'
    expect(isNerdFontForcedByEnv()).toBe(false)
    delete process.env.CLAUDIN_NERD_FONT
    expect(isNerdFontForcedByEnv()).toBe(false)
  })
})

describe('hasNerdFontGlyphs', () => {
  test('the env override is read on every call', () => {
    process.env.CLAUDIN_NERD_FONT = '1'
    expect(hasNerdFontGlyphs()).toBe(true)
    process.env.CLAUDIN_NERD_FONT = '0'
    expect(hasNerdFontGlyphs()).toBe(false)
  })

  test('the /config setting is read on every call', () => {
    process.env.TERM_PROGRAM = 'ghostty'
    saveGlobalConfig(c => ({ ...c, nerdFontIcons: 'off' }))
    expect(hasNerdFontGlyphs()).toBe(false)
    saveGlobalConfig(c => ({ ...c, nerdFontIcons: 'auto' }))
    expect(hasNerdFontGlyphs()).toBe(true)
  })

  test('the terminal heuristic is resolved once per process', () => {
    saveGlobalConfig(c => ({ ...c, nerdFontIcons: undefined }))
    process.env.TERM_PROGRAM = 'tmux'
    process.env.GHOSTTY_RESOURCES_DIR = '/usr/share/ghostty'
    expect(hasNerdFontGlyphs()).toBe(true)

    delete process.env.GHOSTTY_RESOURCES_DIR
    expect(hasNerdFontGlyphs()).toBe(true)

    resetNerdFontDetectionForTesting()
    expect(hasNerdFontGlyphs()).toBe(false)
  })
})
