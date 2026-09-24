import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { getBashRedirectMode, pickBashRedirect } from 'src/tools/BashTool/redirectLanes.js'
import { resetToolRedirectMemoForTesting } from 'src/tools/BashTool/toolRedirect.js'
import { resetBuildRedirectMemoForTesting } from 'src/tools/BuildTool/redirect.js'
import { renderGitRedirect, resetGitRedirectMemoForTesting } from 'src/tools/GitTool/redirect.js'
import { renderRunTestsRedirect, resetRunTestsRedirectMemoForTesting } from 'src/tools/RunTestsTool/redirect.js'
import { resetTypecheckRedirectMemoForTesting } from 'src/tools/TypecheckTool/redirect.js'
import { resetWaitForRedirectMemoForTesting } from 'src/tools/WaitForTool/redirect.js'

// Every lane, both modes. `feature('MONITOR_TOOL')` is false under the test
// preload, so the blocking-sleep lane is the one not reachable here.

const ENV_KEYS = [
  'CLAUDIN_BASH_REDIRECT',
  'CLAUDIN_DISABLE_RUNTESTS_REDIRECT',
  'CLAUDIN_DISABLE_TYPECHECK_REDIRECT',
  'CLAUDIN_DISABLE_BUILD_REDIRECT',
  'CLAUDIN_DISABLE_GIT_REDIRECT',
  'CLAUDIN_DISABLE_TOOL_REDIRECT',
  'CLAUDIN_ENABLE_WAITFOR_REDIRECT',
  'CLAUDIN_DISABLE_WAITFOR_REDIRECT',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetRunTestsRedirectMemoForTesting()
  resetTypecheckRedirectMemoForTesting()
  resetBuildRedirectMemoForTesting()
  resetGitRedirectMemoForTesting()
  resetToolRedirectMemoForTesting()
  resetWaitForRedirectMemoForTesting()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const ALL = () => true
const NONE = () => false
const CWD = process.cwd()
const POLL = 'tmux send-keys -t s Enter && sleep 8 && tmux capture-pane -t s -p'

const advise = (command: string, hasTool = ALL) =>
  pickBashRedirect({ command }, hasTool, CWD, 'advise')
const refuse = (command: string, hasTool = ALL) =>
  pickBashRedirect({ command }, hasTool, CWD, 'refuse')

describe('mode', () => {
  test('advise unless CLAUDIN_BASH_REDIRECT is refuse or off', () => {
    expect(getBashRedirectMode()).toBe('advise')
    process.env.CLAUDIN_BASH_REDIRECT = 'refuse'
    expect(getBashRedirectMode()).toBe('refuse')
    process.env.CLAUDIN_BASH_REDIRECT = 'off'
    expect(getBashRedirectMode()).toBe('off')
    process.env.CLAUDIN_BASH_REDIRECT = 'anything else'
    expect(getBashRedirectMode()).toBe('advise')
  })
})

describe('advise mode: each lane names its tool and the call to make', () => {
  test('tests → RunTests', () => {
    const r = advise('bun test src/a.test.ts')
    expect(r?.suggests).toBe('RunTests')
    expect(r?.message).toContain('has a dedicated tool')
    expect(r?.message).toContain('RunTests({"command":"bun test src/a.test.ts"})')
    expect(r?.message).not.toContain('Blocked')
  })

  test('type-checks → Typecheck', () => {
    const r = advise('tsc --noEmit')
    expect(r?.suggests).toBe('Typecheck')
    expect(r?.message).toContain('Typecheck({"command":"tsc --noEmit"})')
  })

  test('builds → Build, keeping the directory a `cd` named', () => {
    const r = advise('cd api && cargo build')
    expect(r?.suggests).toBe('Build')
    expect(r?.message).toContain('Build({"directory":"api","command":"cargo build"})')
  })

  test('repository reads → Git, keeping the checkout a `cd` named', () => {
    expect(advise('git status')?.message).toContain('Git({"commands":["git status"]})')
    expect(advise('cd /srv/other && git log -5')?.message).toContain(
      'Git({"cwd":"/srv/other","commands":["git log -5"]})',
    )
  })

  test('file reads → Read, with no tool to load', () => {
    const r = advise('cat package.json')
    expect(r?.suggests).toBeUndefined()
    expect(r?.message).toContain('only reads or searches files')
    expect(r?.message).toContain('Read(file_path:')
  })

  test('a sleep poll → WaitFor, on by default here', () => {
    const r = advise(POLL)
    expect(r?.suggests).toBe('WaitFor')
    expect(r?.message).toContain('WaitFor({"setup":"tmux send-keys -t s Enter"')
  })

  test('CLAUDIN_DISABLE_WAITFOR_REDIRECT=1 switches the sleep-poll lane off', () => {
    process.env.CLAUDIN_DISABLE_WAITFOR_REDIRECT = '1'
    expect(advise(POLL)).toBeNull()
  })

  test('once per distinct command', () => {
    expect(advise('bun test src/a.test.ts')).not.toBeNull()
    expect(advise('bun test src/a.test.ts')).toBeNull()
    expect(advise('bun test src/b.test.ts')).not.toBeNull()
  })
})

describe('refuse mode: the refusals from before, byte for byte', () => {
  test('tests', () => {
    const command = 'bun test src/a.test.ts'
    expect(refuse(command)?.message).toBe(renderRunTestsRedirect(command))
    expect(refuse(command)?.errorCode ?? 'ran').toBe('ran')
  })

  test('repository reads', () => {
    expect(refuse('git status')?.message).toBe(renderGitRedirect('git status'))
  })

  test('the sleep-poll lane stays opt-in', () => {
    expect(refuse(POLL)).toBeNull()
    resetWaitForRedirectMemoForTesting()
    process.env.CLAUDIN_ENABLE_WAITFOR_REDIRECT = '1'
    expect(refuse(POLL)?.message).toContain('Blocked: sleep 8 followed by a check')
  })
})

describe('gates, in both modes', () => {
  test.each(['advise', 'refuse'] as const)('%s: never for a backgrounded run', mode => {
    expect(
      pickBashRedirect({ command: 'bun test', run_in_background: true }, ALL, CWD, mode),
    ).toBeNull()
  })

  test.each(['advise', 'refuse'] as const)('%s: only for a tool in this toolset', mode => {
    expect(pickBashRedirect({ command: 'bun test' }, NONE, CWD, mode)).toBeNull()
    expect(pickBashRedirect({ command: 'cat package.json' }, NONE, CWD, mode)).toBeNull()
  })

  test.each([
    ['CLAUDIN_DISABLE_RUNTESTS_REDIRECT', 'bun test'],
    ['CLAUDIN_DISABLE_TYPECHECK_REDIRECT', 'tsc --noEmit'],
    ['CLAUDIN_DISABLE_BUILD_REDIRECT', 'cargo build'],
    ['CLAUDIN_DISABLE_GIT_REDIRECT', 'git status'],
    ['CLAUDIN_DISABLE_TOOL_REDIRECT', 'cat package.json'],
  ])('%s switches its lane off', (key, command) => {
    process.env[key] = '1'
    expect(advise(command)).toBeNull()
    expect(refuse(command)).toBeNull()
  })
})

describe('BashTool wiring', () => {
  const context = {
    options: { tools: [{ name: 'RunTests' }, { name: 'Read' }] },
  } as unknown as ToolUseContext

  test('by default the command runs, and advise carries the pointer', async () => {
    const validated = await BashTool.validateInput?.({ command: 'bun test src/a.test.ts' } as never, context)
    expect(validated?.result).toBe(true)
    const advice = BashTool.advise?.({ command: 'bun test src/b.test.ts' } as never, context)
    expect(advice?.suggests).toBe('RunTests')
    expect(advice?.message).toContain('RunTests({"command":"bun test src/b.test.ts"})')
  })

  test('in refuse mode the command is refused, and advise stays silent', async () => {
    process.env.CLAUDIN_BASH_REDIRECT = 'refuse'
    const validated = await BashTool.validateInput?.({ command: 'bun test src/a.test.ts' } as never, context)
    expect(validated).toMatchObject({ result: false, errorCode: 11 })
    expect(BashTool.advise?.({ command: 'bun test src/b.test.ts' } as never, context)).toBeNull()
  })

  test('in off mode the command runs and nothing points anywhere', async () => {
    process.env.CLAUDIN_BASH_REDIRECT = 'off'
    const validated = await BashTool.validateInput?.({ command: 'bun test src/a.test.ts' } as never, context)
    expect(validated?.result).toBe(true)
    expect(BashTool.advise?.({ command: 'bun test src/b.test.ts' } as never, context)).toBeNull()
  })
})
