import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { maxTimeoutS, WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import {
  detectSleepPoll,
  renderWaitForAdvice,
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

function allowCtx(allow: string[]): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { cliArg: allow },
  }
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    getAppState: () => ({ toolPermissionContext }),
  } as unknown as ToolUseContext
}

beforeAll(() => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
})

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
      WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_s: 1800 })
        .success,
    ).toBe(true)
    expect(
      WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_s: 1801 })
        .success,
    ).toBe(false)
    expect(WaitForTool.name).toBe('WaitFor')
    expect(WaitForTool.userFacingName()).toBe('Wait')
  })

  test('the cap is 1800 s, and CLAUDIN_WAITFOR_MAX_TIMEOUT_S moves it', () => {
    const saved = process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S
    try {
      delete process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S
      expect(maxTimeoutS()).toBe(1800)
      process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S = '600'
      expect(maxTimeoutS()).toBe(600)
      for (const junk of ['', '0', 'abc', '-5']) {
        process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S = junk
        expect([junk, maxTimeoutS()]).toEqual([junk, 1800])
      }
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S
      else process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S = saved
    }
  })

  test('validateInput rejects an invalid until regex', async () => {
    const bad = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: '(' } as never,
    )
    expect(bad?.result).toBe(false)
    expect(bad?.result === false && bad.message).toStartWith('Invalid `until` regex: ')
    const ok = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: 'READY' } as never,
    )
    expect(ok?.result).toBe(true)
  })

  test('until: a leading (?s) or (?i) is read as flags, as PCRE and Python spell them', async () => {
    // The census saw this rejected three times, always to wait for CI rows
    // spread over several lines; JavaScript has no global inline flag group.
    const census = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: '(?s)^(?!.*pending).*(pass|fail)' } as never,
    )
    expect(census?.result).toBe(true)

    const dotAll = await WaitForTool.call(
      { command: "printf 'pass\\nsmoke'", until: '(?s)pass.smoke', interval_s: 0.2, timeout_s: 5, description: 'd' },
      makeCtx(),
    )
    expect(dotAll.data.matched).toBe(true)

    const caseless = await WaitForTool.call(
      { command: 'echo ready', until: '(?i)READY', interval_s: 0.2, timeout_s: 5, description: 'd' },
      makeCtx(),
    )
    expect(caseless.data.matched).toBe(true)
  })

  test('until: `.` stays on one line unless the pattern asks otherwise', async () => {
    // No implicit flags: a pattern written for one line must not start matching
    // across two, which would end a wait early on output it was not waiting for.
    const { data } = await WaitForTool.call(
      { command: "printf 'pass\\nsmoke'", until: 'pass.smoke', interval_s: 0.2, timeout_s: 1, description: 'd' },
      makeCtx(),
    )
    expect(data.matched).toBe(false)
    expect(data.reason).toBe('timeout')
  })

  test('until: a flag JavaScript does not have is still an invalid regex', async () => {
    const bad = await WaitForTool.validateInput?.(
      { command: 'ls', description: 'd', until: '(?x) READY # spaced' } as never,
    )
    expect(bad?.result).toBe(false)
  })

  test('read-only exactly when its setup and poll only read, so plan mode lets it watch', () => {
    // The census saw a wait on a task's output file refused in plan mode, where
    // the same `tail` through Bash would have run.
    const input = (fields: { command: string; setup?: string }) => ({ description: 'd', ...fields }) as never
    expect(WaitForTool.isReadOnly(input({ command: 'tail -c 400 package.json; ls src' }))).toBe(true)
    expect(WaitForTool.isReadOnly(input({ command: 'rm -f stale.out' }))).toBe(false)
    // The setup runs too, so it counts.
    expect(WaitForTool.isReadOnly(input({ setup: 'rm -f stale.out', command: 'cat package.json' }))).toBe(false)
  })

  test('a wait that only reads runs beside other tools', () => {
    const input = { command: 'tail -c 400 package.json', description: 'd' } as never
    expect(WaitForTool.isConcurrencySafe(input)).toBe(true)
  })

  test('a wait that writes — in its poll or its setup — does not, like Bash', () => {
    // A `tmux send-keys` setup or an `rm` poll ran in parallel with whatever
    // else the response held, while the same command through Bash would wait.
    const input = (fields: { command: string; setup?: string }) => ({ description: 'd', ...fields }) as never
    expect(WaitForTool.isConcurrencySafe(input({ command: 'rm -f stale.out' }))).toBe(false)
    expect(WaitForTool.isConcurrencySafe(input({ setup: 'rm -f stale.out', command: 'cat package.json' }))).toBe(false)
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

  test('a cap set below the default timeout caps a call that names none', async () => {
    const saved = process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S
    process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S = '1'
    try {
      const { data } = await WaitForTool.call(
        { command: 'echo never', until: 'READY', interval_s: 0.2, description: 'capped' },
        makeCtx(),
      )
      expect(data.reason).toBe('timeout')
      expect(data.elapsedMs).toBeLessThan(5_000)
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S
      else process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S = saved
    }
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

  // bashToolHasPermission answers `updatedInput: { command }` and the harness
  // applies updatedInput verbatim, so passing it through replaced the whole
  // input before call(): until/settle_s/interval_s/timeout_s vanished and every
  // wait "settled after 3.1s", whatever it was asked for.
  test('on allow it hands back its own input, never the Bash-shaped one', async () => {
    const input = {
      setup: 'echo go',
      command: 'echo stable',
      until: 'NEVER_MATCHES',
      settle_s: 5,
      interval_s: 0.5,
      timeout_s: 8,
      description: 'd',
    }
    const result = await WaitForTool.checkPermissions(input, allowCtx(['Bash(echo:*)']))
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toBe(input)
    }
  })

  // The matcher is permissive by construction: the per-subcommand version it
  // used to build needed argv from a parser that has never produced a tree, and
  // matching.ts treats a MISSING matcher as "no match" — so returning true is
  // what keeps an `if`-conditioned hook firing at all.
  test('permission matcher matches every if condition', async () => {
    const matches = await WaitForTool.preparePermissionMatcher?.({
      setup: 'tmux send-keys -t s Enter',
      command: 'tmux capture-pane -t s -p',
      description: 'd',
    } as never)
    expect(matches?.('tmux send-keys:*')).toBe(true)
    expect(matches?.('tmux capture-pane:*')).toBe(true)
    expect(matches?.('rm:*')).toBe(true)
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

  test('the call the redirect and the advice hand back validates, under the cap', () => {
    const callOf = (text: string) => JSON.parse(/WaitFor\((\{.*\})\)/.exec(text)![1]!)
    for (const poll of [{ secs: 8, command: 'cat /tmp/out' }, { secs: 900, setup: 'make', command: 'tail -3 log' }]) {
      for (const text of [renderWaitForRedirect(poll), renderWaitForAdvice(poll)]) {
        const parsed = WaitForTool.inputSchema.safeParse(callOf(text))
        expect([text, parsed.success]).toEqual([text, true])
      }
    }
  })
})
