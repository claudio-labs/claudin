import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import { resetWaitForRedirectMemoForTesting } from 'src/tools/WaitForTool/redirect.js'

const POLL = 'tmux send-keys -t s Enter && sleep 8 && tmux capture-pane -t s -p | tail -25'
const CALL = 'WaitFor({"setup":"tmux send-keys -t s Enter","command":"tmux capture-pane -t s -p | tail -25"'

function ctx(withWaitFor: boolean): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: { tools: withWaitFor ? [WaitForTool] : [] },
  } as unknown as ToolUseContext
}

async function validate(
  command: string,
  withWaitFor = true,
): Promise<{ result: boolean; message?: string } | undefined> {
  return BashTool.validateInput?.({ command } as never, ctx(withWaitFor))
}

function advise(command: string, withWaitFor = true, runInBackground = false) {
  return BashTool.advise?.(
    { command, ...(runInBackground && { run_in_background: true }) } as never,
    ctx(withWaitFor),
  )
}

const ENV_KEYS = [
  'CLAUDIN_BASH_REDIRECT',
  'CLAUDIN_ENABLE_WAITFOR_REDIRECT',
  'CLAUDIN_DISABLE_WAITFOR_REDIRECT',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  resetWaitForRedirectMemoForTesting()
  for (const key of ENV_KEYS) delete process.env[key]
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Bash → WaitFor sleep-poll lane, advise mode (the default)', () => {
  test('the poll runs, and its result names the exact WaitFor call', async () => {
    expect((await validate(POLL))?.result).toBe(true)
    const advice = advise(POLL)
    expect(advice?.suggests).toBe('WaitFor')
    expect(advice?.message).toContain(CALL)
  })

  test('CLAUDIN_DISABLE_WAITFOR_REDIRECT=1 silences it', () => {
    process.env.CLAUDIN_DISABLE_WAITFOR_REDIRECT = '1'
    expect(advise(POLL)?.message ?? '').not.toContain('WaitFor(')
  })

  test('WaitFor absent from the toolset: no pointer', () => {
    expect(advise(POLL, false)?.message ?? '').not.toContain('WaitFor(')
  })

  test('a backgrounded run gets no pointer', () => {
    expect(advise(POLL, true, true)).toBeNull()
  })
})

describe('Bash → WaitFor sleep-poll lane, refuse mode', () => {
  beforeEach(() => {
    process.env.CLAUDIN_BASH_REDIRECT = 'refuse'
  })

  test('flag off: a mid-chain sleep is not refused by this lane', async () => {
    const r = await validate(POLL)
    expect(r?.message ?? '').not.toContain('WaitFor')
  })

  test('flag on: refused once with the exact WaitFor call, then runs', async () => {
    process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = '1'
    const first = await validate(POLL)
    expect(first?.result).toBe(false)
    expect(first?.message).toContain(CALL)
    const second = await validate(POLL)
    expect(second?.message ?? '').not.toContain('WaitFor')
  })

  test('flag on but WaitFor absent from the toolset: no refusal from this lane', async () => {
    process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = '1'
    const r = await validate(POLL, false)
    expect(r?.message ?? '').not.toContain('WaitFor')
  })

  test('flag on: a backgrounded run is never redirected', async () => {
    process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = '1'
    const r: { result: boolean; message?: string } | undefined =
      await BashTool.validateInput?.(
        { command: POLL, run_in_background: true } as never,
        ctx(true),
      )
    expect(r?.message ?? '').not.toContain('WaitFor')
  })
})
