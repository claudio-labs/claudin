/**
 * The auto-dream as the shipped binary runs it, in a process of its own.
 *
 * Two things cannot be seen from the plain runner. `scripts/build/build.ts`
 * turns TEAMMEM on, and `bun test` folds every `feature()` to false; and "no
 * one called initAutoDream yet" exists only once per process, before any
 * other suite initializes the unit. So under the plain runner this file's one
 * test re-runs it in a child `bun test` with the flag on, alone, and the
 * checks below run there. A failure in the child fails the parent test, with
 * the child's output.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { executeAutoDream, initAutoDream } from 'src/memory/autoDream/autoDream.js'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import {
  checkoutRoot,
  humanSays,
  turnEnded,
  useForkDouble,
  useScene,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import type { UserMessage } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

// `feature()` has to sit directly in a ternary: any other form throws under `bun test`.
const SHIPPED = feature('TEAMMEM') ? true : false
const EXPECTED_IN_CHILD = 2

if (!SHIPPED) {
  test('holds in a fresh process built with TEAMMEM on', async () => {
    const child = Bun.spawn([process.execPath, 'test', '--feature=TEAMMEM', import.meta.path], {
      cwd: checkoutRoot(),
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (exitCode !== 0 || failed !== 0 || passed !== EXPECTED_IN_CHILD) {
      throw new Error(`the child run failed (exit ${exitCode}):\n${report.slice(-6_000)}`)
    }
    expect(passed).toBe(EXPECTED_IN_CHILD)
  }, 120_000)
} else {
  const scene = useScene()
  const fork = useForkDouble()

  /** Everything a consolidation needs: the setting, an old lock, five sessions. */
  function makeDue(): void {
    writeFileSync(join(scene().configDir, 'settings.json'), JSON.stringify({ autoDreamEnabled: true }))
    resetSettingsCache()
    const transcripts = getProjectDir(getOriginalCwd())
    mkdirSync(transcripts, { recursive: true })
    const recent = (Date.now() - 60_000) / 1000
    for (let i = 0; i < 5; i++) {
      const file = join(transcripts, `${randomUUID()}.jsonl`)
      writeFileSync(file, '{}\n')
      utimesSync(file, recent - i, recent - i)
    }
  }

  function endOfTurn() {
    let state = { tasks: {} } as unknown as AppState
    return turnEnded([humanSays('ship it')], {
      getAppState: () => state,
      setAppState: (update: (prev: AppState) => AppState) => {
        state = update(state)
      },
    } as Partial<ToolUseContext>)
  }

  describe('a fresh process', () => {
    // Must stay the first test of the file: it is the only moment nothing is initialized.
    test('before initAutoDream, an end of turn does nothing, even when a consolidation is due', async () => {
      makeDue()
      await expect(executeAutoDream(endOfTurn())).resolves.toBeUndefined()
      expect(fork.requests).toHaveLength(0)
      expect(existsSync(join(scene().memoryDir, '.consolidate-lock'))).toBe(false)
    })

    test('with team memory on, the prompt files team knowledge into the team directory', async () => {
      initAutoDream()
      makeDue()
      await executeAutoDream(endOfTurn())
      expect(fork.requests).toHaveLength(1)
      const prompt = (fork.requests[0]!.promptMessages[0] as UserMessage).message.content as string
      const transcripts = getProjectDir(getOriginalCwd())
      const base = buildConsolidationPrompt(scene().memoryDir, transcripts, '', getTeamMemPath())
      expect(prompt.startsWith(`${base}\n\n## Additional context\n\n`)).toBe(true)
      expect(prompt).not.toBe(base)
      expect(base).not.toBe(buildConsolidationPrompt(scene().memoryDir, transcripts, ''))
    })
  })
}
