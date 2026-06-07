import { describe, expect, test } from 'bun:test'
import { parseDesktopExec } from './browser.js'

describe('parseDesktopExec', () => {
  test('strips %u field code and returns the binary', () => {
    const desktop = [
      '[Desktop Entry]',
      'Name=Brave',
      'Exec=brave-browser %u',
      'Type=Application',
    ].join('\n')
    expect(parseDesktopExec(desktop)).toBe('brave-browser')
  })

  test('strips %U %f %F %i %c %k %m %n %d %D %N %v field codes', () => {
    const desktop = '[Desktop Entry]\nExec=firefox %U %f %F %i %c %k'
    expect(parseDesktopExec(desktop)).toBe('firefox')
  })

  test('collapses %% to literal % and keeps it', () => {
    // %% is not a field code; after collapse, "weirdbin%path" stays as binary
    const desktop = '[Desktop Entry]\nExec=weirdbin%%path %u'
    expect(parseDesktopExec(desktop)).toBe('weirdbin%path')
  })

  test('handles quoted absolute path with spaces', () => {
    const desktop =
      '[Desktop Entry]\nExec="/opt/Brave Browser/brave" --new-window %u'
    expect(parseDesktopExec(desktop)).toBe('/opt/Brave Browser/brave')
  })

  test('ignores Exec lines outside [Desktop Entry] group', () => {
    const desktop = [
      '[Desktop Action NewWindow]',
      'Exec=should-not-pick %u',
      '[Desktop Entry]',
      'Exec=correct-binary %u',
    ].join('\n')
    expect(parseDesktopExec(desktop)).toBe('correct-binary')
  })

  test('picks first Exec in [Desktop Entry]', () => {
    const desktop = [
      '[Desktop Entry]',
      'Exec=first %u',
      'Exec=second %u',
    ].join('\n')
    expect(parseDesktopExec(desktop)).toBe('first')
  })

  test('returns null when no Exec line is present', () => {
    const desktop = '[Desktop Entry]\nName=NoExec\nType=Application'
    expect(parseDesktopExec(desktop)).toBeNull()
  })

  test('returns null on empty input', () => {
    expect(parseDesktopExec('')).toBeNull()
  })

  test('handles leading whitespace before Exec=', () => {
    const desktop = '[Desktop Entry]\n  Exec=indented %u'
    expect(parseDesktopExec(desktop)).toBe('indented')
  })
})
