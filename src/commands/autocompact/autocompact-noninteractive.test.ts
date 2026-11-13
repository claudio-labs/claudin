import { afterEach, beforeEach, expect, test } from 'bun:test'

import { AUTO_COMPACT_WINDOW_ENV } from 'src/agent/compact/autoCompactWindow.js'
import { call } from 'src/commands/autocompact/autocompact-noninteractive.ts'
import { autoCompactStatusText } from 'src/commands/autocompact/setting.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

// Only paths that write nothing: the status, a parse error and the env lock.
const MODEL = 'claude-sonnet-4'
const context = { options: { mainLoopModel: MODEL } } as unknown as ToolUseContext

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
  expect((await call('50k', context)).value).toStartWith("Couldn't parse '50k'.")
  process.env[AUTO_COMPACT_WINDOW_ENV] = '300000'
  expect((await call('200k', context)).value).toBe(
    `${AUTO_COMPACT_WINDOW_ENV} is set and takes precedence. Unset it to change this setting.`,
  )
})
