/**
 * How a memory file's path is shortened for the user, and the one-line
 * "memory updated" notice that shows it.
 *
 * `getRelativeMemoryPath` reads the session's working directory (bootstrap
 * state, set per case and handed back by the world) and the home directory.
 * Bun caches the home directory for the life of the process, so the home
 * cases build paths under the real `homedir()` as plain strings: nothing is
 * read or written there.
 */
import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import {
  getRelativeMemoryPath,
  MemoryUpdateNotification,
} from 'src/memory/ui/MemoryUpdateNotification.js'
import { setCwdState } from 'src/platform/bootstrap/state.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'

const world = useMemdirWorld()
const HOME = homedir()

/** Paths are written with `<tmp>` for the world's root and `<home>` for the home directory. */
function expand(template: string): string {
  return template.replace('<tmp>', world().root).replace('<home>', HOME)
}

describe('getRelativeMemoryPath', () => {
  const cases: Array<{ name: string; cwd: string; path: string; shown: string }> = [
    {
      name: 'inside the working directory: ./ and the relative path',
      cwd: '<tmp>/proj',
      path: '<tmp>/proj/.claudin/memory/feedback.md',
      shown: './.claudin/memory/feedback.md',
    },
    {
      name: 'inside the home directory only: ~ and the rest',
      cwd: '<tmp>/proj',
      path: '<home>/.claudin-char-absent/CLAUDE.md',
      shown: '~/.claudin-char-absent/CLAUDE.md',
    },
    {
      name: 'inside neither: the path unchanged',
      cwd: '<tmp>/proj',
      path: '<tmp>/elsewhere/CLAUDE.md',
      shown: '<tmp>/elsewhere/CLAUDE.md',
    },
    {
      name: 'a parent of the working directory is not inside it',
      cwd: '<tmp>/proj/pkg',
      path: '<tmp>/proj/AGENTS.md',
      shown: '<tmp>/proj/AGENTS.md',
    },
    {
      name: 'inside both: the shorter form, here the working-directory one',
      cwd: '<home>/.claudin-char-absent/work/app',
      path: '<home>/.claudin-char-absent/work/app/AGENTS.md',
      shown: './AGENTS.md',
    },
    {
      name: 'inside both at equal length: the home form',
      cwd: '<home>',
      path: '<home>/AGENTS.md',
      shown: '~/AGENTS.md',
    },
  ]

  for (const { name, cwd, path, shown } of cases) {
    test(name, () => {
      setCwdState(expand(cwd))
      expect(getRelativeMemoryPath(expand(path))).toBe(expand(shown))
    })
  }

  test('follows the working directory as it changes, with nothing cached', () => {
    const w = world()
    const file = join(w.root, 'a', 'b', 'note.md')
    setCwdState(join(w.root, 'a'))
    expect(getRelativeMemoryPath(file)).toBe('./b/note.md')
    setCwdState(join(w.root, 'a', 'b'))
    expect(getRelativeMemoryPath(file)).toBe('./note.md')
  })
})

describe('MemoryUpdateNotification', () => {
  async function paint(memoryPath: string): Promise<string> {
    const terminal = createFakeTerminal({ columns: 200 })
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
    try {
      root.render(<MemoryUpdateNotification memoryPath={memoryPath} />)
      const deadline = Date.now() + 8_000
      while (!terminal.screen().includes('/memory')) {
        if (Date.now() > deadline) throw new Error(`nothing painted:\n${terminal.transcript()}`)
        await Bun.sleep(20)
      }
      return terminal.screen().trim()
    } finally {
      root.unmount()
      terminal.close()
    }
  }

  // Where the updated file sits → [its path, how the notice names it]. The
  // session works in <tmp>/proj throughout.
  const notices = new Map<string, readonly [string, string]>([
    ['the working directory', ['<tmp>/proj/.claudin/memory/MEMORY.md', './.claudin/memory/MEMORY.md']],
    ['the home directory', ['<home>/.claudin-char-absent/CLAUDE.md', '~/.claudin-char-absent/CLAUDE.md']],
    ['neither', ['<tmp>/other/CLAUDE.md', '<tmp>/other/CLAUDE.md']],
  ])

  for (const [where, [updated, named]] of notices) {
    test(`a file under ${where}: one line with its short form and the way to edit it`, async () => {
      setCwdState(expand('<tmp>/proj'))
      const line = await paint(expand(updated))
      expect(line).toBe(`Memory updated in ${expand(named)} · /memory to edit`)
    }, 20_000)
  }
})
