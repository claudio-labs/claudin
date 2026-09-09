import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { parseForSecurity } from 'src/platform/bash/ast.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import {
  detectSleepPoll,
  renderWaitForRedirect,
  resetWaitForRedirectMemoForTesting,
  shouldRedirectSleepPoll,
} from 'src/tools/WaitForTool/redirect.js'

function makeCtx(abortController = new AbortController()): ToolUseContext {
  return {
    abortController,
    getAppState: () => ({}),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('WaitForTool', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'waitfor-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('schema: command + description required, strict, timeout capped', () => {
    expect(WaitForTool.inputSchema.safeParse({ command: 'ls' }).success).toBe(false)
    expect(
      WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd' }).success,
    ).toBe(true)
    expect(
      WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', extra: 1 })
        .success,
    ).toBe(false)
    expect(
      WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_s: 601 })
        .success,
    ).toBe(false)
    expect(WaitForTool.isConcurrencySafe?.()).toBe(true)
    expect(WaitForTool.name).toBe('WaitFor')
    expect(WaitForTool.userFacingName()).toBe('Wait')
  })

  test('validateInput rejects an invalid until regex', async () => {
    const bad = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: '(' } as never,
    )
    expect(bad?.result).toBe(false)
    const ok = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: 'READY' } as never,
    )
    expect(ok?.result).toBe(true)
  })

  test('until: returns as soon as a background writer produces the match', async () => {
    const file = join(dir, 'x')
    writeFileSync(file, 'waiting\n')
    const writer = spawn('sh', ['-c', `sleep 1; echo READY >> ${file}`], { stdio: 'ignore' })
    try {
      const { data } = await WaitForTool.call(
        {
          command: `cat ${file}`,
          until: 'READY',
          interval_s: 0.2,
          timeout_s: 15,
          description: 'ready marker',
        },
        makeCtx(),
      )
      expect(data.reason).toBe('match')
      expect(data.matched).toBe(true)
      expect(data.output).toContain('READY')
      expect(data.polls).toBeGreaterThan(1)
      expect(data.elapsedMs).toBeLessThan(10_000)
    } finally {
      writer.kill()
    }
  })

  test('setup runs once before the first poll', async () => {
    const file = join(dir, 'y')
    const { data } = await WaitForTool.call(
      {
        setup: `echo READY > ${file}`,
        command: `cat ${file}`,
        until: 'READY',
        timeout_s: 10,
        description: 'setup then read',
      },
      makeCtx(),
    )
    expect(data.reason).toBe('match')
    expect(data.polls).toBe(1)
  })

  test('settle: returns once the output stops changing', async () => {
    const { data } = await WaitForTool.call(
      {
        command: 'echo stable',
        settle_s: 0.6,
        interval_s: 0.2,
        timeout_s: 10,
        description: 'settle',
      },
      makeCtx(),
    )
    expect(data.reason).toBe('settled')
    expect(data.matched).toBe(false)
    expect(data.output).toContain('stable')
    expect(data.polls).toBeGreaterThanOrEqual(3)
  })

  test('timeout: returns the last output with reason timeout', async () => {
    const { data } = await WaitForTool.call(
      {
        command: 'echo never',
        until: 'READY',
        interval_s: 0.2,
        timeout_s: 1,
        description: 'timeout',
      },
      makeCtx(),
    )
    expect(data.reason).toBe('timeout')
    expect(data.output).toContain('never')
    // The loop stops once less than MIN_POLL_BUDGET_MS (250ms) remains rather
    // than launching a poll exec would kill — so "timeout" lands up to that
    // much early, never with a "Command timed out" line as the output.
    expect(data.elapsedMs).toBeGreaterThanOrEqual(700)
    expect(data.output).not.toContain('Command timed out')
  })

  test('abort: stops polling and reports aborted', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    const { data } = await WaitForTool.call(
      {
        command: 'echo never',
        until: 'READY',
        interval_s: 0.2,
        timeout_s: 30,
        description: 'abort',
      },
      makeCtx(ac),
    )
    expect(data.reason).toBe('aborted')
    expect(data.elapsedMs).toBeLessThan(5_000)
  })

  test('model-facing result is the output followed by one status line', () => {
    const block = WaitForTool.mapToolResultToToolResultBlockParam(
      { output: 'hi\n', matched: true, reason: 'match', elapsedMs: 4200, polls: 5 },
      'u1',
    )
    expect(block.content).toBe('hi\n[WaitFor: match after 4.2s, 5 polls]')
  })

  test('permission matcher covers setup and poll subcommands', async () => {
    const matches = await WaitForTool.preparePermissionMatcher?.({
      setup: 'tmux send-keys -t s Enter',
      command: 'tmux capture-pane -t s -p',
      description: 'd',
    } as never)
    expect(matches?.('tmux send-keys:*')).toBe(true)
    expect(matches?.('tmux capture-pane:*')).toBe(true)
    // Without the tree-sitter parser (parse-unavailable) the matcher is
    // permissive by design, same as Monitor's — only assert the negative when
    // the parser actually ran.
    const parsed = await parseForSecurity('tmux capture-pane -t s -p')
    if (parsed.kind === 'simple') {
      expect(matches?.('rm:*')).toBe(false)
    }
  })
})

describe('sleep-poll redirect', () => {
  beforeEach(() => resetWaitForRedirectMemoForTesting())

  test('leading sleep followed by a check is a poll', () => {
    expect(detectSleepPoll('sleep 5; tmux capture-pane -t s -p | tail -30')).toEqual({
      secs: 5,
      setup: '',
      command: 'tmux capture-pane -t s -p | tail -30',
    })
  })

  test('mid-chain sleep splits into setup and command, keeping pipes', () => {
    expect(
      detectSleepPoll('tmux send-keys -t s Enter && sleep 8 && tmux capture-pane -t s -p | tail -25'),
    ).toEqual({
      secs: 8,
      setup: 'tmux send-keys -t s Enter',
      command: 'tmux capture-pane -t s -p | tail -25',
    })
  })

  test('standalone, short, fractional and nested sleeps are not polls', () => {
    expect(detectSleepPoll('sleep 20')).toBeNull()
    expect(detectSleepPoll('sleep 1; cat f')).toBeNull()
    expect(detectSleepPoll('sleep 0.5 && cat f')).toBeNull()
    expect(detectSleepPoll('for i in 1 2 3; do sleep 2; cat f; done')).toBeNull()
    expect(detectSleepPoll('cat f | sleep 5')).toBeNull()
  })

  test('refusal is one-shot: the identical resend runs', () => {
    const cmd = 'sleep 5; cat /tmp/out'
    expect(shouldRedirectSleepPoll(cmd)).toBe(true)
    expect(shouldRedirectSleepPoll(cmd)).toBe(false)
  })

  test('refusal text hands back the exact WaitFor call', () => {
    const text = renderWaitForRedirect({
      secs: 8,
      setup: 'tmux send-keys -t s Enter',
      command: 'tmux capture-pane -t s -p',
    })
    expect(text).toContain('Blocked: sleep 8 followed by a check')
    expect(text).toContain(
      'WaitFor({"setup":"tmux send-keys -t s Enter","command":"tmux capture-pane -t s -p","until":"<regex you are waiting for>","timeout_s":48})',
    )
    expect(text).toContain('Re-send this exact command')
  })
})
