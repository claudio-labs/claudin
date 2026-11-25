import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { ToolStatusGlyph, ToolStatusIcon, fadeColor, toolIconStatus, type ToolIconStatus } from 'src/agent/ui/ToolStatusIcon.js'
import { Box, Text } from 'src/terminal/ink.js'
import { renderToAnsiString, renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { getTheme, type Theme } from 'src/terminal/theme/theme.js'

const ICON = '\u{f018d}'

describe('toolIconStatus — the dot states, in ToolUseLoader order', () => {
  const base = { isError: false, isUnresolved: false, shouldAnimate: false }

  test('a queued call is pending, whatever else holds', () => {
    expect(toolIconStatus({ ...base, isQueued: true, isAsync: true, isError: true })).toBe('pending')
  })

  test('a live async agent runs, even resolved and errored', () => {
    expect(toolIconStatus({ ...base, isAsync: true, isError: true })).toBe('running')
  })

  test('an error wins over an unresolved call', () => {
    expect(toolIconStatus({ ...base, isError: true, isUnresolved: true, shouldAnimate: true })).toBe('error')
  })

  test('an unresolved call runs only while it animates', () => {
    expect(toolIconStatus({ ...base, isUnresolved: true, shouldAnimate: true })).toBe('running')
    expect(toolIconStatus({ ...base, isUnresolved: true })).toBe('pending')
  })

  test('a resolved call is done', () => {
    expect(toolIconStatus(base)).toBe('done')
  })
})

describe('fadeColor — green to the text color, 2 s per cycle', () => {
  const theme = { ...getTheme('dark'), success: 'rgb(0,200,100)', text: 'rgb(200,250,250)' } as Theme

  test('starts half-way, reaches the text color at 0.5 s and green at 1.5 s', () => {
    expect(fadeColor(theme, 0)).toBe('rgb(100,225,175)')
    expect(fadeColor(theme, 500)).toBe('rgb(200,250,250)')
    expect(fadeColor(theme, 1500)).toBe('rgb(0,200,100)')
    expect(fadeColor(theme, 2500)).toBe('rgb(200,250,250)')
  })

  test('an ANSI theme switches between the two keys at the half-way point', () => {
    const ansi = { ...theme, success: 'ansi:greenBright', text: 'terminal' } as Theme
    expect(fadeColor(ansi, 500)).toBe('text')
    expect(fadeColor(ansi, 1500)).toBe('success')
  })
})

describe('ToolStatusIcon / ToolStatusGlyph — rendered', () => {
  // bun test renders without color: raise chalk to truecolor, then put it back.
  let savedLevel: typeof chalk.level
  beforeAll(() => {
    savedLevel = chalk.level
    chalk.level = 3
  })
  afterAll(() => {
    chalk.level = savedLevel
  })

  const TRUECOLOR = '\u001b[38;2;'
  // ThemedText draws dim in the theme's inactive color, not with SGR 2.
  const sgr = (key: 'error' | 'inactive') => `${TRUECOLOR}${getTheme('dark')[key].match(/\d+/g)!.join(';')}m`
  // The SGR codes written right before the icon.
  async function stylesBefore(status: ToolIconStatus): Promise<string> {
    const out = await renderToAnsiString(<ToolStatusIcon icon={ICON} status={status} />)
    const at = out.indexOf(ICON)
    expect(at).toBeGreaterThan(-1)
    return out.slice(Math.max(0, at - 24), at)
  }

  test('the icon sits in the two leading columns the dot took', async () => {
    const row = await renderToString(<Box flexDirection="row"><ToolStatusIcon icon={ICON} status="done" /><Text>Bash</Text></Box>)
    expect(row.startsWith(`${ICON} Bash`)).toBe(true)
  })

  test('a finished call keeps the default color: no color, no dim', async () => {
    const before = await stylesBefore('done')
    expect(before).not.toContain(TRUECOLOR)
  })

  test('a pending call is dim', async () => {
    expect(await stylesBefore('pending')).toContain(sgr('inactive'))
  })

  test('an error paints the icon in the error color', async () => {
    expect(await stylesBefore('error')).toContain(sgr('error'))
  })

  test('a running call is painted somewhere between green and the text color', async () => {
    const before = await stylesBefore('running')
    const rgb = before.match(/38;2;(\d+);(\d+);(\d+)m$/)
    expect(rgb).not.toBeNull()
    const theme = getTheme('dark')
    const [lo, hi] = [theme.success, theme.text].map(c => c.match(/\d+/g)!.map(Number))
    rgb!.slice(1).map(Number).forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(Math.min(lo![i]!, hi![i]!))
      expect(v).toBeLessThanOrEqual(Math.max(lo![i]!, hi![i]!))
    })
  })

  test('with reduced motion a running call holds still on green', async () => {
    const state = getDefaultAppState()
    const out = await renderToAnsiString(
      <AppStateProvider initialState={{ ...state, settings: { ...state.settings, prefersReducedMotion: true } }}>
        <ToolStatusIcon icon={ICON} status="running" />
      </AppStateProvider>,
    )
    const green = `${TRUECOLOR}${getTheme('dark').success.match(/\d+/g)!.join(';')}m`
    expect(out.slice(0, out.indexOf(ICON))).toContain(green)
  })

  test('the inline glyph has no column of its own and takes its parent line color when done', async () => {
    const out = await renderToString(<Text>{'a '}<ToolStatusGlyph icon={ICON} status="done" />{' b'}</Text>)
    expect(out).toContain(`a ${ICON} b`)
    const dimLine = await renderToAnsiString(<Text dimColor>{'a '}<ToolStatusGlyph icon={ICON} status="done" /></Text>)
    expect(dimLine.slice(0, dimLine.indexOf(ICON))).toContain(sgr('inactive'))
    const errored = await renderToAnsiString(<Text dimColor>{'a '}<ToolStatusGlyph icon={ICON} status="error" /></Text>)
    expect(errored.slice(0, errored.indexOf(ICON))).toContain(sgr('error'))
  })
})
