import { afterEach, beforeEach, expect, test } from 'bun:test'

import { AUTO_COMPACT_WINDOW_ENV } from 'src/agent/compact/autoCompactWindow.js'
import { call } from 'src/commands/autocompact/autocompact-noninteractive.ts'
import { applyAutoCompactWindow, autoCompactStatusText, type UserSettingsStore } from 'src/commands/autocompact/setting.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const MODEL = 'claude-sonnet-4'
const context = { options: { mainLoopModel: MODEL } } as unknown as ToolUseContext
// A fake store even on the paths that save nothing: a break-probe that lifts
// the env lock would otherwise write the developer's real settings.json.
const writes: unknown[] = []
const store: UserSettingsStore = {
  read: () => null,
  save: (_source, settings) => {
    writes.push(settings)
    return { error: null }
  },
}
const apply = (raw: string, model: string) => applyAutoCompactWindow(raw, model, store)

const savedEnv = process.env[AUTO_COMPACT_WINDOW_ENV]
beforeEach(() => {
  delete process.env[AUTO_COMPACT_WINDOW_ENV]
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[AUTO_COMPACT_WINDOW_ENV]
  else process.env[AUTO_COMPACT_WINDOW_ENV] = savedEnv
})

test('no argument prints the status for the session model', async () => {
  expect(await call('  ', context)).toEqual({ type: 'text', value: autoCompactStatusText(MODEL) })
})

test('an argument goes through the same parse and env lock as the dialog', async () => {
  expect((await call('50k', context, apply)).value).toStartWith("Couldn't parse '50k'.")
  process.env[AUTO_COMPACT_WINDOW_ENV] = '300000'
  expect((await call('200k', context, apply)).value).toBe(
    `${AUTO_COMPACT_WINDOW_ENV} is set and takes precedence. Unset it to change this setting.`,
  )
  expect(writes).toEqual([])
})

test('a valid argument is saved for the session model', async () => {
  expect((await call('150k', context, apply)).value).toEndWith('set to 150k tokens')
  expect(writes.at(-1)).toEqual({ modelSettings: { [MODEL]: { autoCompactWindow: 150_000 } } })
})
