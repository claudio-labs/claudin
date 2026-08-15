import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { Text } from 'src/ink.js'
import { renderToString } from 'src/components/staticRender.js'
import { ShellElapsedTime, ShellGroupElapsedTime } from 'src/components/shell/ShellElapsedTime.js'

function render(node: React.ReactNode): Promise<string> {
  // Both live inside the parent <Text> of a message row, which is what lets
  // ShellGroupElapsedTime emit its bare " · " separator.
  return renderToString(<Text>{node}</Text>).then(stripAnsi)
}

describe('ShellElapsedTime', () => {
  test('shows the reported elapsed on the first frame', async () => {
    // A fresh mount must not restart the count at zero — the row remounts when
    // the "Running…" branch swaps for the one with output.
    const out = await render(<ShellElapsedTime elapsedTimeSeconds={69} />)
    expect(out).toContain('(1m 9s)')
  })

  test('shows only the timeout before the first second', async () => {
    const out = await render(<ShellElapsedTime timeoutMs={120_000} />)
    expect(out).toContain('(timeout 2m)')
  })
})

describe('ShellGroupElapsedTime', () => {
  test('appends the elapsed to the collapsed group header', async () => {
    const out = await render(<ShellGroupElapsedTime elapsedTimeSeconds={69} />)
    expect(out).toContain('· 1m 9s')
  })

  test('renders nothing until the batch is worth waiting on', async () => {
    const out = await render(<ShellGroupElapsedTime elapsedTimeSeconds={1} />)
    expect(out.trim()).toBe('')
  })
})
