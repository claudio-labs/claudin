/**
 * The startup picker's fixes and its injected exit, on the same rig as its
 * characterization suite.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import React from 'react'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  FIXTURE_TITLE,
  KEYS,
  listed,
  mountInApp,
  placeSession,
  useResumeWorld,
} from 'src/sessions/ui/__testutils__/resumeRig.js'
import { ResumePicker } from 'src/sessions/ui/resumePicker/ResumePicker.js'

const TIMEOUT = 30_000
const world = useResumeWorld()

async function mountWithExit(props: { filterByPr?: number } = {}) {
  const exits: number[] = []
  const picker = await mountInApp(
    <ResumePicker
      commands={[]}
      initialTools={[]}
      debug={false}
      thinkingConfig={{ type: 'disabled' }}
      worktreePaths={[world.sandbox.projectDir]}
      exit={code => exits.push(code)}
      {...props}
    />,
  )
  return { picker, exits }
}

describe('ResumePicker', () => {
  test('with no session here, Ctrl+A on the empty screen lists the other projects, and Ctrl+A again comes back', async () => {
    placeSession({ project: join(world.sandbox.root, 'elsewhere'), title: 'Over there' })
    const { picker, exits } = await mountWithExit()
    const empty = await listed(picker, 'No conversations found to resume.')
    expect(empty).toContain('Press Ctrl+A to show sessions from all projects.')

    await picker.press(KEYS.ctrlA)
    const everywhere = await picker.waitFor('Over there')
    expect(everywhere).toContain('· all projects')

    await Bun.sleep(150)
    await picker.press(KEYS.ctrlA)
    const back = await picker.waitFor('No conversations found to resume.')
    expect(back).not.toContain('Over there')
    expect(back).toContain('Press Ctrl+A to show sessions from all projects.')
    expect(exits).toEqual([])
    expect(world.exits()).toEqual([])
  }, TIMEOUT)

  test('a filter that leaves every project empty keeps the empty screen after Ctrl+A', async () => {
    placeSession({ project: join(world.sandbox.root, 'elsewhere'), title: 'Over there', pr: 17 })
    const { picker } = await mountWithExit({ filterByPr: 99 })
    await listed(picker, 'No conversations found to resume.')
    await picker.press(KEYS.ctrlA)
    const shown = await picker.waitFor("Press Ctrl+A to show this project's sessions.")
    expect(shown).not.toContain('Over there')
  }, TIMEOUT)

  test('Ctrl+C on the empty screen and Esc on the list end through the injected exit', async () => {
    const empty = await mountWithExit()
    await listed(empty.picker, 'No conversations found to resume.')
    await empty.picker.press(KEYS.ctrlC)
    expect(empty.exits).toEqual([1])
    await empty.picker.close()

    placeSession({ project: world.sandbox.projectDir })
    const list = await mountWithExit()
    await listed(list.picker, FIXTURE_TITLE)
    await list.picker.press(KEYS.escape)
    expect(list.exits).toEqual([1])
    expect(world.exits()).toEqual([])
  }, TIMEOUT)

  test('the command for a session of another directory runs claudin, and the process ends with 0', async () => {
    placeSession({ project: world.sandbox.projectDir, title: 'Local work', minutesAgo: 60 })
    const { id } = placeSession({ project: join(world.sandbox.root, 'elsewhere'), minutesAgo: 1 })
    const own = getSessionId()
    const { picker, exits } = await mountWithExit()
    await listed(picker, 'Local work')
    await picker.press(KEYS.ctrlA)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor('(Command copied to clipboard)')
    expect(shown).toContain(` && claudin --resume ${id}`)
    expect(exits).toEqual([])
    await Bun.sleep(250)
    expect(exits).toEqual([0])
    expect(getSessionId()).toBe(own)
  }, TIMEOUT)
})
