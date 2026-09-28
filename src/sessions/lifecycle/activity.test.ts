import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  registerSessionActivityCallback,
  stopSessionActivity,
  unregisterSessionActivityCallback,
} from 'src/sessions/lifecycle/activity.js'

let env: EnvSnapshot
let sandbox: string

beforeEach(() => {
  env = envSnapshot(['CLAUDIN_DIAGNOSTICS_FILE'])
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-activity-')))
  process.env.CLAUDIN_DIAGNOSTICS_FILE = join(sandbox, 'diagnostics.jsonl')
  jest.useFakeTimers()
})

afterEach(() => {
  unregisterSessionActivityCallback()
  jest.useRealTimers()
  env.restore()
  rmSync(sandbox, { recursive: true, force: true })
})

function loggedEvents(): string[] {
  const file = join(sandbox, 'diagnostics.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { event: string }).event)
}

test('a stop with nothing in flight changes nothing: no idle note follows it', () => {
  registerSessionActivityCallback(() => {})

  stopSessionActivity('tool_exec')
  jest.advanceTimersByTime(60_000)

  expect(loggedEvents()).toEqual([])
})
