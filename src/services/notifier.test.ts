import { describe, expect, test } from 'bun:test'
import {
  appleScriptString,
  buildWindowsToastScript,
  makeDebouncer,
  pickOscChannel,
  xmlEscape,
} from './notifierHelpers.js'

describe('pickOscChannel', () => {
  test('maps known terminals to their native protocol', () => {
    expect(pickOscChannel('iTerm.app')).toBe('iterm2')
    expect(pickOscChannel('kitty')).toBe('kitty')
    expect(pickOscChannel('ghostty')).toBe('osc777')
    expect(pickOscChannel('WezTerm')).toBe('osc777')
    expect(pickOscChannel('foot')).toBe('osc777')
    expect(pickOscChannel('urxvt')).toBe('osc777')
    expect(pickOscChannel('rxvt')).toBe('osc777')
    expect(pickOscChannel('windows-terminal')).toBe('osc9plain')
    expect(pickOscChannel('conemu')).toBe('osc9plain')
  })

  test('falls back to TERM-derived heuristics', () => {
    expect(pickOscChannel('xterm-kitty')).toBe('kitty')
    expect(pickOscChannel('rxvt-unicode-256color')).toBe('osc777')
    expect(pickOscChannel('wezterm-256color')).toBe('osc777')
  })

  test('returns null for terminals without a notification escape', () => {
    expect(pickOscChannel(null)).toBeNull()
    expect(pickOscChannel('Apple_Terminal')).toBeNull()
    expect(pickOscChannel('alacritty')).toBeNull()
    expect(pickOscChannel('gnome-terminal')).toBeNull()
    expect(pickOscChannel('konsole')).toBeNull()
    expect(pickOscChannel('tilix')).toBeNull()
    expect(pickOscChannel('xterm')).toBeNull()
  })
})

describe('appleScriptString', () => {
  test('quotes plain strings', () => {
    expect(appleScriptString('hello world')).toBe('"hello world"')
  })

  test('escapes backslashes and double quotes', () => {
    expect(appleScriptString('he said "hi"\\')).toBe('"he said \\"hi\\"\\\\"')
  })

  test('passes shell metacharacters through unchanged (no shell parses them)', () => {
    expect(appleScriptString('$(rm -rf /)')).toBe('"$(rm -rf /)"')
    expect(appleScriptString('`pwn`')).toBe('"`pwn`"')
  })
})

describe('xmlEscape', () => {
  test('escapes the five XML special characters', () => {
    expect(xmlEscape(`<a href='x' name="y">b&c</a>`)).toBe(
      '&lt;a href=&apos;x&apos; name=&quot;y&quot;&gt;b&amp;c&lt;/a&gt;',
    )
  })
})

describe('buildWindowsToastScript', () => {
  test('embeds title and message inside the toast XML', () => {
    const script = buildWindowsToastScript('Claudin', 'task done')
    expect(script).toContain('<text>Claudin</text>')
    expect(script).toContain('<text>task done</text>')
    expect(script).toContain('ToastNotificationManager')
  })

  test('escapes payload to prevent XML/PowerShell injection', () => {
    const script = buildWindowsToastScript(
      'Title</text><text>injected',
      `body" & whoami`,
    )
    expect(script).not.toContain('<text>injected')
    expect(script).toContain('&lt;/text&gt;')
    expect(script).toContain('&quot;')
  })

  test('produces a base64-encodable UTF-16LE payload that round-trips', () => {
    const script = buildWindowsToastScript('Olá', 'こんにちは')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(decoded).toBe(script)
    expect(decoded).toContain('Olá')
    expect(decoded).toContain('こんにちは')
  })
})

describe('makeDebouncer', () => {
  test('drops a second identical key within the window', () => {
    const d = makeDebouncer(1000)
    expect(d.shouldDebounce('a')).toBe(false)
    expect(d.shouldDebounce('a')).toBe(true)
  })

  test('does not coalesce distinct keys', () => {
    const d = makeDebouncer(1000)
    expect(d.shouldDebounce('a')).toBe(false)
    expect(d.shouldDebounce('b')).toBe(false)
  })

  test('reset() clears the cache', () => {
    const d = makeDebouncer(1000)
    expect(d.shouldDebounce('a')).toBe(false)
    expect(d.shouldDebounce('a')).toBe(true)
    d.reset()
    expect(d.shouldDebounce('a')).toBe(false)
  })
})
