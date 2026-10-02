/**
 * Mounts a tree in a real Ink root over the fake terminal, with the keybinding
 * provider the REPL puts around every dialog, and reads back what the user
 * would see.
 */
import * as React from 'react'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'

export const KEYS = {
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  left: '\x1B[D',
  enter: '\r',
  esc: '\x1B',
  space: ' ',
} as const

export type Mounted = {
  /** The frame on screen now. */
  screen: () => string
  /** Sends input and gives the tree time to react. */
  press: (input: string, settleMs?: number) => Promise<void>
  /** Resolves with the first frame `accept` holds for. */
  waitFor: (accept: string | ((frame: string) => boolean), ms?: number) => Promise<string>
  unmount: () => Promise<void>
}

export async function mountInk(tree: React.ReactNode, columns = 120): Promise<Mounted> {
  const terminal = createFakeTerminal({ columns })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
  root.render(<KeybindingSetup>{tree}</KeybindingSetup>)

  const waitFor = async (accept: string | ((frame: string) => boolean), ms = 8_000): Promise<string> => {
    const holds = typeof accept === 'string' ? (frame: string) => frame.includes(accept) : accept
    const deadline = Date.now() + ms
    for (;;) {
      const frame = terminal.screen()
      if (holds(frame)) return frame
      if (Date.now() > deadline) {
        throw new Error(`screen never matched ${String(accept)}; last frame:\n${frame}`)
      }
      await Bun.sleep(15)
    }
  }

  // Wait for a first painted frame, then for the passive effects that
  // subscribe the input handlers.
  await waitFor(frame => frame.trim() !== '')
  await Bun.sleep(120)

  return {
    screen: terminal.screen,
    press: async (input, settleMs = 120) => {
      terminal.type(input)
      await Bun.sleep(settleMs)
    },
    waitFor,
    unmount: async () => {
      root.unmount()
      terminal.close()
      await Bun.sleep(0)
    },
  }
}

/** Mounts, runs `body`, and always unmounts. */
export async function withInk<T>(tree: React.ReactNode, body: (ui: Mounted) => Promise<T>, columns?: number): Promise<T> {
  const ui = await mountInk(tree, columns)
  try {
    return await body(ui)
  } finally {
    await ui.unmount()
  }
}
