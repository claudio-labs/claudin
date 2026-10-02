/**
 * Characterization of the two dialog launchers the boot path keeps
 * (src/terminal/dialogLaunchers.tsx), pinned before the lever cut removes the
 * teleport launchers beside them.
 *
 * - `launchInvalidSettingsDialog` shows the settings-error dialog and settles
 *   with nothing once the user chooses to go on; the other choice is handed to
 *   the caller's `onExit` and leaves the launcher waiting.
 * - `launchResumeChooser` mounts the session picker inside the app shell, over
 *   the worktree paths it is given, and passes the picker's options through.
 *
 * Each test draws into a fake terminal and reads the screen. The chooser runs
 * until its root exits, so the test closes the root itself; that rejection is
 * the launcher's only way out short of the process-wide shutdown.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  closeScreen,
  openScreen,
  outcome,
  SCREEN_CLOSED,
  type Screen,
  waitFor,
} from 'src/platform/main/__testutils__/bootHarness.js'
import { useRestoreSandbox, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import { createStatsStore } from 'src/terminal/contexts/stats.js'
import { launchInvalidSettingsDialog, launchResumeChooser } from 'src/terminal/dialogLaunchers.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const TIMEOUT = 30_000
const ENTER = '\r'
const DOWN = '\x1B[B'
const ESC = '\x1B'

const sandbox = useRestoreSandbox()
let prefetchSwitch: string | undefined

beforeAll(() => {
  // The chooser's renderAndRun warms caches after the first paint unless told not to.
  prefetchSwitch = process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER
  process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER = '1'
})

afterAll(() => {
  if (prefetchSwitch === undefined) delete process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER
  else process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER = prefetchSwitch
})

const badSettings = [
  { file: '.claudin/settings.json', path: 'permissions.defaultMode', message: 'Invalid enum value' },
  { file: '.claudin/settings.local.json', path: 'model', message: 'Expected string, received number' },
]

describe('launchInvalidSettingsDialog', () => {
  const choices = [
    { keys: [DOWN, ENTER], label: 'choosing to continue', settles: true, exits: 0 },
    { keys: [ENTER], label: 'choosing to exit', settles: false, exits: 1 },
    { keys: [ESC], label: 'dismissing the dialog', settles: false, exits: 1 },
  ]

  for (const choice of choices) {
    test(`${choice.label}: settles=${choice.settles}, onExit calls=${choice.exits}`, async () => {
      const screen = await openScreen()
      let exits = 0
      let settled = false
      const launched = launchInvalidSettingsDialog(screen.root, {
        settingsErrors: badSettings as never,
        onExit: () => {
          exits++
        },
      }).then(value => {
        settled = true
        return value
      })
      try {
        const shown = await waitFor(screen.term.screen, s => s.includes('Continue without these settings'))
        for (const fragment of ['Settings Error', '.claudin/settings.local.json', 'defaultMode: Invalid enum value', 'Exit and fix manually']) {
          expect(shown).toContain(fragment)
        }
        for (const key of choice.keys) {
          screen.term.type(key)
          await Bun.sleep(60)
        }
        if (choice.settles) expect(await launched).toBeUndefined()
        else await Bun.sleep(150)
        expect({ settled, exits }).toEqual({ settled: choice.settles, exits: choice.exits })
      } finally {
        closeScreen(screen)
      }
    }, TIMEOUT)
  }
})

describe('launchResumeChooser', () => {
  const appProps = () => ({
    getFpsMetrics: () => undefined,
    stats: createStatsStore(),
    initialState: getDefaultAppState(),
  })
  const pickerProps = (extra: Record<string, unknown> = {}) =>
    ({
      commands: [],
      initialTools: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      ...extra,
    }) as never

  async function choose(
    worktrees: () => string[],
    extra: Record<string, unknown>,
    ready: (s: string) => boolean,
  ): Promise<{ shown: string; screen: Screen; run: Promise<unknown> }> {
    const screen = await openScreen(120)
    const run = launchResumeChooser(screen.root, appProps(), Promise.resolve(worktrees()), pickerProps(extra))
    const shown = await waitFor(screen.term.screen, ready).catch(error => {
      closeScreen(screen)
      throw error
    })
    return { shown, screen, run }
  }

  test('with no session in the given worktrees, says there is nothing to resume', async () => {
    const { shown, screen, run } = await choose(() => [sandbox.projectDir], {}, s => s.includes('No conversations'))
    expect(shown).toContain('No conversations found to resume.')
    closeScreen(screen)
    const settled = await outcome(run)
    expect((settled.error as Error).message).toBe(SCREEN_CLOSED)
  }, TIMEOUT)

  test('lists the sessions recorded under the given worktrees, newest first', async () => {
    await writeSession({ title: 'Parser rewrite' })
    await Bun.sleep(5)
    await writeSession({ title: 'Lexer cleanup' })
    const { shown, screen, run } = await choose(() => [sandbox.projectDir], {}, s => s.includes('Lexer cleanup'))
    try {
      expect(shown).toContain('Parser rewrite')
      expect(shown.indexOf('Lexer cleanup')).toBeLessThan(shown.indexOf('Parser rewrite'))
    } finally {
      closeScreen(screen)
      await outcome(run)
    }
  }, TIMEOUT)

  const filters = [
    { name: 'filterByPr', extra: { filterByPr: 17 }, kept: 'Linked to seventeen', dropped: 'Unlinked work' },
    { name: 'initialSearchQuery', extra: { initialSearchQuery: 'Unlinked' }, kept: 'Unlinked work', dropped: 'Linked to seventeen' },
  ]
  for (const filter of filters) {
    test(`passes ${filter.name} through to the picker`, async () => {
      await writeSession({
        title: 'Linked to seventeen',
        pr: { number: 17, url: 'https://github.com/acme/app/pull/17', repository: 'acme/app' },
      })
      await writeSession({ title: 'Unlinked work' })
      const { shown, screen, run } = await choose(() => [sandbox.projectDir], filter.extra, s => s.includes(filter.kept))
      try {
        await Bun.sleep(200)
        expect(screen.term.screen()).not.toContain(filter.dropped)
        expect(shown).toContain(filter.kept)
      } finally {
        closeScreen(screen)
        await outcome(run)
      }
    }, TIMEOUT)
  }
})
