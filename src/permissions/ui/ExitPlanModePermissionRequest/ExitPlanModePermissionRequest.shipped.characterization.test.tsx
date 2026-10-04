/**
 * The auto-mode half of ExitPlanModePermissionRequest, which only exists with
 * TRANSCRIPT_CLASSIFIER on, as the shipped build has it: the auto answers,
 * the auto-mode gate checked at the moment of the answer, and what happens to
 * auto mode when it was running during the plan. Written before the
 * clean-base rewrite of permissions/modeDialogs; the spec is
 * docs/tech/rewrite/permissions/modeDialogs.md.
 *
 * `bun test` folds every flag to false, so under the plain runner this file
 * registers one test that runs it again in a child `bun test` with the flag
 * on, and fails with the child's report when anything there fails.
 *
 * The gate is real: the session model (claude-sonnet-4-6 is cleared for auto
 * by name) and `disableAutoMode` in the user's settings file open and close
 * it. The small-model request that names the session is the one boundary
 * replaced.
 */
import { delegateToShippedBuild, shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'

if (!shipped) {
  delegateToShippedBuild(import.meta.path)
} else {
  await shippedSuite()
}

async function shippedSuite(): Promise<void> {
  const { afterAll, beforeAll, beforeEach, describe, expect, mock, test } = await import('bun:test')
  const { writeFileSync } = await import('fs')
  const { join } = await import('path')
  const React = await import('react')

  const realShim = { ...(await import('src/providers/shims/claude.js')) }
  mock.module('src/providers/shims/claude.js', () => ({
    ...realShim,
    queryHaiku: async () => ({ message: { content: [{ type: 'text', text: '{"name":"shipped-plan"}' }] } }),
  }))

  const { ExitPlanModePermissionRequest, buildPlanApprovalOptions } = await import(
    'src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
  )
  const autoMode = await import('src/permissions/autoModeState.js')
  const { isAutoModeGateEnabled } = await import('src/permissions/permissionSetup.js')
  const rig = await import('src/permissions/ui/__testutils__/modeDialogsRig.js')
  const frame = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
  const { setMainLoopModelOverride } = await import('src/platform/bootstrap/state.js')
  const { resetSettingsCache } = await import('src/platform/settings/settingsCache.js')
  const { getDefaultAppState } = await import('src/terminal/state/AppStateStore.js')
  type Ledger = import('src/permissions/ui/__testutils__/modeDialogsRig.js').Ledger
  type Context = ReturnType<typeof getDefaultAppState>['toolPermissionContext']

  const { KEYS, SLOW, flat } = frame
  const SHIFT_TAB = '\x1B[Z'
  const world = frame.isolatedWorld()

  beforeAll(() => setMainLoopModelOverride('claude-sonnet-4-6'))
  afterAll(() => {
    setMainLoopModelOverride(undefined)
    mock.module('src/providers/shims/claude.js', () => realShim)
  })
  beforeEach(() => {
    rig.lowerSessionFlags()
    autoMode._resetForTesting()
  })

  const PLAN = '# Rollout\n\n1. migrate the table'
  const setMode = (mode: string) => [{ type: 'setMode', mode, destination: 'session' }]
  const closeGate = () => {
    writeFileSync(join(world().config, 'settings.json'), JSON.stringify({ disableAutoMode: 'disable' }))
    resetSettingsCache()
  }

  type Setup = {
    plan?: string | null
    clear?: boolean
    bypass?: boolean
    auto?: boolean
    /** Auto mode was running during the plan, with `Bash(*)` set aside. */
    autoDuringPlan?: boolean
  }

  /** A plan-mode context; `Bash(*)` is a rule auto mode sets aside. */
  function contextFor(setup: Setup): Context {
    const base = getDefaultAppState().toolPermissionContext
    const during = setup.autoDuringPlan
    return {
      ...base,
      mode: 'plan',
      prePlanMode: during ? 'auto' : 'default',
      isBypassPermissionsModeAvailable: setup.bypass ?? false,
      isAutoModeAvailable: setup.auto ?? true,
      alwaysAllowRules: { ...base.alwaysAllowRules, session: during ? ['Read'] : ['Read', 'Bash(*)'] },
      ...(during ? { strippedDangerousRules: { session: ['Bash(*)'] } } : {}),
    } as Context
  }

  async function open(setup: Setup = {}) {
    if (setup.plan !== null) rig.writePlan(setup.plan ?? PLAN)
    if (setup.autoDuringPlan) autoMode.setAutoModeActive(true)
    const ledger: Ledger = []
    const confirm = rig.planRequest(ledger)
    const base = getDefaultAppState()
    const screen = await frame.mount(<ExitPlanModePermissionRequest {...rig.callerProps(ledger, confirm)} />, {
      columns: 120,
      appState: {
        settings: { ...base.settings, showClearContextOnPlanAccept: setup.clear ?? false },
        toolPermissionContext: contextFor(setup),
      },
    })
    return { screen, ledger, context: () => screen.state().toolPermissionContext }
  }

  const answers = (text: string) => [...text.matchAll(/^\s*(?:❯| ) \d+\. (.+?)\s*$/gm)].map(m => m[1]!)
  const allowed = (updates: unknown, feedback?: string): Ledger => [
    { to: 'caller', call: 'done' },
    { to: 'request', call: 'allow', input: {}, updates, feedback },
  ]
  const cleared: Ledger = [
    { to: 'caller', call: 'done' },
    { to: 'caller', call: 'reject' },
    { to: 'request', call: 'reject', args: [] },
  ]

  describe('shipped: the auto answers', () => {
    test('buildPlanApprovalOptions puts auto first in both slots, ahead of bypass', () => {
      const options = buildPlanApprovalOptions({
        showClearContext: true,
        usedPercent: 7,
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: true,
        onFeedbackChange: () => {},
      })
      expect(options.map(o => [o.label, o.value])).toEqual([
        ['Yes, clear context (7% used) and use auto mode', 'yes-auto-clear-context'],
        ['Yes, and use auto mode', 'yes-resume-auto-mode'],
        ['Yes, manually approve edits', 'yes-default-keep-context'],
        ['No, keep planning', 'no'],
      ])
    })

    const layouts: Array<{ setup: Setup; first: string[] }> = [
      { setup: {}, first: ['Yes, and use auto mode', 'Yes, manually approve edits'] },
      { setup: { bypass: true }, first: ['Yes, and use auto mode', 'Yes, manually approve edits'] },
      { setup: { clear: true }, first: ['Yes, clear context (0% used) and use auto mode', 'Yes, and use auto mode'] },
      { setup: { auto: false, bypass: true }, first: ['Yes, and bypass permissions', 'Yes, manually approve edits'] },
      { setup: { auto: false }, first: ['Yes, auto-accept edits', 'Yes, manually approve edits'] },
    ]
    for (const { setup, first } of layouts) {
      test(
        `${JSON.stringify(setup)}: starts with ${first.join(' / ')}`,
        async () => {
          const { screen } = await open(setup)
          expect(answers(screen.text()).slice(0, 2)).toEqual(first)
        },
        SLOW,
      )
    }
  })

  describe('shipped: "Yes, and use auto mode"', () => {
    test(
      'gate open: the session goes to auto now, with risky allow rules set aside, and the request gets no mode update',
      async () => {
        const { screen, ledger, context } = await open()
        expect(isAutoModeGateEnabled()).toBe(true)
        await screen.press(...'3', ...'  keep it small ', KEYS.up, KEYS.up, KEYS.enter)
        expect(ledger).toEqual(allowed([], 'keep it small'))
        expect(context().mode).toBe('auto')
        expect(context().prePlanMode).toBeUndefined()
        expect(context().alwaysAllowRules.session).toEqual(['Read'])
        expect(context().strippedDangerousRules).toEqual({ session: ['Bash(*)'] })
        expect(autoMode.isAutoModeActive()).toBe(true)
        expect(rig.sessionFlags()).toEqual({ exitedPlan: true, planExitNotice: true, autoExitNotice: false })
      },
      SLOW,
    )

    test(
      'gate closed after the dialog opened: falls back to the default mode through the request',
      async () => {
        const { screen, ledger, context } = await open()
        closeGate()
        await screen.press('1')
        expect(ledger).toEqual(allowed(setMode('default')))
        expect(context().mode).toBe('plan')
        expect(context().alwaysAllowRules.session).toEqual(['Read', 'Bash(*)'])
        expect(autoMode.isAutoModeActive()).toBe(false)
        expect(rig.sessionFlags()).toEqual({ exitedPlan: true, planExitNotice: true, autoExitNotice: false })
      },
      SLOW,
    )
  })

  describe('shipped: "Yes, clear context and use auto mode"', () => {
    const cases: Array<{ gate: 'open' | 'closed'; mode: string; active: boolean }> = [
      { gate: 'open', mode: 'auto', active: true },
      { gate: 'closed', mode: 'default', active: false },
    ]
    for (const c of cases) {
      test(
        `gate ${c.gate}: the plan becomes the next message, to run in ${c.mode}`,
        async () => {
          const { screen, ledger, context } = await open({ clear: true })
          if (c.gate === 'closed') closeGate()
          await screen.press('1')
          expect(ledger).toEqual(cleared)
          const next = screen.state().initialMessage!
          expect(next.clearContext).toBe(true)
          expect(next.mode).toBe(c.mode as never)
          expect(autoMode.isAutoModeActive()).toBe(c.active)
          // The context itself is left for the REPL to prepare when it sends the message.
          expect(context().mode).toBe('plan')
          expect(context().alwaysAllowRules.session).toEqual(['Read', 'Bash(*)'])
          expect(rig.sessionFlags()).toEqual({ exitedPlan: true, planExitNotice: false, autoExitNotice: false })
        },
        SLOW,
      )
    }
  })

  describe('shipped: leaving a plan that ran with auto mode', () => {
    type Case = { what: string; setup: Setup; keys: string[]; gate?: 'closed'; ledger: Ledger; mode?: string }
    const left: Case[] = [
      { what: 'manual approval', setup: {}, keys: ['2'], ledger: allowed(setMode('default')) },
      { what: 'shift+tab', setup: {}, keys: [SHIFT_TAB], ledger: allowed(setMode('acceptEdits')) },
      { what: 'shift+tab with bypass offered', setup: { bypass: true }, keys: [SHIFT_TAB], ledger: allowed(setMode('bypassPermissions')) },
      { what: '"use auto mode" once the gate has closed', setup: {}, keys: ['1'], gate: 'closed', ledger: allowed(setMode('default')) },
      { what: 'clearing context into accept-edits', setup: { auto: false, clear: true }, keys: ['1'], ledger: cleared, mode: 'acceptEdits' },
    ]
    for (const c of left) {
      test(
        `${c.what}: auto mode stops, its rules come back, and the auto-exit notice is raised`,
        async () => {
          const { screen, ledger, context } = await open({ ...c.setup, autoDuringPlan: true })
          if (c.gate) closeGate()
          await screen.press(...c.keys)
          expect(ledger).toEqual(c.ledger)
          expect(autoMode.isAutoModeActive()).toBe(false)
          expect(context().alwaysAllowRules.session).toEqual(['Read', 'Bash(*)'])
          expect(context().strippedDangerousRules ?? {}).toEqual({})
          expect(context().prePlanMode).toBeUndefined()
          expect(rig.sessionFlags().autoExitNotice).toBe(true)
          if (c.mode) expect(screen.state().initialMessage!.mode).toBe(c.mode as never)
        },
        SLOW,
      )
    }

    const kept: Array<{ what: string; setup?: Setup; keys: string[]; mode: string; prePlan: string | undefined }> = [
      { what: '"use auto mode"', keys: ['1'], mode: 'auto', prePlan: undefined },
      { what: 'Esc', keys: [KEYS.esc], mode: 'plan', prePlan: 'auto' },
      { what: 'turning it down with feedback', keys: ['3', ...'more', KEYS.enter], mode: 'plan', prePlan: 'auto' },
    ]
    for (const c of kept) {
      test(
        `${c.what}: auto mode keeps running and its rules stay aside`,
        async () => {
          const { screen, context } = await open({ ...c.setup, autoDuringPlan: true })
          await screen.press(...c.keys)
          expect(autoMode.isAutoModeActive()).toBe(true)
          expect(context().mode).toBe(c.mode as never)
          expect(context().prePlanMode).toBe(c.prePlan as never)
          expect(context().alwaysAllowRules.session).toEqual(['Read'])
          expect(context().strippedDangerousRules).toEqual({ session: ['Bash(*)'] })
          expect(rig.sessionFlags().autoExitNotice).toBe(false)
        },
        SLOW,
      )
    }

    test(
      'clearing context into auto keeps auto mode on and its rules aside',
      async () => {
        const { screen, context } = await open({ clear: true, autoDuringPlan: true })
        await screen.press('1')
        expect(screen.state().initialMessage!.mode).toBe('auto')
        expect(autoMode.isAutoModeActive()).toBe(true)
        expect(context().strippedDangerousRules).toEqual({ session: ['Bash(*)'] })
        expect(rig.sessionFlags().autoExitNotice).toBe(false)
      },
      SLOW,
    )
  })

  describe('shipped: an empty plan', () => {
    const cases: Array<{ during: boolean; keys: string[]; stops: boolean }> = [
      { during: true, keys: ['1'], stops: true },
      { during: false, keys: ['1'], stops: false },
      { during: true, keys: ['2'], stops: false },
    ]
    for (const c of cases) {
      test(
        `auto ${c.during ? 'running' : 'off'} during the plan, "${c.keys[0]}": auto ${c.stops ? 'stops and its rules come back' : 'is left as it was'}`,
        async () => {
          const { screen, ledger, context } = await open({ plan: null, autoDuringPlan: c.during })
          expect(flat(screen.text())).toContain('Exit plan mode?')
          await screen.press(...c.keys)
          expect(autoMode.isAutoModeActive()).toBe(c.during && !c.stops)
          expect(rig.sessionFlags().autoExitNotice).toBe(c.stops)
          if (c.stops) {
            expect(ledger).toEqual(allowed(setMode('default')))
            expect(context().alwaysAllowRules.session).toEqual(['Read', 'Bash(*)'])
            expect(context().prePlanMode).toBeUndefined()
          }
          if (c.during && !c.stops) expect(context().strippedDangerousRules).toEqual({ session: ['Bash(*)'] })
        },
        SLOW,
      )
    }
  })
}
