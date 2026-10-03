/**
 * Characterization of the mode changes that involve auto mode, as the shipped
 * build runs them: entering and leaving auto, plan mode borrowing auto, the
 * settings that let it, and where shift+tab goes when auto is on offer.
 *
 * Entering auto sets aside the allow rules that would let a command through
 * before the classifier sees it (`Bash(python:*)` below); leaving puts them
 * back. These tests watch that through the context and the session's flags.
 *
 * Needs TRANSCRIPT_CLASSIFIER on; under the plain runner the file only starts
 * a flagged child run of itself (see __testutils__/shippedFlag).
 */
import { describe, expect, test } from 'bun:test'
import { delegateToShippedBuild, shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'

if (!shipped) delegateToShippedBuild(import.meta.path)
else await defineSuite()

async function defineSuite(): Promise<void> {
  const state = await import('src/platform/bootstrap/state.js')
  const autoModeState = await import('src/permissions/autoModeState.js')
  const { cyclePermissionMode, getNextPermissionMode } = await import('src/permissions/getNextPermissionMode.js')
  const setup = await import('src/permissions/permissionSetup.js')
  const { usePermissionScene } = await import('src/permissions/permissionSetup/__testutils__/permissionScene.js')
  const { getEmptyToolPermissionContext } = await import('src/tools/Tool.js')
  type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
  type Layer = Parameters<typeof scene.write>[0]

  const scene = usePermissionScene()
  const RISKY = 'Bash(python:*)'
  const SAFE = 'Bash(git status)'

  /** A plain-mode context holding one risky and one safe allow rule. */
  const withRules = (over: Partial<Ctx> = {}): Ctx => ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { session: [SAFE, RISKY] },
    ...over,
  })
  /** The same context after auto mode set the risky rule aside. */
  const setAside = (over: Partial<Ctx> = {}): Ctx => ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { session: [SAFE] },
    strippedDangerousRules: { session: [RISKY] },
    ...over,
  })
  const optIn = () => scene.write('user', { skipAutoPermissionPrompt: true })

  type Seen = { allow: readonly string[] | undefined; aside: unknown; prePlanMode: unknown; active: boolean; exitNotice: boolean }
  const seen = (c: Ctx): Seen => ({
    allow: c.alwaysAllowRules.session,
    aside: c.strippedDangerousRules,
    prePlanMode: c.prePlanMode,
    active: autoModeState.isAutoModeActive(),
    exitNotice: state.needsAutoModeExitAttachment(),
  })
  const ENTERED = { allow: [SAFE], aside: { session: [RISKY] }, active: true, exitNotice: false }
  const LEFT = { allow: [SAFE, RISKY], aside: undefined, active: false, exitNotice: true }

  describe('entering and leaving auto', () => {
    test('entering through an open gate turns auto on and sets the risky rule aside; the mode is left to the caller', () => {
      state.setNeedsAutoModeExitAttachment(true)
      const after = setup.transitionPermissionMode('default', 'auto', withRules())
      expect(seen(after)).toEqual({ ...ENTERED, prePlanMode: undefined })
      expect(after.mode).toBe('default')
    })

    const refusals: Array<[string, () => void]> = [
      ['settings', () => scene.write('managed', { disableAutoMode: 'disable' })],
      ['a repository', () => scene.write('project', { disableAutoMode: 'disable' })],
      ['the circuit breaker', () => autoModeState.setAutoModeCircuitBroken(true)],
      ['the model', () => scene.useModel('claude-sonnet-4-5')],
    ]
    for (const [who, arrange] of refusals) {
      test(`entering is refused when ${who} closes the gate`, () => {
        arrange()
        expect(() => setup.transitionPermissionMode('acceptEdits', 'auto', withRules())).toThrow(
          'Cannot transition to auto mode: gate is not enabled',
        )
        expect(autoModeState.isAutoModeActive()).toBe(false)
      })
    }

    for (const to of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      test(`leaving for ${to} turns auto off, queues the exit notice, and restores the rule`, () => {
        autoModeState.setAutoModeActive(true)
        const after = setup.transitionPermissionMode('auto', to, setAside({ mode: 'auto' }))
        expect(seen(after)).toEqual({ ...LEFT, prePlanMode: undefined })
      })
    }

    test('leaving plan that ran with auto counts as leaving auto', () => {
      autoModeState.setAutoModeActive(true)
      const after = setup.transitionPermissionMode('plan', 'default', setAside({ mode: 'plan', prePlanMode: 'auto' }))
      expect(seen(after)).toEqual({ ...LEFT, prePlanMode: undefined })
      expect(state.hasExitedPlanModeInSession()).toBe(true)
    })

    test('plan that ran with auto goes on to auto without asking the gate again', () => {
      autoModeState.setAutoModeActive(true)
      scene.write('user', { disableAutoMode: 'disable' })
      const before = setAside({ mode: 'plan', prePlanMode: 'auto' })
      const after = setup.transitionPermissionMode('plan', 'auto', before)
      expect(after).toEqual({ ...before, prePlanMode: undefined })
      expect(autoModeState.isAutoModeActive()).toBe(true)
    })

    test('plan without auto must pass the gate to reach auto', () => {
      scene.write('user', { disableAutoMode: 'disable' })
      expect(() => setup.transitionPermissionMode('plan', 'auto', withRules({ mode: 'plan' }))).toThrow()
    })
  })

  describe('plan mode borrowing auto', () => {
    type Row = { name: string; from: Ctx['mode']; optedIn: boolean; activeBefore?: boolean; expected: Partial<Seen> }
    const rows: Row[] = [
      { name: 'from default without the opt-in: plain plan', from: 'default', optedIn: false, expected: { allow: [SAFE, RISKY], aside: undefined, prePlanMode: 'default', active: false, exitNotice: false } },
      { name: 'from default with the opt-in: plan runs with auto', from: 'default', optedIn: true, expected: { ...ENTERED, prePlanMode: 'default' } },
      { name: 'from acceptEdits with the opt-in', from: 'acceptEdits', optedIn: true, expected: { ...ENTERED, prePlanMode: 'acceptEdits' } },
      { name: 'from bypassPermissions never borrows auto', from: 'bypassPermissions', optedIn: true, expected: { allow: [SAFE, RISKY], aside: undefined, prePlanMode: 'bypassPermissions', active: false, exitNotice: false } },
    ]
    for (const row of rows) {
      test(row.name, () => {
        if (row.optedIn) optIn()
        const after = setup.prepareContextForPlanMode(withRules({ mode: row.from }))
        expect(seen(after)).toEqual(row.expected as Seen)
        expect(after.mode).toBe(row.from)
      })
    }

    test('from auto with the opt-in: auto stays on and the rule stays aside', () => {
      optIn()
      autoModeState.setAutoModeActive(true)
      const after = setup.prepareContextForPlanMode(setAside({ mode: 'auto' }))
      expect(seen(after)).toEqual({ ...ENTERED, prePlanMode: 'auto' })
    })

    test('from auto without the opt-in: auto goes off and the rule comes back', () => {
      autoModeState.setAutoModeActive(true)
      const after = setup.prepareContextForPlanMode(setAside({ mode: 'auto' }))
      expect(seen(after)).toEqual({ ...LEFT, prePlanMode: 'auto' })
    })

    test('already in plan: the same context back', () => {
      optIn()
      const inPlan = withRules({ mode: 'plan' })
      expect(setup.prepareContextForPlanMode(inPlan)).toBe(inPlan)
    })

    test('a mode change into plan goes through the same entry', () => {
      optIn()
      const after = setup.transitionPermissionMode('acceptEdits', 'plan', withRules({ mode: 'acceptEdits' }))
      expect(seen(after)).toEqual({ ...ENTERED, prePlanMode: 'acceptEdits' })
    })
  })

  describe('who can let plan mode borrow auto', () => {
    type Row = { name: string; files: Partial<Record<Layer, Record<string, unknown>>>; model?: string; borrows: boolean }
    const yes = { skipAutoPermissionPrompt: true }
    const no = { useAutoModeDuringPlan: false }
    const rows: Row[] = [
      { name: 'nobody opted in', files: {}, borrows: false },
      { name: 'the user opted in', files: { user: yes }, borrows: true },
      { name: 'local settings opted in', files: { local: yes }, borrows: true },
      { name: 'the --settings file opted in', files: { flag: yes }, borrows: true },
      { name: 'managed settings opted in', files: { managed: yes }, borrows: true },
      { name: 'a repository cannot opt in', files: { project: yes }, borrows: false },
      { name: 'the user turned it off for plan', files: { user: { ...yes, ...no } }, borrows: false },
      { name: 'local settings turned it off', files: { user: yes, local: no }, borrows: false },
      { name: 'the --settings file turned it off', files: { user: yes, flag: no }, borrows: false },
      { name: 'managed settings turned it off', files: { user: yes, managed: no }, borrows: false },
      { name: 'a repository cannot turn it off', files: { user: yes, project: no }, borrows: true },
      { name: 'a closed gate', files: { user: yes }, model: 'claude-sonnet-4-5', borrows: false },
    ]
    for (const row of rows) {
      test(row.name, () => {
        for (const [layer, json] of Object.entries(row.files)) scene.write(layer as Layer, json)
        if (row.model) scene.useModel(row.model)
        expect(setup.shouldPlanUseAutoMode()).toBe(row.borrows)
      })
    }
  })

  describe('plan mode catching up with a settings change', () => {
    test('outside plan, or after entering plan from bypass, nothing changes', () => {
      optIn()
      for (const ctx of [withRules({ mode: 'default' }), withRules({ mode: 'plan', prePlanMode: 'bypassPermissions' })]) {
        expect(setup.transitionPlanAutoMode(ctx)).toBe(ctx)
      }
      expect(autoModeState.isAutoModeActive()).toBe(false)
    })

    test('not wanted and not on: nothing changes', () => {
      const ctx = withRules({ mode: 'plan', prePlanMode: 'default' })
      expect(setup.transitionPlanAutoMode(ctx)).toBe(ctx)
    })

    test('wanted and not on: auto goes on and the rule goes aside', () => {
      optIn()
      state.setNeedsAutoModeExitAttachment(true)
      const after = setup.transitionPlanAutoMode(withRules({ mode: 'plan', prePlanMode: 'default' }))
      expect(seen(after)).toEqual({ ...ENTERED, prePlanMode: 'default' })
    })

    test('on and no longer wanted: auto goes off and the rule comes back', () => {
      autoModeState.setAutoModeActive(true)
      const after = setup.transitionPlanAutoMode(setAside({ mode: 'plan', prePlanMode: 'default' }))
      expect(seen(after)).toEqual({ ...LEFT, prePlanMode: 'default' })
    })

    test('on and still wanted: a risky rule reloaded from disk is set aside again', () => {
      optIn()
      autoModeState.setAutoModeActive(true)
      const reloaded = setAside({ mode: 'plan', prePlanMode: 'default', alwaysAllowRules: { session: [SAFE, RISKY] } })
      const after = setup.transitionPlanAutoMode(reloaded)
      expect(after.alwaysAllowRules.session).toEqual([SAFE])
      expect(after.strippedDangerousRules).toEqual({ session: [RISKY] })
      expect(autoModeState.isAutoModeActive()).toBe(true)
    })
  })

  describe('shift+tab when auto is on offer', () => {
    type Row = { from: Ctx['mode']; bypass: boolean; offered: boolean; closed?: () => void; to: Ctx['mode'] }
    const rows: Row[] = [
      { from: 'plan', bypass: false, offered: true, to: 'auto' },
      { from: 'plan', bypass: true, offered: true, to: 'bypassPermissions' },
      { from: 'bypassPermissions', bypass: true, offered: true, to: 'auto' },
      { from: 'plan', bypass: false, offered: false, to: 'default' },
      { from: 'bypassPermissions', bypass: true, offered: false, to: 'default' },
      { from: 'plan', bypass: false, offered: true, closed: () => scene.write('local', { disableAutoMode: 'disable' }), to: 'default' },
      { from: 'bypassPermissions', bypass: true, offered: true, closed: () => autoModeState.setAutoModeCircuitBroken(true), to: 'default' },
      { from: 'plan', bypass: false, offered: true, closed: () => scene.useModel('claude-sonnet-4-5'), to: 'default' },
      { from: 'default', bypass: false, offered: true, to: 'acceptEdits' },
      { from: 'acceptEdits', bypass: true, offered: true, to: 'plan' },
      { from: 'auto', bypass: true, offered: true, to: 'default' },
    ]
    for (const row of rows) {
      const label = `${row.from}${row.bypass ? ' +bypass' : ''}${row.offered ? ' +auto offered' : ''}${row.closed ? ' (gate closed since)' : ''} -> ${row.to}`
      test(label, () => {
        row.closed?.()
        const ctx = { ...getEmptyToolPermissionContext(), mode: row.from, isBypassPermissionsModeAvailable: row.bypass, isAutoModeAvailable: row.offered }
        expect(getNextPermissionMode(ctx)).toBe(row.to)
      })
    }

    test('cycling from bypass into auto prepares the context for auto', () => {
      const from = withRules({ mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true, isAutoModeAvailable: true })
      const { nextMode, context } = cyclePermissionMode(from)
      expect(nextMode).toBe('auto')
      expect(seen(context)).toEqual({ ...ENTERED, prePlanMode: undefined })
    })

    test('cycling from auto back to default restores what auto set aside', () => {
      autoModeState.setAutoModeActive(true)
      const { nextMode, context } = cyclePermissionMode(setAside({ mode: 'auto', isAutoModeAvailable: true }))
      expect(nextMode).toBe('default')
      expect(seen(context)).toEqual({ ...LEFT, prePlanMode: undefined })
    })
  })
}
