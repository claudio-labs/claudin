import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { SearchableSelect } from 'src/terminal/custom-select/SearchableSelect.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
const CTRL_F = '\x06'
const ENTER = '\r'

const OPTIONS = [
  { value: 'opus', label: 'Opus 5', description: 'Most capable' },
  { value: 'sonnet', label: 'Sonnet 5', description: 'Balanced default' },
  { value: 'haiku', label: 'Haiku 4.5', description: 'Fast and cheap' },
  { value: 'jamba', label: 'Jamba Large', description: 'Long context' },
]

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }

  return stripAnsi(lastFrame ?? output)
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getFrame: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 100
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return { stdout, stdin, getFrame: () => extractLastFrame(output) }
}

type Mounted = {
  press: (keys: string) => Promise<void>
  /** A bare ESC is the prefix of every escape sequence, so the input parser
   *  only resolves it as the Escape key after its sequence timeout. */
  pressEscape: () => Promise<void>
  frame: () => string
  selected: string[]
  dispose: () => Promise<void>
}

async function mount(
  props: Partial<React.ComponentProps<typeof SearchableSelect<string>>> = {},
): Promise<Mounted> {
  const { stdout, stdin, getFrame } = createTestStreams()
  const selected: string[] = []
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <SearchableSelect
          options={OPTIONS}
          visibleOptionCount={OPTIONS.length}
          onChange={value => selected.push(value)}
          {...props}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  await Bun.sleep(40)

  return {
    press: async (keys: string) => {
      stdin.write(keys)
      await Bun.sleep(40)
    },
    pressEscape: async () => {
      stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame: getFrame,
    selected,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

/** A favorites adapter backed by an in-memory array, like the config-backed one. */
function memoryFavorites(initial: string[] = []) {
  let ids = [...initial]
  return {
    list: () => ids,
    toggle: (id: string) => {
      ids = ids.includes(id) ? ids.filter(entry => entry !== id) : [...ids, id]
    },
    keyOf: (value: string) => (value === 'opus' ? null : value),
    get ids() {
      return ids
    },
  }
}

describe('SearchableSelect search mode', () => {
  test('renders every option, with the search box mounted but unfocused', async () => {
    const ui = await mount({ searchPlaceholder: 'Search models…' })
    try {
      const frame = ui.frame()
      expect(frame).toContain('Opus 5')
      expect(frame).toContain('Jamba Large')
      // Always mounted so entering search mode doesn't change the dialog's
      // height — the reflow is what leaves stale glyphs on screen.
      expect(frame).toContain('Search models…')
      expect(frame).toContain('to search')
    } finally {
      await ui.dispose()
    }
  })

  test('/ focuses the search box and typing filters the list', async () => {
    const ui = await mount({ searchPlaceholder: 'Search models…' })
    try {
      await ui.press('/')
      expect(ui.frame()).toContain('Esc to clear')

      await ui.press('hai')
      const frame = ui.frame()
      expect(frame).toContain('Haiku 4.5')
      expect(frame).not.toContain('Opus 5')
      expect(frame).not.toContain('Sonnet 5')
    } finally {
      await ui.dispose()
    }
  })

  test('j types into the query instead of moving the cursor', async () => {
    const ui = await mount()
    try {
      await ui.press('/')
      await ui.press('j')
      const frame = ui.frame()
      // 'j' filters to Jamba. If it had navigated instead, every option would
      // still be listed and the query would be empty.
      expect(frame).toContain('Jamba Large')
      expect(frame).not.toContain('Opus 5')
    } finally {
      await ui.dispose()
    }
  })

  test('a digit types into the query instead of selecting that row', async () => {
    const ui = await mount()
    try {
      await ui.press('/')
      await ui.press('2')
      expect(ui.selected).toEqual([])
      // '2' matches no label or description, so the query really took it.
      expect(ui.frame()).toContain('No matches for')
    } finally {
      await ui.dispose()
    }
  })

  test('a query with no match says so instead of rendering an empty list', async () => {
    const ui = await mount()
    try {
      await ui.press('/')
      await ui.press('zzz')
      expect(ui.frame()).toContain('No matches for')
    } finally {
      await ui.dispose()
    }
  })

  test('Enter leaves search mode and keeps the filter, then Enter selects', async () => {
    const ui = await mount()
    try {
      await ui.press('/')
      await ui.press('hai')
      await ui.press(ENTER)
      // Still filtered, but the list is live again.
      expect(ui.frame()).toContain('Haiku 4.5')
      expect(ui.frame()).not.toContain('Opus 5')

      await ui.press(ENTER)
      expect(ui.selected).toEqual(['haiku'])
    } finally {
      await ui.dispose()
    }
  })

  test('Escape on a non-empty query clears it rather than closing the picker', async () => {
    let cancelled = 0
    const ui = await mount({ onCancel: () => cancelled++ })
    try {
      await ui.press('/')
      await ui.press('hai')
      await ui.pressEscape()
      expect(cancelled).toBe(0)
      expect(ui.frame()).toContain('Opus 5')
    } finally {
      await ui.dispose()
    }
  })
})

describe('SearchableSelect favorites', () => {
  test('no ctrl+f hint and no starring when no favorites adapter is passed', async () => {
    const ui = await mount()
    try {
      expect(ui.frame()).not.toContain('favorite')
    } finally {
      await ui.dispose()
    }
  })

  test('a starred option is pinned to the top with a star', async () => {
    const ui = await mount({ favorites: memoryFavorites(['haiku']) })
    try {
      const lines = ui
        .frame()
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      const haikuLine = lines.findIndex(line => line.includes('Haiku 4.5'))
      const opusLine = lines.findIndex(line => line.includes('Opus 5'))
      expect(haikuLine).toBeGreaterThanOrEqual(0)
      expect(haikuLine).toBeLessThan(opusLine)
      expect(lines[haikuLine]).toContain('★')
    } finally {
      await ui.dispose()
    }
  })

  test('ctrl+f stars the focused row and re-orders the list', async () => {
    const favorites = memoryFavorites()
    const ui = await mount({ favorites })
    try {
      // Focus starts on Opus, whose keyOf is null — ctrl+f must be a no-op.
      await ui.press(CTRL_F)
      expect(favorites.ids).toEqual([])

      // Move down twice to Haiku, then star it.
      await ui.press('j')
      await ui.press('j')
      await ui.press(CTRL_F)
      expect(favorites.ids).toEqual(['haiku'])

      const lines = ui
        .frame()
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      const haikuLine = lines.findIndex(line => line.includes('Haiku 4.5'))
      const opusLine = lines.findIndex(line => line.includes('Opus 5'))
      expect(haikuLine).toBeLessThan(opusLine)

      // Toggling again unstars it and restores the original order.
      await ui.press(CTRL_F)
      expect(favorites.ids).toEqual([])
    } finally {
      await ui.dispose()
    }
  })

  test('ctrl+f works while the search box is focused', async () => {
    const favorites = memoryFavorites()
    const ui = await mount({ favorites })
    try {
      await ui.press('/')
      await ui.press('hai')
      await ui.press(CTRL_F)
      expect(favorites.ids).toEqual(['haiku'])
      // And it did not land in the query, which would have emptied the list.
      expect(ui.frame()).toContain('Haiku 4.5')
    } finally {
      await ui.dispose()
    }
  })
})
