import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import { resetWaitForRedirectMemoForTesting } from 'src/tools/WaitForTool/redirect.js'

const POLL = 'tmux send-keys -t s Enter && sleep 8 && tmux capture-pane -t s -p | tail -25'

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

describe('Bash → WaitFor sleep-poll redirect gate', () => {
  const saved = process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT
  beforeEach(() => {
    resetWaitForRedirectMemoForTesting()
    delete process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT
    else process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = saved
  })

  test('flag off: a mid-chain sleep is not refused by this lane', async () => {
    const r = await validate(POLL)
    expect(r?.message ?? '').not.toContain('WaitFor')
  })

  test('flag on: refused once with the exact WaitFor call, then runs', async () => {
    process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = '1'
    const first = await validate(POLL)
    expect(first?.result).toBe(false)
    expect(first?.message).toContain(
      'WaitFor({"setup":"tmux send-keys -t s Enter","command":"tmux capture-pane -t s -p | tail -25"',
    )
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
