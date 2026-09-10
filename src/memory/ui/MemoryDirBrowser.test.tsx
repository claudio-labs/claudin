import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { MemoryDirBrowser } from 'src/memory/ui/MemoryDirBrowser.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

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

async function render(
  dir: string,
  columns: number,
  props: Partial<React.ComponentProps<typeof MemoryDirBrowser>> = {},
): Promise<{ frame: string; dispose: () => Promise<void> }> {
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
  ;(stdout as unknown as { columns: number }).columns = columns
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <MemoryDirBrowser
          dir={dir}
          title="Team memory"
          indexPath={join(dir, 'MEMORY.md')}
          onBack={() => {}}
          {...props}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  // Two ticks: one for the directory scan, one for the preview read.
  await Bun.sleep(120)

  return {
    frame: extractLastFrame(output),
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

/**
 * Asserts the fragments appear in this order with nothing but whitespace
 * between them. A bare toContain passes on a render whose columns wrapped
 * independently and interleaved the words across rows (ink-tui.md §10).
 */
function expectInOrder(frame: string, fragments: string[]): void {
  const flat = frame.replace(/\s+/g, ' ')
  const joined = fragments.join(' ')
  expect(flat).toContain(joined)
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memdir-browser-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeMemory(
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): Promise<void> {
  const fm = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  await writeFile(join(dir, name), `---\n${fm}\n---\n\n${body}\n`, 'utf8')
}

describe('MemoryDirBrowser', () => {
  test('lists the index first, then each memory with its type tag and description', async () => {
    await writeFile(
      join(dir, 'MEMORY.md'),
      '- [Cache TTL](cache-ttl.md) — tiers\n',
      'utf8',
    )
    await writeMemory(
      'cache-ttl.md',
      { name: 'cache-ttl', description: 'Sub-agents inherit the TTL tier', type: 'project' },
      'Sub-agents inherit the parent tier rather than re-deriving it.',
    )

    const ui = await render(dir, 100)
    try {
      expectInOrder(ui.frame, ['MEMORY.md'])
      expectInOrder(ui.frame, ['[project]', 'cache-ttl'])
      expect(ui.frame).toContain('Sub-agents inherit the TTL tier')
      // The index is pinned above the memories.
      expect(ui.frame.indexOf('MEMORY.md')).toBeLessThan(
        ui.frame.indexOf('cache-ttl'),
      )
    } finally {
      await ui.dispose()
    }
  })

  test('the title and its path stay one line at a narrow width', async () => {
    await writeMemory('a.md', { name: 'a', type: 'user' }, 'body')

    for (const columns of [100, 44]) {
      const ui = await render(dir, columns)
      try {
        // One <Text>, so the path follows the title instead of wrapping into
        // an independent column beside it.
        expectInOrder(ui.frame, ['Team memory', '·'])
      } finally {
        await ui.dispose()
      }
    }
  })

  test('an empty directory says so instead of rendering an empty list', async () => {
    const ui = await render(dir, 100)
    try {
      expect(ui.frame).toContain('No memories here yet')
      expect(ui.frame).not.toContain('Search memories')
    } finally {
      await ui.dispose()
    }
  })

  test('the focused memory is previewed with its type and body', async () => {
    await writeMemory(
      'weekly-census.md',
      { name: 'weekly-census', description: 'the census', type: 'project' },
      'Reads were 45% of tool-result characters.',
    )

    const ui = await render(dir, 100)
    try {
      expectInOrder(ui.frame, ['project', '·', 'weekly-census'])
      expect(ui.frame).toContain('Reads were 45%')
    } finally {
      await ui.dispose()
    }
  })

  test('a long memory reports the lines the preview left out', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    await writeMemory('long.md', { name: 'long', type: 'reference' }, body)

    const ui = await render(dir, 100)
    try {
      expect(ui.frame).toContain('more lines')
      expect(ui.frame).toContain('line 1')
      // 10 body lines shown out of 30 — the tail is not rendered.
      expect(ui.frame).not.toContain('line 30')
    } finally {
      await ui.dispose()
    }
  })

  test('the byline advertises edit, delete, open and back', async () => {
    await writeMemory('a.md', { name: 'a', type: 'user' }, 'body')

    const ui = await render(dir, 100)
    try {
      expect(ui.frame).toContain('enter to edit')
      expect(ui.frame).toContain('delete')
      expect(ui.frame).toContain('open folder')
      expect(ui.frame).toContain('esc to go back')
    } finally {
      await ui.dispose()
    }
  })
})
