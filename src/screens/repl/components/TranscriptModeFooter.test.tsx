import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToString } from '../../../utils/staticRender.js'
import { TranscriptModeFooter } from './TranscriptModeFooter.js'

// `useShortcutDisplay` falls back to the third argument when no keybinding
// context is mounted (see src/keybindings/useShortcutDisplay.ts:36-58), so
// these tests render the footer bare and assert on the fallback strings
// ('ctrl+o' for toggle, 'ctrl+e' for show-all).
//
// renderToString already strips ANSI and returns the plain text content of
// the first frame, so we can substring-match directly.

describe('TranscriptModeFooter', () => {
  test('virtualScroll: shows scroll hint and toggle shortcut', async () => {
    const out = await renderToString(
      <TranscriptModeFooter showAllInTranscript={false} virtualScroll={true} />,
    )
    expect(out).toContain('Showing detailed transcript')
    expect(out).toContain('ctrl+o to toggle')
    expect(out).toContain('scroll')
    // The text wraps at the terminal width; substring-match each token.
    expect(out).toContain('home/end')
    expect(out).toContain('top/bottom')
  })

  test('non-virtual + collapsed: shows "show all" hint', async () => {
    const out = await renderToString(
      <TranscriptModeFooter showAllInTranscript={false} virtualScroll={false} />,
    )
    expect(out).toContain('ctrl+e to show all')
  })

  test('non-virtual + expanded: shows "collapse" hint', async () => {
    const out = await renderToString(
      <TranscriptModeFooter showAllInTranscript={true} virtualScroll={false} />,
    )
    expect(out).toContain('ctrl+e to collapse')
  })

  test('suppressShowAll hides the toggle hint (dump mode)', async () => {
    const out = await renderToString(
      <TranscriptModeFooter
        showAllInTranscript={false}
        virtualScroll={false}
        suppressShowAll={true}
      />,
    )
    expect(out).not.toContain('show all')
    expect(out).not.toContain('collapse')
  })

  test('with searchBadge: renders n/N hint and count', async () => {
    const out = await renderToString(
      <TranscriptModeFooter
        showAllInTranscript={false}
        virtualScroll={true}
        searchBadge={{ current: 2, count: 7 }}
      />,
    )
    expect(out).toContain('n/N to navigate')
    expect(out).toContain('2/7')
  })

  test('status overrides the search badge in the right slot', async () => {
    const out = await renderToString(
      <TranscriptModeFooter
        showAllInTranscript={false}
        virtualScroll={true}
        searchBadge={{ current: 1, count: 3 }}
        status="saving..."
      />,
    )
    expect(out).toContain('saving...')
    expect(out).not.toContain('1/3')
  })
})
