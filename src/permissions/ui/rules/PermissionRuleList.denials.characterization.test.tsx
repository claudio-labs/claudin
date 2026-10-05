/**
 * permissions/ruleList, the part that needs auto-mode denials: what
 * /permissions does when the classifier has denied something this session.
 *
 * Denials are only recorded in a build with TRANSCRIPT_CLASSIFIER, the
 * shipped build. Under the plain runner this file registers one test, which
 * runs it again in a child `bun test --feature=TRANSCRIPT_CLASSIFIER`.
 *
 * The denial list is process-wide and has no reset, so the two denials are
 * recorded once, before the first test, and every test sees both.
 */
import { describe, expect, test } from 'bun:test'
import { delegateToShippedBuild, shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'

if (!shipped) {
  delegateToShippedBuild(import.meta.path)
} else {
  await denialSuite()
}

async function denialSuite(): Promise<void> {
  const { recordAutoModeDenial } = await import('src/permissions/autoModeDenials.js')
  const { isolatedWorld, KEYS, SLOW, withTruecolor } = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
  const rig = await import('src/permissions/ui/__testutils__/ruleListRig.js')

  const world = isolatedWorld()
  withTruecolor()
  const BOLD = (text: string) => `\u001B[1m${text}\u001B[22m`

  // Newest first on screen: the second one recorded is listed on top.
  recordAutoModeDenial({ toolName: 'Bash', display: 'npm publish', reason: 'publishes a package', timestamp: 1 })
  recordAutoModeDenial({ toolName: 'Bash', display: 'rm -rf build', reason: 'deletes files', timestamp: 2 })

  const GRANTED_ONE = 'Permission granted for: rm -rf build. You may now retry this command if you would like.'

  describe('with denials this session', () => {
    test('opens on Recently denied, in the list, newest first, with its own footer', async () => {
      world()
      const { screen } = await rig.openRules(rig.sessionHolding({ allow: { userSettings: ['Read'] } }))
      const frame = screen.text()
      expect(frame).toContain('Commands recently denied by the auto mode classifier.')
      const rows = rig.listed(frame)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toContain('rm -rf build')
      expect(rows[1]).toContain('npm publish')
      expect(frame).toContain('Enter approve · r retry · ↑↓ navigate · ←/→ switch · Esc cancel')
      expect(frame).not.toContain('Add a new rule')
    }, SLOW)

    test('Esc with nothing marked is a plain dismissal, and nothing is retried', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press(KEYS.esc)
      expect(opened.exits).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
      expect(opened.retries).toEqual([])
    }, SLOW)

    test('Enter approves a denial: reported in bold, nothing retried, no rule saved', async () => {
      const w = world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press(KEYS.enter)
      await opened.screen.press(KEYS.esc)
      expect(opened.exits).toEqual([{ result: `Approved ${BOLD('rm -rf build')}`, options: undefined }])
      expect(opened.retries).toEqual([])
      expect(rig.heldNow(opened.screen, 'allow')).toEqual({})
      for (const file of ['userSettings', 'projectSettings', 'localSettings'] as const) expect(rig.readSettings(w, file)).toBeUndefined()
    }, SLOW)

    test('two approvals are listed on one line, comma-separated', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press(KEYS.enter, KEYS.down, KEYS.enter, KEYS.esc)
      expect(rig.plainExits(opened.exits)).toEqual([{ result: 'Approved rm -rf build, npm publish', options: undefined }])
    }, SLOW)

    test('Enter twice takes the approval back', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press(KEYS.enter, KEYS.enter, KEYS.esc)
      expect(rig.plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
    }, SLOW)

    test('r marks a denial for retry: the caller gets the command and the model is asked to go on', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press('r')
      expect(opened.screen.text()).toContain('rm -rf build (retry)')
      expect(opened.screen.text()).not.toContain('Type to filter')
      await opened.screen.press(KEYS.esc)
      expect(opened.retries).toEqual([['rm -rf build']])
      expect(opened.exits).toEqual([{ result: undefined, options: { shouldQuery: true, metaMessages: [GRANTED_ONE] } }])
    }, SLOW)

    test('two retries: both commands, in one message that speaks of "these commands"', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press('r', KEYS.down, 'r', KEYS.esc)
      expect(opened.retries).toEqual([['rm -rf build', 'npm publish']])
      const [exit] = opened.exits
      const meta = (exit!.options as { metaMessages: string[] }).metaMessages
      expect(meta).toHaveLength(1)
      expect(meta[0]).toContain('rm -rf build, npm publish')
      expect(meta[0]).toContain('these commands')
      expect(meta[0]).not.toContain('this command ')
      expect(exit!.options).toMatchObject({ shouldQuery: true })
    }, SLOW)

    test('r twice takes the retry back but leaves the denial approved', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}))
      await opened.screen.press('r', 'r', KEYS.esc)
      expect(opened.retries).toEqual([])
      expect(rig.plainExits(opened.exits)).toEqual([{ result: 'Approved rm -rf build', options: undefined }])
    }, SLOW)

    test('a retry without a retry handler still asks the model to go on', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({}), { noRetryHandler: true })
      await opened.screen.press('r', KEYS.esc)
      expect(opened.exits).toEqual([{ result: undefined, options: { shouldQuery: true, metaMessages: [GRANTED_ONE] } }])
    }, SLOW)

    test('a mark survives a look at another tab', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({ allow: { session: ['Read'] } }))
      await opened.screen.press('r', rig.MOVE.right)
      await opened.screen.until(frame => frame.includes("Claudin won't ask before using allowed tools."), 'the allow tab')
      await opened.screen.press(KEYS.esc)
      expect(opened.retries).toEqual([['rm -rf build']])
      expect(opened.exits).toEqual([{ result: undefined, options: { shouldQuery: true, metaMessages: [GRANTED_ONE] } }])
    }, SLOW)

    test('an approval made after a delete is reported first, the delete after it', async () => {
      world()
      const opened = await rig.openRules(rig.sessionHolding({ allow: { session: ['Read'] } }))
      await opened.screen.press(rig.MOVE.right)
      await opened.screen.until(frame => frame.includes("Claudin won't ask before using allowed tools."), 'the allow tab')
      await opened.screen.press(KEYS.down, KEYS.down, KEYS.enter)
      await opened.screen.until(frame => frame.includes('Delete allowed tool?'), 'the details')
      await opened.screen.press(KEYS.enter)
      // Back on the tab the screen opened on, Recently denied, with its list focused.
      await opened.screen.until(frame => frame.includes('Commands recently denied'), 'the denials')
      await opened.screen.press(KEYS.enter, KEYS.esc)
      expect(rig.plainExits(opened.exits)).toEqual([{ result: 'Approved rm -rf build\nDeleted allow rule Read', options: undefined }])
      expect(opened.retries).toEqual([])
    }, SLOW)

    test('initialTab still wins, and then the list has focus from the start', async () => {
      world()
      const { screen } = await rig.openRules(rig.sessionHolding({ deny: { userSettings: ['Write'] } }), { initialTab: 'deny' })
      const frame = screen.text()
      expect(frame).toContain('Claudin will always reject requests to use denied tools.')
      expect(rig.focused(frame)).toBe('Add a new rule…')
      expect(frame).toContain('↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel')
    }, SLOW)
  })
}
