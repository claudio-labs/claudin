/**
 * The /autocompact dialog on a real Ink root (`mountHook`): `useInput` puts
 * stdin in raw mode, which `renderToString` would do to the process stdin.
 * `save` is injected, so nothing is written to settings.json.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as React from 'react'

import { AUTO_COMPACT_WINDOW_ENV } from 'src/agent/compact/autoCompactWindow.js'
import { AutoCompactDialog } from 'src/commands/autocompact/AutoCompactDialog.js'
import type { AutoCompactChoice } from 'src/commands/autocompact/setting.js'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { renderModelName } from 'src/providers/model/model.js'
import { lastFrame, mountHook } from 'src/providers/ui/__testutils__/inkHookHarness.js'

const LEFT = '\x1B[D'
const RIGHT = '\x1B[C'
const UP = '\x1B[A'
const DOWN = '\x1B[B'
const ENTER = '\r'
const MODEL = 'claude-sonnet-4'
const NAME = renderModelName(MODEL)

function setSettings(settings: Record<string, unknown> | null): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

const savedEnv = process.env[AUTO_COMPACT_WINDOW_ENV]
beforeEach(() => {
  delete process.env[AUTO_COMPACT_WINDOW_ENV]
})
afterEach(() => {
  setSettings(null)
  if (savedEnv === undefined) delete process.env[AUTO_COMPACT_WINDOW_ENV]
  else process.env[AUTO_COMPACT_WINDOW_ENV] = savedEnv
})

async function mount(autoCompactEnabled = true) {
  const done: string[] = []
  const applied: AutoCompactChoice[] = []
  const mounted = await mountHook(
    <AutoCompactDialog
      model={MODEL}
      onDone={result => done.push(result)}
      save={choice => {
        applied.push(choice)
        return `applied ${choice}`
      }}
      autoCompactEnabled={autoCompactEnabled}
    />,
    { columns: 140 },
  )
  await Bun.sleep(40)
  return {
    press: async (keys: string) => {
      mounted.streams.stdin.write(keys)
      await Bun.sleep(40)
    },
    // A bare ESC resolves only after the escape-sequence timeout.
    pressEscape: async () => {
      mounted.streams.stdin.write('\x1B')
      await Bun.sleep(300)
    },
    frame: () => lastFrame(mounted.streams.getOutput()),
    done,
    applied,
    cleanup: mounted.cleanup,
  }
}

test('opens on the current setting and steps through the 100k grid', async () => {
  const d = await mount()
  try {
    expect(d.frame()).toContain('Auto-compact window')
    expect(d.frame()).toContain(`Current setting for ${NAME}: auto`)
    expect(d.frame()).toContain('Select auto-compact window: auto')
    await d.press(RIGHT)
    expect(d.frame()).toContain('Select auto-compact window: 100k tokens')
    await d.press(RIGHT)
    await d.press(RIGHT)
    expect(d.frame()).toContain('Select auto-compact window: 300k tokens')
    await d.press(ENTER)
    expect(d.applied).toEqual([300_000])
    expect(d.done).toEqual(['applied 300000'])
  } finally {
    await d.cleanup()
  }
})

test("Claude Code's wording, and the disabled note as a warning only when it applies", async () => {
  const on = await mount(true)
  try {
    expect(on.frame()).toContain('This command configures when auto-compaction happens.')
    expect(on.frame()).not.toContain('Auto-compact is currently disabled (see /config)')
  } finally {
    await on.cleanup()
  }
  const off = await mount(false)
  try {
    expect(off.frame()).toContain('Auto-compact is currently disabled (see /config)')
  } finally {
    await off.cleanup()
  }
})

test('↑ and ↓ step like → and ←', async () => {
  const d = await mount()
  try {
    await d.press(UP)
    await d.press(UP)
    expect(d.frame()).toContain('Select auto-compact window: 200k tokens')
    await d.press(DOWN)
    expect(d.frame()).toContain('Select auto-compact window: 100k tokens')
    await d.press(DOWN)
    expect(d.frame()).toContain('Select auto-compact window: auto')
  } finally {
    await d.cleanup()
  }
})

test('stepping back to auto from a saved window applies auto', async () => {
  setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 100_000 } } })
  const d = await mount()
  try {
    expect(d.frame()).toContain('Select auto-compact window: 100k tokens')
    await d.press(LEFT)
    expect(d.frame()).toContain('Select auto-compact window: auto')
    await d.press(ENTER)
    expect(d.applied).toEqual(['auto'])
  } finally {
    await d.cleanup()
  }
})

test('Enter on the starting value and Esc leave it unchanged', async () => {
  const d = await mount()
  try {
    await d.press(ENTER)
    expect(d.done).toEqual([`Auto-compact window for ${NAME} unchanged: auto`])
  } finally {
    await d.cleanup()
  }
  const e = await mount()
  try {
    await e.press(RIGHT)
    await e.pressEscape()
    expect(e.done).toEqual([`Auto-compact window for ${NAME} unchanged: auto`])
    expect(e.applied).toEqual([])
  } finally {
    await e.cleanup()
  }
})

test('the window shown on Enter is the one applied, also off the 100k grid', async () => {
  // /autocompact 250k opens snapped to 300k: Enter there applies 300k.
  setSettings({ modelSettings: { [MODEL]: { autoCompactWindow: 250_000 } } })
  const d = await mount()
  try {
    expect(d.frame()).toContain('Select auto-compact window: 300k tokens')
    await d.press(RIGHT)
    await d.press(LEFT)
    await d.press(ENTER)
    expect(d.applied).toEqual([300_000])
  } finally {
    await d.cleanup()
  }
})

test('a second Enter neither applies nor reports again', async () => {
  const d = await mount()
  try {
    await d.press(RIGHT)
    await d.press(ENTER)
    await d.press(ENTER)
    expect(d.applied).toEqual([100_000])
    expect(d.done).toHaveLength(1)
  } finally {
    await d.cleanup()
  }
})

test('with the env var set it only explains, and the arrows do nothing', async () => {
  process.env[AUTO_COMPACT_WINDOW_ENV] = '300000'
  const d = await mount()
  try {
    expect(d.frame()).toContain(`${AUTO_COMPACT_WINDOW_ENV} is set and takes precedence.`)
    expect(d.frame()).not.toContain('Select auto-compact window')
    await d.press(RIGHT)
    await d.press(ENTER)
    expect(d.applied).toEqual([])
    expect(d.done).toEqual([
      `Auto-compact window for ${NAME} unchanged: 300k tokens (from ${AUTO_COMPACT_WINDOW_ENV}) · capped to 200k by model`,
    ])
  } finally {
    await d.cleanup()
  }
})
