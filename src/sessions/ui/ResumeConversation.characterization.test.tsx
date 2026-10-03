/**
 * Characterization of the startup session picker, `ResumeConversation`,
 * written before its clean-base rewrite: the new code has to pass it
 * unchanged.
 *
 * `claudin --resume` with no id mounts it inside the app shell. It lists the
 * sessions recorded for the project (or for every project after Ctrl+A),
 * and on a choice either opens the REPL on that conversation, or, for a
 * session of another directory, prints the command that resumes it there and
 * ends the process.
 *
 * Every test gets a temp config dir and project (`useResumeWorld`). Sessions
 * are copies of a transcript the real writer produced; keys go in as raw
 * bytes; what the user sees is read off the fake terminal, and what the
 * process took over (its session, its cost, its directory) is read back from
 * the session state.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  getTotalCostUSD,
} from 'src/platform/bootstrap/state.js'
import { agent, definitions, repositoryWithWorktree, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import { getProject } from 'src/sessions/sessionStorage.js'
import {
  FIXTURE_PROJECT,
  FIXTURE_TITLE,
  KEYS,
  listed,
  mountPicker,
  placeSession,
  useResumeWorld,
} from 'src/sessions/ui/__testutils__/resumeRig.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const TIMEOUT = 30_000
const world = useResumeWorld()

/** The REPL is up once its prompt is drawn. */
const replOpen = (screen: string) => screen.includes('? for shortcuts')
const CONVERSATION = ['Let us fix the parser.', 'On it.', 'That is all for now.']

describe('the list', () => {
  test('says it is loading, then that there is nothing to resume; Ctrl+C ends the process with 1', async () => {
    const picker = await mountPicker(world)
    const shown = await picker.waitFor('No conversations found to resume.')
    expect(picker.painted()).toContain('Loading conversations…')
    expect(shown).toContain('Press Ctrl+C to exit and start a new conversation.')
    await Bun.sleep(150)
    expect(world.exits()).toEqual([])
    await picker.press(KEYS.ctrlC)
    expect(world.exits()).toEqual([1])
  }, TIMEOUT)

  test("lists this project's sessions newest first, and never a sidechain", async () => {
    const project = world.sandbox.projectDir
    placeSession({ project, title: 'Older work', minutesAgo: 90 })
    placeSession({ project, title: 'Newer work', minutesAgo: 5 })
    placeSession({ project, title: 'Side work', minutesAgo: 1, sidechain: true })
    const picker = await mountPicker(world)
    const shown = await listed(picker, 'Older work')
    expect(shown).toContain('Sessions (1 of 2)')
    expect(shown.indexOf('Newer work')).toBeLessThan(shown.indexOf('Older work'))
    expect(shown).not.toContain('Side work')
  }, TIMEOUT)

  test('Ctrl+A widens the list to every project and back, reloading each time', async () => {
    const elsewhere = join(world.sandbox.root, 'elsewhere')
    placeSession({ project: world.sandbox.projectDir, title: 'Here' })
    placeSession({ project: elsewhere, title: 'Over there' })
    const picker = await mountPicker(world)
    const here = await listed(picker, 'Here')
    expect(here).not.toContain('Over there')
    expect(here).toContain('Ctrl+A all projects')

    await picker.press(KEYS.ctrlA)
    const everywhere = await picker.waitFor('Over there')
    expect(everywhere).toContain('Sessions (1 of 2) · all projects')
    expect(everywhere).toContain('Ctrl+A this project')

    placeSession({ project: world.sandbox.projectDir, title: 'Written meanwhile', minutesAgo: 1 })
    await picker.press(KEYS.ctrlA)
    const back = await picker.waitFor('Written meanwhile')
    expect(back).not.toContain('Over there')
    expect(back).toContain('Sessions (1 of 2)')
  }, TIMEOUT)

  test('lists the sessions of every worktree path it is given', async () => {
    const sibling = join(world.sandbox.root, 'sibling-worktree')
    mkdirSync(sibling)
    placeSession({ project: world.sandbox.projectDir, title: 'Main checkout work' })
    placeSession({ project: sibling, title: 'Sibling worktree work' })
    const picker = await mountPicker(world, { worktreePaths: [world.sandbox.projectDir, sibling] })
    const shown = await listed(picker, 'Sibling worktree work')
    expect(shown).toContain('Main checkout work')
  }, TIMEOUT)

  const prFilters: Array<{ name: string; filterByPr: boolean | number | string; shown: string[] }> = [
    { name: 'true: only sessions linked to a PR', filterByPr: true, shown: ['PR seventeen', 'PR forty-two'] },
    { name: 'a number', filterByPr: 42, shown: ['PR forty-two'] },
    { name: 'a number as text', filterByPr: '17', shown: ['PR seventeen'] },
    { name: 'a pull request URL', filterByPr: 'https://github.com/acme/app/pull/42', shown: ['PR forty-two'] },
    { name: 'text that names no PR: no filter', filterByPr: 'release notes', shown: ['PR seventeen', 'PR forty-two', 'No PR'] },
    { name: 'a negative number as text: no filter', filterByPr: '-17', shown: ['PR seventeen', 'PR forty-two', 'No PR'] },
    { name: 'a PR no session links to', filterByPr: 99, shown: [] },
  ]
  for (const { name, filterByPr, shown } of prFilters) {
    test(`filterByPr ${name}`, async () => {
      const project = world.sandbox.projectDir
      placeSession({ project, title: 'PR seventeen', pr: 17, minutesAgo: 30 })
      placeSession({ project, title: 'PR forty-two', pr: 42, minutesAgo: 20 })
      placeSession({ project, title: 'No PR', pr: null, minutesAgo: 10 })
      const picker = await mountPicker(world, { filterByPr })
      const screen =
        shown.length === 0
          ? await picker.waitFor('No conversations found to resume.')
          : await listed(picker, `Sessions (1 of ${shown.length})`)
      for (const title of ['PR seventeen', 'PR forty-two', 'No PR']) {
        expect({ title, listed: screen.includes(title) }).toEqual({ title, listed: shown.includes(title) })
      }
    }, TIMEOUT)
  }

  test('initialSearchQuery starts the list filtered', async () => {
    placeSession({ project: world.sandbox.projectDir, title: 'Lexer cleanup' })
    placeSession({ project: world.sandbox.projectDir, title: 'Parser rewrite' })
    const picker = await mountPicker(world, { initialSearchQuery: 'Lexer' })
    const shown = await listed(picker, 'Lexer cleanup')
    expect(shown).not.toContain('Parser rewrite')
  }, TIMEOUT)

  test('Esc ends the process with 1 and resumes nothing', async () => {
    placeSession({ project: world.sandbox.projectDir })
    const before = getSessionId()
    const picker = await mountPicker(world)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.escape)
    expect(world.exits()).toEqual([1])
    expect(getSessionId()).toBe(before)
  }, TIMEOUT)

  test('a rename is saved to the transcript and the list is read again', async () => {
    const { transcript } = placeSession({ project: world.sandbox.projectDir })
    const picker = await mountPicker(world)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.ctrlR)
    await picker.waitFor('Rename:')
    await picker.type('Lexer cleanup')
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor('Lexer cleanup')
    expect(shown).not.toContain(FIXTURE_TITLE)
    expect(readFileSync(transcript, 'utf8')).toContain('"customTitle":"Lexer cleanup"')
  }, TIMEOUT)

  test('lists the newest 50 first and reads the rest as the focus nears the end', async () => {
    const project = world.sandbox.projectDir
    for (let n = 1; n <= 56; n++) {
      placeSession({ project, title: `Session ${String(n).padStart(2, '0')}`, minutesAgo: n })
    }
    const picker = await mountPicker(world)
    const first = await listed(picker, 'Session 01')
    expect(first).toContain('(1 of 50)')
    for (let step = 0; step < 40; step++) await picker.press(KEYS.down)
    const later = await picker.waitFor('of 56)')
    expect(later).toContain('(41 of 56)')
    for (let step = 0; step < 15; step++) await picker.press(KEYS.down)
    expect(await picker.waitFor('Session 56')).toContain('(56 of 56)')
  }, 60_000)
})

describe('choosing a session', () => {
  test('Enter opens the REPL on its conversation, and the process takes the session over', async () => {
    const { id, transcript } = placeSession({ project: world.sandbox.projectDir })
    const picker = await mountPicker(world)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor(replOpen)
    for (const line of CONVERSATION) expect(shown).toContain(line)
    expect(String(getSessionId())).toBe(id)
    expect(getSessionProjectDir()).toBe(dirname(transcript))
    expect(getProject().sessionFile).toBe(transcript)
    expect(getProject().currentSessionTitle).toBe(FIXTURE_TITLE)
    expect(getProject().currentSessionPrNumber).toBe(17)
    expect(picker.state().standaloneAgentContext).toEqual({ name: 'reviewer', color: 'blue' })
    expect(world.exits()).toEqual([])
  }, TIMEOUT)

  test('forkSession opens the conversation but keeps the process on a session of its own', async () => {
    const { id, transcript } = placeSession({ project: world.sandbox.projectDir })
    const own = getSessionId()
    const picker = await mountPicker(world, { forkSession: true })
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor(replOpen)
    for (const line of CONVERSATION) expect(shown).toContain(line)
    expect(getSessionId()).toBe(own)
    expect(getSessionId()).not.toBe(id)
    expect(getProject().sessionFile ?? null).not.toBe(transcript)
    expect(getProject().currentSessionTitle).toBe(FIXTURE_TITLE)
    expect(picker.state().standaloneAgentContext).toEqual({ name: 'reviewer', color: 'blue' })
  }, TIMEOUT)

  const takeovers = [
    { name: 'resumed', forkSession: false, cost: 0.42, cwd: 'worktree' as const },
    { name: 'forked', forkSession: true, cost: 0, cwd: 'project' as const },
  ]
  for (const { name, forkSession, cost, cwd } of takeovers) {
    test(`${name}: the cost so far and the worktree are taken over only on a real resume`, async () => {
      const { worktree, session } = repositoryWithWorktree(world.sandbox.root)
      await writeSession({ title: 'Costly work', costUSD: 0.42, worktree: session })
      const picker = await mountPicker(world, { forkSession })
      await listed(picker, 'Costly work')
      await picker.press(KEYS.enter)
      await picker.waitFor(replOpen)
      expect(getTotalCostUSD()).toBeCloseTo(cost, 6)
      expect(process.cwd()).toBe(cwd === 'worktree' ? worktree : world.sandbox.projectDir)
      expect(getProject().currentSessionWorktree ?? undefined).toEqual(forkSession ? undefined : session)
    }, TIMEOUT)
  }

  const agents = [
    { name: 'an agent that is still defined is restored', defined: true, expected: 'helper' },
    { name: 'an agent no longer defined is dropped', defined: false, expected: undefined },
  ]
  for (const { name, defined, expected } of agents) {
    test(name, async () => {
      await writeSession({ title: 'Agent work', agentSetting: 'helper' })
      const initialState = {
        ...getDefaultAppState(),
        agentDefinitions: definitions(defined ? [agent('helper')] : []),
      }
      const picker = await mountPicker(world, {}, { initialState })
      await listed(picker, 'Agent work')
      await picker.press(KEYS.enter)
      await picker.waitFor(replOpen)
      expect(picker.state().agent).toBe(expected)
    }, TIMEOUT)
  }

  test('a session with no agent name or colour sets no agent context', async () => {
    await writeSession({ title: 'Plain work' })
    const picker = await mountPicker(world)
    await listed(picker, 'Plain work')
    await picker.press(KEYS.enter)
    await picker.waitFor(replOpen)
    expect(picker.state().standaloneAgentContext).toBeUndefined()
  }, TIMEOUT)

  test('a session that fails to load shows why, and the list stays usable', async () => {
    const project = world.sandbox.projectDir
    placeSession({ project, title: 'Oversized work', minutesAgo: 1, reply: 'x'.repeat(9 * 1024 * 1024) })
    const healthy = placeSession({ project, title: 'Healthy work', minutesAgo: 60 })
    const own = getSessionId()
    const picker = await mountPicker(world)
    await listed(picker, 'Oversized work')
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor('Failed to resume conversation.', 20_000)
    expect(picker.painted()).toContain('Resuming conversation…')
    expect(shown).toContain('too large to resume')
    expect(shown).toContain('Choose a different conversation to continue.')
    expect(shown).toContain('Healthy work')
    expect(getSessionId()).toBe(own)

    await Bun.sleep(150)
    await picker.press(KEYS.down, KEYS.enter)
    await picker.waitFor(replOpen, 20_000)
    expect(String(getSessionId())).toBe(healthy.id)
    expect(world.exits()).toEqual([])
  }, 60_000)

  test('a session of another directory is not resumed: the command to resume it there is shown, copied, and the process ends with 0', async () => {
    placeSession({ project: world.sandbox.projectDir, title: 'Local work', minutesAgo: 60 })
    const { id } = placeSession({ project: join(world.sandbox.root, 'elsewhere'), minutesAgo: 1 })
    const own = getSessionId()
    const picker = await mountPicker(world)
    await listed(picker, 'Local work')
    await picker.press(KEYS.ctrlA)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.enter)
    const shown = await picker.waitFor('(Command copied to clipboard)')
    const lines = shown.split('\n').map(line => line.trimEnd())
    expect(lines).toContain('This conversation is from a different directory.')
    expect(lines).toContain('To resume, run:')
    const command = lines.find(line => line.startsWith(' cd '))!.slice(1)
    expect(command.startsWith(`cd ${FIXTURE_PROJECT} && `)).toBe(true)
    expect(command.endsWith(` --resume ${id}`)).toBe(true)
    expect(world.stdout()).toBe(`\x1b]52;c;${Buffer.from(command).toString('base64')}\x07`)
    await Bun.sleep(250)
    expect(world.exits()).toEqual([0])
    expect(getSessionId()).toBe(own)
  }, TIMEOUT)

  test('with every project listed, a session of this directory still resumes in place', async () => {
    const { id } = await writeSession({ title: 'Local work' })
    const picker = await mountPicker(world)
    await listed(picker, 'Local work')
    await picker.press(KEYS.ctrlA)
    await listed(picker, 'all projects')
    await picker.press(KEYS.enter)
    await picker.waitFor(replOpen)
    expect(String(getSessionId())).toBe(id)
    expect(world.exits()).toEqual([])
  }, TIMEOUT)

  test('Ctrl+V previews the focused session; Enter there resumes it', async () => {
    const { id } = placeSession({ project: world.sandbox.projectDir })
    const picker = await mountPicker(world)
    await listed(picker, FIXTURE_TITLE)
    await picker.press(KEYS.ctrlV)
    await picker.waitFor('3 messages')
    await Bun.sleep(100)
    await picker.press(KEYS.enter)
    await picker.waitFor(replOpen)
    expect(String(getSessionId())).toBe(id)
  }, TIMEOUT)
})
