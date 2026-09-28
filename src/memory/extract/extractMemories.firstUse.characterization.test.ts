/**
 * What the unit does before anything set it up: the stop hook and the
 * headless shutdown call it whether or not startup ran initExtractMemories.
 *
 * That state only exists once per process, and every other suite initializes
 * the unit. So under the plain runner this file's one test re-runs the file in
 * a child `bun test`, alone, and the checks below run there. (Loading a second
 * copy of the module instead would do, but it replaces the real copy in the
 * coverage report.)
 */
import { expect, test } from 'bun:test'

import {
  drainPendingExtraction,
  executeExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import {
  checkoutRoot,
  humanSays,
  turnEnded,
  useForkDouble,
  useScene,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { getLastSummarizedMessageId } from 'src/memory/session/sessionMemoryUtils.js'

const CHILD_SWITCH = 'EXTRACT_CHARACTERIZATION_FRESH_PROCESS'

if (process.env[CHILD_SWITCH] !== '1') {
  test('holds in a fresh process where nothing was initialized', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: checkoutRoot(),
      env: { ...process.env, [CHILD_SWITCH]: '1' },
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
    if (exitCode !== 0 || failed !== 0 || passed !== 3) {
      throw new Error(`the fresh-process run failed (exit ${exitCode}):\n${report.slice(-6_000)}`)
    }
    expect(passed).toBe(3)
  }, 120_000)
} else {
  useScene()
  const fork = useForkDouble()

  test('before initExtractMemories, an end of turn starts nothing', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
    await expect(
      executeExtractMemories(turnEnded([humanSays('a')])),
    ).resolves.toBeUndefined()
    expect(fork.requests).toHaveLength(0)
  })

  test('before initExtractMemories, draining returns at once', async () => {
    const started = performance.now()
    await drainPendingExtraction()
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('no message is marked as summarized yet', () => {
    expect(getLastSummarizedMessageId()).toBeUndefined()
  })
}
