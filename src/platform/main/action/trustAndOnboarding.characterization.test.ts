/**
 * Characterization of `runTrustAndOnboarding` (src/platform/main/action/trustAndOnboarding.ts),
 * the interactive start-up block between loading the commands and loading the
 * MCP configs, pinned before the lever cut removes its remote-control gate and
 * its remote-settings and policy-limits refreshes.
 *
 * The block opens the session's Ink root on the process's own terminal, so
 * each test hands the process a fake one (stdin and stdout) for the call. What
 * a caller sees:
 * - a root, a frame-metrics reader and a stats store come back, with the
 *   prompt and the input prompt as given;
 * - with no provider configured, the first-run provider wizard is shown and
 *   the call waits until the user leaves it;
 * - with CLAUDIN_CLEAR_ON_START=1, a provider and a TTY, the screen is
 *   cleared before the session starts, and only then.
 *
 * Not reachable here: the onboarding branch (showSetupScreens skips every
 * screen when NODE_ENV is `test`, so it never reports onboarding as shown)
 * and the org check failing, which needs a claude.ai login and its profile
 * endpoint.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { getStatsStore, setStatsStore } from 'src/platform/bootstrap/state.js'
import { closeScreen, outcome, useBootSandbox, waitFor } from 'src/platform/main/__testutils__/bootHarness.js'
import { runTrustAndOnboarding } from 'src/platform/main/action/trustAndOnboarding.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { deleteProviderProfile, getProviderProfiles } from 'src/providers/presets/providerProfiles.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { Text } from 'src/terminal/ink.js'
import { clearTerminal } from 'src/terminal/ink/clearTerminal.js'

const TIMEOUT = 30_000
const ESC = '\x1B'

useBootSandbox(['CLAUDIN_CLEAR_ON_START', 'CI'])

let statsBefore: ReturnType<typeof getStatsStore>
beforeAll(() => {
  statsBefore = getStatsStore()
})
afterAll(() => {
  setStatsStore(statsBefore)
})

type Swap = { term: FakeTerminal; restore(): void }
let active: Swap | undefined

/** Gives the process a fake terminal until `restore()`. */
function takeOverTerminal(options: { tty: boolean }): Swap {
  const term = createFakeTerminal({ columns: 100 })
  Object.assign(term.stdout, { isTTY: options.tty, rows: 40 })
  const saved = {
    stdout: Object.getOwnPropertyDescriptor(process, 'stdout')!,
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin')!,
  }
  Object.defineProperty(process, 'stdout', { value: term.stdout, configurable: true, writable: true })
  Object.defineProperty(process, 'stdin', { value: term.stdin, configurable: true, writable: true })
  // No /dev/tty fallback for stdin: the fake one is the terminal.
  process.env.CI = '1'
  return {
    term,
    restore() {
      Object.defineProperty(process, 'stdout', saved.stdout)
      Object.defineProperty(process, 'stdin', saved.stdin)
    },
  }
}

afterEach(() => {
  if (!active) return
  // A TTY stdout makes Ink write its reset sequences to fd 1 on unmount; this one is not a real terminal.
  Object.assign(active.term.stdout, { isTTY: false })
  closeScreen({ term: active.term, root: undefined as never })
  active.restore()
  active = undefined
})

function input(overrides: Partial<Parameters<typeof runTrustAndOnboarding>[0]> = {}) {
  return {
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    commands: [],
    devChannels: undefined,
    remoteControlOption: undefined,
    mainThreadAgentDefinition: undefined,
    prompt: undefined,
    inputPrompt: '',
    ...overrides,
  } as Parameters<typeof runTrustAndOnboarding>[0]
}

/** What a TTY shows: Ink moves the cursor right instead of writing spaces there. */
function asDrawn(term: FakeTerminal): string {
  return stripAnsi(term.transcript().replace(/\x1B\[(\d+)C/g, (_, n: string) => ' '.repeat(Number(n))))
}

function removeEveryProfile(): void {
  for (const profile of getProviderProfiles()) deleteProviderProfile(profile.id)
  invalidateActiveProviderCache()
}

describe('runTrustAndOnboarding — with a provider configured', () => {
  const prompts: Array<{ prompt: string | undefined; inputPrompt: string | AsyncIterable<string> }> = [
    { prompt: undefined, inputPrompt: '' },
    { prompt: 'fix the parser', inputPrompt: 'fix the parser' },
    { prompt: '/login', inputPrompt: '/login' },
    { prompt: '  /LOGIN ', inputPrompt: 'piped text' },
  ]
  for (const c of prompts) {
    test(`hands back prompt ${JSON.stringify(c.prompt)} and its input prompt unchanged`, async () => {
      active = takeOverTerminal({ tty: false })
      const result = await runTrustAndOnboarding(input(c))
      expect({ prompt: result.prompt, inputPrompt: result.inputPrompt }).toEqual(c)
    }, TIMEOUT)
  }

  test('hands back a live root, a frame-metrics reader and a stats store', async () => {
    active = takeOverTerminal({ tty: false })
    const result = await runTrustAndOnboarding(input())
    expect(typeof result.getFpsMetrics).toBe('function')
    expect(typeof result.stats.observe).toBe('function')
    expect(typeof result.stats.getAll).toBe('function')
    result.stats.observe('char_probe', 7)
    expect(result.stats.getAll()).toMatchObject({ char_probe_count: 1 })
    expect(getStatsStore()).toBe(result.stats)
    result.root.render(React.createElement(Text, null, 'root still drawing'))
    expect(await waitFor(active.term.screen, s => s.includes('root still drawing'))).toContain('root still drawing')
  }, TIMEOUT)

  const clearing = [
    { setting: '1', tty: true, cleared: true },
    { setting: undefined, tty: true, cleared: false },
    { setting: 'true', tty: true, cleared: false },
    { setting: '1', tty: false, cleared: false },
  ]
  for (const c of clearing) {
    test(`CLAUDIN_CLEAR_ON_START=${c.setting ?? '(unset)'}, tty=${c.tty}: screen cleared=${c.cleared}`, async () => {
      if (c.setting === undefined) delete process.env.CLAUDIN_CLEAR_ON_START
      else process.env.CLAUDIN_CLEAR_ON_START = c.setting
      active = takeOverTerminal({ tty: c.tty })
      await runTrustAndOnboarding(input())
      expect(active.term.transcript().includes(clearTerminal)).toBe(c.cleared)
    }, TIMEOUT)
  }
})

describe('runTrustAndOnboarding — with no provider configured', () => {
  test('shows the first-run provider wizard and waits until the user leaves it', async () => {
    removeEveryProfile()
    process.env.CLAUDIN_CLEAR_ON_START = '1'
    active = takeOverTerminal({ tty: true })
    let settled = false
    const run = runTrustAndOnboarding(input({ prompt: 'hello' })).finally(() => {
      settled = true
    })
    const shown = await waitFor(() => asDrawn(active!.term), s => s.includes('Set up provider'))
    expect(shown).toContain('Set up provider')
    await Bun.sleep(100)
    expect(settled).toBe(false)

    active.term.type(ESC)
    const result = await outcome(run)
    expect(result.error).toBeUndefined()
    expect(result.value?.prompt).toBe('hello')
    // Leaving the wizard configures nothing, so there is still no provider to clear the screen for.
    expect(getProviderProfiles()).toEqual([])
    expect(active.term.transcript().includes(clearTerminal)).toBe(false)
  }, TIMEOUT)
})
