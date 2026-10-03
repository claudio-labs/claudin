/**
 * The switches above the picker's list, rendered: which of the two holds the
 * pointer, and (a fix) a switch that another settings layer overrides shows
 * the value in effect and says so. The user setting is still written, and only it.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'

import { clearMemoryFileCaches, getMemoryFiles } from 'src/memory/instructions/claudemd.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { MemoryFileSelector } from 'src/memory/ui/MemoryFileSelector.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const world = useMemdirWorld()
const UP = '\x1B[A'
const ENTER = '\r'
const OVERRIDDEN = /overridden by the environment or a project, local or managed setting/
const LIST_ROW = /^\S*\s*\d+\. /

type Mounted = {
  screen: () => string
  /** Sends `key` until `check` holds: a key typed before the handlers subscribe is lost. */
  press: (key: string, check: () => boolean) => Promise<void>
  close: () => void
}

async function mountPicker(): Promise<Mounted> {
  clearMemoryFileCaches()
  await getMemoryFiles()
  const terminal = createFakeTerminal({ columns: 220 })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <KeybindingSetup>
        <React.Suspense fallback={null}>
          <MemoryFileSelector onSelect={() => {}} onCancel={() => {}} />
        </React.Suspense>
      </KeybindingSetup>
    </AppStateProvider>,
  )
  const screen = terminal.screen
  const deadline = Date.now() + 8_000
  while (!screen().includes('1. ')) {
    if (Date.now() > deadline) throw new Error(`nothing painted:\n${terminal.transcript()}`)
    await Bun.sleep(15)
  }
  await Bun.sleep(150)

  return {
    screen,
    press: async (key, check) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        terminal.type(key)
        const settle = Date.now() + 1_500
        while (Date.now() < settle) {
          if (check()) return
          await Bun.sleep(15)
        }
      }
      throw new Error(`${JSON.stringify(key)} did nothing. Screen:\n${screen()}`)
    },
    close: () => {
      root.unmount()
      terminal.close()
    },
  }
}

function lineOf(screen: string, label: string): string {
  return screen.split('\n').find(line => line.includes(`${label}:`))?.trim() ?? ''
}

function pointedListRows(screen: string): string[] {
  return screen.split('\n').filter(line => line.includes('❯') && LIST_ROW.test(line.trim()))
}

function userSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(world().configDir, 'settings.json'), 'utf8'))
}

function enterRepo(): string {
  const repo = world().repo(join(world().root, 'repo'))
  world().enter(repo)
  return repo
}

describe('MemoryFileSelector: the pointer', () => {
  test('a focused switch takes the pointer off the list, and the list gets it back', async () => {
    enterRepo()
    const picker = await mountPicker()
    try {
      expect(pointedListRows(picker.screen())).toHaveLength(1)
      await picker.press(UP, () => lineOf(picker.screen(), 'Auto-dream').startsWith('❯'))
      expect(pointedListRows(picker.screen())).toEqual([])
      await picker.press('\x1B[B', () => pointedListRows(picker.screen()).length === 1)
      expect(lineOf(picker.screen(), 'Auto-dream').startsWith('❯')).toBe(false)
    } finally {
      picker.close()
    }
  }, 30_000)
})

describe('MemoryFileSelector: a switch another layer overrides', () => {
  const cases: Array<{ label: 'Auto-memory' | 'Auto-dream'; setting: string; line: RegExp }> = [
    { label: 'Auto-memory', setting: 'autoMemoryEnabled', line: /^❯\s*Auto-memory: off · overridden/ },
    { label: 'Auto-dream', setting: 'autoDreamEnabled', line: /^❯\s*Auto-dream: off( · never)? · overridden/ },
  ]

  for (const { label, setting, line } of cases) {
    test(`${label} kept off by the project: the flip is written to the user settings, the line stays off and says why`, async () => {
      const repo = enterRepo()
      world().settings('project', { [setting]: false })
      const projectFile = join(repo, '.claudin', 'settings.json')
      const projectBefore = existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : null

      const picker = await mountPicker()
      try {
        // Auto memory off at open shows one switch; on, the nearest is Auto-dream.
        await picker.press(UP, () => lineOf(picker.screen(), label).startsWith('❯'))
        await picker.press(ENTER, () => OVERRIDDEN.test(lineOf(picker.screen(), label)))
        expect(lineOf(picker.screen(), label)).toMatch(line)
      } finally {
        picker.close()
      }
      expect(userSettings()[setting]).toBe(true)
      expect(existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : null).toBe(projectBefore)
    }, 30_000)
  }
})
