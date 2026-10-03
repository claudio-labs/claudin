/**
 * Characterization of the auto-mode gate as the shipped build runs it: which
 * models may enter auto mode, what closes the gate, what the startup check
 * does to a session that is already in auto, the notice it leaves, and the
 * hook that re-runs it when the model changes.
 *
 * Needs TRANSCRIPT_CLASSIFIER on; under the plain runner the file only starts
 * a flagged child run of itself (see __testutils__/shippedFlag).
 *
 * The one boundary replaced is the model call the capability probe makes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { delegateToShippedBuild, shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'

type ProbeRequest = { model: string; tool_choice?: { type: string; name: string } }
const probe = {
  requests: [] as ProbeRequest[],
  answer: 'tool' as 'tool' | 'text' | 'error',
}

if (!shipped) {
  delegateToShippedBuild(import.meta.path)
} else {
  const realSideQuery = { ...(await import('src/agent/sideQuery.js')) }
  mock.module('src/agent/sideQuery.js', () => ({
    ...realSideQuery,
    sideQuery: async (request: ProbeRequest) => {
      probe.requests.push(request)
      if (probe.answer === 'error') throw new Error('endpoint refused the request')
      const name = request.tool_choice?.name ?? 'unknown'
      return {
        content:
          probe.answer === 'tool'
            ? [{ type: 'tool_use', id: 'toolu_probe', name, input: { thinking: '', shouldBlock: false, reason: 'ok' } }]
            : [{ type: 'text', text: 'I would rather explain.' }],
      }
    },
  }))
  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQuery)
  })
  await defineSuite()
}

async function defineSuite(): Promise<void> {
  const { needsAutoModeExitAttachment } = await import('src/platform/bootstrap/state.js')
  const autoModeState = await import('src/permissions/autoModeState.js')
  const killswitch = await import('src/permissions/bypassPermissionsKillswitch.js')
  const setup = await import('src/permissions/permissionSetup.js')
  const { usePermissionScene } = await import('src/permissions/permissionSetup/__testutils__/permissionScene.js')
  const { getEmptyToolPermissionContext } = await import('src/tools/Tool.js')
  const { AppStateProvider, useAppStateStore } = await import('src/terminal/state/AppState.js')
  const { getDefaultAppState } = await import('src/terminal/state/AppStateStore.js')
  const { createRoot } = await import('src/terminal/ink.js')
  const { createFakeTerminal } = await import('src/terminal/__testutils__/fakeTerminal.js')
  type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
  type AppState = ReturnType<typeof getDefaultAppState>

  const scene = usePermissionScene()
  const endpoint = { baseUrl: 'https://llm.example.test/v1', model: 'gpt-5.4' }

  beforeEach(() => {
    probe.requests.length = 0
    probe.answer = 'tool'
  })

  const ctx = (over: Partial<Ctx> = {}): Ctx => ({ ...getEmptyToolPermissionContext(), ...over })
  const DANGEROUS = 'Bash(python:*)'
  /** A context in auto mode whose dangerous allow rule was set aside on entry. */
  const inAutoWithStash = (over: Partial<Ctx> = {}): Ctx =>
    ctx({ mode: 'auto', alwaysAllowRules: { session: ['Read'] }, strippedDangerousRules: { session: [DANGEROUS] }, isAutoModeAvailable: true, ...over })

  describe('which models may enter auto mode', () => {
    const byName: Array<[string, boolean]> = [
      ['claude-sonnet-4-6', true],
      ['claude-opus-4-7', true],
      ['claude-opus-5', true],
      ['Claude-Sonnet-4-6', true],
      ['claude-sonnet-4-5', false],
      ['claude-opus-4-1', false],
      ['claude-opus-4', false],
      ['claude-haiku-4-5', false],
      ['claude-3-7-sonnet-20250219', false],
      ['gpt-5.4', false],
    ]
    for (const [model, allowed] of byName) {
      test(`${model}: ${allowed ? 'by name' : 'not without a probe'}`, () => {
        expect(setup.__autoModeAllowedForModelForTests(model)).toBe(allowed)
      })
    }

    test('another model is cleared only by a passing probe on the active endpoint', () => {
      const allowed = () => setup.__autoModeAllowedForModelForTests(endpoint.model)
      scene.recordProbe(endpoint, true)
      expect(allowed()).toBe(false)
      scene.useProvider(endpoint)
      expect(allowed()).toBe(true)
      scene.useProvider({ ...endpoint, baseUrl: 'https://other.example.test/v1' })
      expect(allowed()).toBe(false)
      expect(setup.__autoModeAllowedForModelForTests('gpt-5.4-mini')).toBe(false)
    })

    test('a failed probe keeps the model out', () => {
      scene.useProvider(endpoint)
      scene.recordProbe(endpoint, false)
      expect(setup.__autoModeAllowedForModelForTests(endpoint.model)).toBe(false)
    })
  })

  describe('what closes the gate, and the reason given', () => {
    type Row = { name: string; arrange: () => void; open: boolean; reason: string | null }
    const rows: Row[] = [
      { name: 'a cleared model and nothing else', arrange: () => {}, open: true, reason: null },
      { name: 'a probed model', arrange: () => { scene.useModel(endpoint.model); scene.useProvider(endpoint); scene.recordProbe(endpoint, true) }, open: true, reason: null },
      { name: 'an uncleared model', arrange: () => scene.useModel('claude-sonnet-4-5'), open: false, reason: 'model' },
      { name: 'the circuit breaker', arrange: () => autoModeState.setAutoModeCircuitBroken(true), open: false, reason: 'circuit-breaker' },
      { name: 'the breaker outranks the model', arrange: () => { autoModeState.setAutoModeCircuitBroken(true); scene.useModel('gpt-5.4') }, open: false, reason: 'circuit-breaker' },
      { name: 'settings outrank the breaker', arrange: () => { autoModeState.setAutoModeCircuitBroken(true); scene.write('managed', { disableAutoMode: 'disable' }) }, open: false, reason: 'settings' },
      { name: 'a repository can switch it off', arrange: () => scene.write('project', { permissions: { disableAutoMode: 'disable' } }), open: false, reason: 'settings' },
    ]
    for (const row of rows) {
      test(row.name, () => {
        row.arrange()
        expect(setup.isAutoModeGateEnabled()).toBe(row.open)
        expect(setup.getAutoModeUnavailableReason()).toBe(row.reason as never)
      })
    }
  })

  describe('the startup check: the capability probe', () => {
    type Row = { name: string; arrange: () => void; probes: number }
    const rows: Row[] = [
      { name: 'a model cleared by name is never probed', arrange: () => scene.useProvider(endpoint), probes: 0 },
      { name: 'an unprobed model on an endpoint is probed', arrange: () => { scene.useModel(endpoint.model); scene.useProvider(endpoint) }, probes: 1 },
      { name: 'a stored failure is not probed again', arrange: () => { scene.useModel(endpoint.model); scene.useProvider(endpoint); scene.recordProbe(endpoint, false) }, probes: 0 },
      { name: 'no endpoint, no probe', arrange: () => scene.useModel(endpoint.model), probes: 0 },
      { name: 'settings that disable auto mode skip the probe', arrange: () => { scene.useModel(endpoint.model); scene.useProvider(endpoint); scene.write('user', { disableAutoMode: 'disable' }) }, probes: 0 },
    ]
    for (const row of rows) {
      test(row.name, async () => {
        row.arrange()
        await setup.verifyAutoModeGateAccess(ctx())
        expect(probe.requests).toHaveLength(row.probes)
      })
    }

    test('the probe asks the session model for a forced tool call', async () => {
      scene.useModel(endpoint.model)
      scene.useProvider(endpoint)
      await setup.verifyAutoModeGateAccess(ctx())
      expect(probe.requests[0]?.model).toBe(endpoint.model)
      expect(probe.requests[0]?.tool_choice?.type).toBe('tool')
    })

    const outcomes: Array<[typeof probe.answer, boolean]> = [
      ['tool', true],
      ['text', false],
      ['error', false],
    ]
    for (const [answer, opens] of outcomes) {
      test(`a probe answered with ${answer} ${opens ? 'opens' : 'keeps closed'} the gate, and is remembered`, async () => {
        scene.useModel(endpoint.model)
        scene.useProvider(endpoint)
        probe.answer = answer
        const { updateContext, notification } = await setup.verifyAutoModeGateAccess(ctx())
        expect(updateContext(ctx()).isAutoModeAvailable).toBe(opens)
        expect(notification).toBeUndefined()
        expect(setup.isAutoModeGateEnabled()).toBe(opens)
        await setup.verifyAutoModeGateAccess(ctx())
        expect(probe.requests).toHaveLength(1)
      })
    }
  })

  describe('the startup check: settings latch the circuit breaker', () => {
    test('a disabling setting latches it, and a later check without it releases it', async () => {
      scene.write('user', { disableAutoMode: 'disable' })
      await setup.verifyAutoModeGateAccess(ctx())
      expect(autoModeState.isAutoModeCircuitBroken()).toBe(true)
      scene.write('user', {})
      expect(setup.isAutoModeGateEnabled()).toBe(false)
      await setup.verifyAutoModeGateAccess(ctx())
      expect(autoModeState.isAutoModeCircuitBroken()).toBe(false)
      expect(setup.isAutoModeGateEnabled()).toBe(true)
    })
  })

  describe('the startup check: an open gate', () => {
    test('offers auto mode, says nothing, and leaves the mode alone', async () => {
      const { updateContext, notification } = await setup.verifyAutoModeGateAccess(ctx({ mode: 'auto' }))
      expect(notification).toBeUndefined()
      const after = updateContext(ctx({ mode: 'auto' }))
      expect(after.mode).toBe('auto')
      expect(after.isAutoModeAvailable).toBe(true)
    })

    test('hands back the same context when it already offers auto mode', async () => {
      const { updateContext } = await setup.verifyAutoModeGateAccess(ctx())
      const offered = ctx({ isAutoModeAvailable: true })
      expect(updateContext(offered)).toBe(offered)
    })
  })

  describe('the startup check: a closed gate', () => {
    type Row = { name: string; fresh: () => Ctx; mode: string; prePlanMode?: string; allow: string[]; exits: boolean }
    const rows: Row[] = [
      { name: 'auto is left for default, with the set-aside rules back', fresh: () => inAutoWithStash(), mode: 'default', allow: ['Read', DANGEROUS], exits: true },
      { name: 'plan entered from auto forgets auto', fresh: () => inAutoWithStash({ mode: 'plan', prePlanMode: 'auto' }), mode: 'plan', prePlanMode: 'default', allow: ['Read', DANGEROUS], exits: true },
      { name: 'plan running with auto keeps its remembered mode', fresh: () => inAutoWithStash({ mode: 'plan', prePlanMode: 'acceptEdits' }), mode: 'plan', prePlanMode: 'acceptEdits', allow: ['Read', DANGEROUS], exits: true },
      { name: 'plain plan only loses the offer', fresh: () => ctx({ mode: 'plan', prePlanMode: 'default', alwaysAllowRules: { session: ['Read'] }, isAutoModeAvailable: true }), mode: 'plan', prePlanMode: 'default', allow: ['Read'], exits: false },
      { name: 'acceptEdits only loses the offer', fresh: () => ctx({ mode: 'acceptEdits', alwaysAllowRules: { session: ['Read'] }, isAutoModeAvailable: true }), mode: 'acceptEdits', allow: ['Read'], exits: false },
    ]
    for (const row of rows) {
      test(row.name, async () => {
        scene.useModel('claude-sonnet-4-5')
        autoModeState.setAutoModeActive(true)
        const { updateContext } = await setup.verifyAutoModeGateAccess(ctx())
        const after = updateContext(row.fresh())
        expect(after.mode).toBe(row.mode as never)
        expect(after.prePlanMode).toBe(row.prePlanMode as never)
        expect(after.alwaysAllowRules.session).toEqual(row.allow)
        expect(after.isAutoModeAvailable).toBe(false)
        expect(after.strippedDangerousRules === undefined || !row.exits).toBe(true)
        expect(autoModeState.isAutoModeActive()).toBe(!row.exits)
        expect(needsAutoModeExitAttachment()).toBe(row.exits)
      })
    }

    test('a context that already lacks the offer comes back untouched', async () => {
      scene.useModel('claude-sonnet-4-5')
      const { updateContext } = await setup.verifyAutoModeGateAccess(ctx())
      const lacking = ctx({ isAutoModeAvailable: false })
      expect(updateContext(lacking)).toBe(lacking)
    })

    test('the change is judged on the context it is applied to, not the one checked', async () => {
      scene.useModel('claude-sonnet-4-5')
      const left = await setup.verifyAutoModeGateAccess(inAutoWithStash())
      autoModeState.setAutoModeActive(true)
      expect(left.updateContext(ctx({ mode: 'acceptEdits' })).mode).toBe('acceptEdits')
      expect(autoModeState.isAutoModeActive()).toBe(true)
      expect(needsAutoModeExitAttachment()).toBe(false)

      const entered = await setup.verifyAutoModeGateAccess(ctx())
      expect(entered.notification).toBeUndefined()
      expect(entered.updateContext(inAutoWithStash()).mode).toBe('default')
    })

    type Notice = { name: string; checked: () => Ctx; askedOnCli?: boolean; settings?: boolean; notice: string | undefined }
    const MODEL = 'auto mode unavailable for this model'
    const SETTINGS = 'auto mode disabled by settings'
    const notices: Notice[] = [
      { name: 'a session that never wanted auto', checked: () => ctx(), notice: undefined },
      { name: 'a session in auto', checked: () => ctx({ mode: 'auto' }), notice: MODEL },
      { name: 'a session in auto, closed by settings', checked: () => ctx({ mode: 'auto' }), settings: true, notice: SETTINGS },
      { name: 'plan entered from auto', checked: () => ctx({ mode: 'plan', prePlanMode: 'auto' }), notice: MODEL },
      { name: 'plan running with auto', checked: () => ctx({ mode: 'plan', strippedDangerousRules: {} }), notice: MODEL },
      { name: 'plain plan', checked: () => ctx({ mode: 'plan', prePlanMode: 'default' }), notice: undefined },
      { name: 'auto asked for on the command line, still offered', checked: () => ctx({ isAutoModeAvailable: true }), askedOnCli: true, notice: MODEL },
      { name: 'auto asked for on the command line, already withdrawn', checked: () => ctx({ isAutoModeAvailable: false }), askedOnCli: true, notice: undefined },
      { name: 'auto asked for on the command line, never offered', checked: () => ctx(), askedOnCli: true, notice: undefined },
    ]
    for (const row of notices) {
      test(`the notice: ${row.name}`, async () => {
        if (row.settings) scene.write('user', { disableAutoMode: 'disable' })
        else scene.useModel('claude-sonnet-4-5')
        if (row.askedOnCli) autoModeState.setAutoModeFlagCli(true)
        expect((await setup.verifyAutoModeGateAccess(row.checked())).notification).toBe(row.notice)
      })
    }
  })

  describe('the startup check run against the app state', () => {
    function stateWith(over: Partial<Ctx>): AppState {
      const base = getDefaultAppState()
      return {
        ...base,
        toolPermissionContext: ctx(over),
        notifications: { ...base.notifications, queue: [{ key: 'earlier', text: 'kept', priority: 'low' }] as never },
      }
    }
    async function runOn(state: AppState, snapshot: Ctx = state.toolPermissionContext) {
      let current = state
      let writes = 0
      await killswitch.checkAndDisableAutoModeIfNeeded(snapshot, update => {
        writes++
        current = update(current)
      })
      return { state: current, writes }
    }

    test('a session kicked out of auto gets the change and a high-priority warning', async () => {
      scene.useModel('claude-sonnet-4-5')
      const { state, writes } = await runOn(stateWith({ mode: 'auto' }))
      expect(writes).toBe(1)
      expect(state.toolPermissionContext.mode).toBe('default')
      expect(state.notifications.queue).toEqual([
        { key: 'earlier', text: 'kept', priority: 'low' },
        { key: 'auto-mode-gate-notification', text: 'auto mode unavailable for this model', color: 'warning', priority: 'high' },
      ] as never)
    })

    test('nothing to change and nothing to say leaves the state object as it was', async () => {
      const before = stateWith({ isAutoModeAvailable: true })
      expect((await runOn(before)).state).toBe(before)
    })

    test('the change lands on the context in the state, not the snapshot it was given', async () => {
      scene.useModel('claude-sonnet-4-5')
      const before = stateWith({ mode: 'acceptEdits' })
      const { state } = await runOn(before, ctx({ mode: 'auto' }))
      expect(state.toolPermissionContext.mode).toBe('acceptEdits')
      expect(state.toolPermissionContext.isAutoModeAvailable).toBe(false)
      expect(state.notifications.queue).toHaveLength(2)
    })

    test('runs once per process until it is reset', async () => {
      expect((await runOn(stateWith({}))).writes).toBe(1)
      expect((await runOn(stateWith({}))).writes).toBe(0)
      killswitch.resetAutoModeGateCheck()
      expect((await runOn(stateWith({}))).writes).toBe(1)
    })
  })

  describe('the hook that re-runs the check when the model changes', () => {
    type Mounted = { store: { getState(): AppState; setState(f: (s: AppState) => AppState): void }; stop(): void }
    const mounted: Mounted[] = []
    afterEach(() => {
      for (const m of mounted.splice(0)) m.stop()
    })

    async function mount(initial: AppState): Promise<Mounted> {
      const terminal = createFakeTerminal({ columns: 80 })
      const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false, patchConsole: false })
      let store: Mounted['store'] | undefined
      function Watcher(): React.ReactNode {
        store = useAppStateStore()
        killswitch.useKickOffCheckAndDisableAutoModeIfNeeded()
        return null
      }
      root.render(
        <AppStateProvider initialState={initial}>
          <Watcher />
        </AppStateProvider>,
      )
      await waitFor(() => store !== undefined)
      const handle = { store: store!, stop: () => { root.unmount(); terminal.close() } }
      mounted.push(handle)
      return handle
    }

    async function waitFor(check: () => boolean): Promise<void> {
      const deadline = Date.now() + 3_000
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await Bun.sleep(5)
      }
    }

    test('checks on mount, and again after each model change', async () => {
      scene.useModel('claude-sonnet-4-5')
      const app = await mount({ ...getDefaultAppState(), toolPermissionContext: ctx({ mode: 'auto' }) })
      await waitFor(() => app.store.getState().toolPermissionContext.mode === 'default')
      expect(app.store.getState().notifications.queue.map(n => n.key)).toContain('auto-mode-gate-notification')

      scene.useModel('claude-opus-5')
      app.store.setState(s => ({ ...s, mainLoopModel: 'claude-opus-5' }))
      await waitFor(() => app.store.getState().toolPermissionContext.isAutoModeAvailable === true)

      scene.useModel('claude-sonnet-4-5')
      app.store.setState(s => ({ ...s, mainLoopModelForSession: 'claude-sonnet-4-5' }))
      await waitFor(() => app.store.getState().toolPermissionContext.isAutoModeAvailable === false)
    })

    test('a state change that is not a model change does not re-run it', async () => {
      const app = await mount({ ...getDefaultAppState(), toolPermissionContext: ctx() })
      await waitFor(() => app.store.getState().toolPermissionContext.isAutoModeAvailable === true)
      scene.useModel('claude-sonnet-4-5')
      app.store.setState(s => ({ ...s, verbose: true }))
      await Bun.sleep(50)
      expect(app.store.getState().toolPermissionContext.isAutoModeAvailable).toBe(true)
    })
  })

  describe('starting a session in auto mode', () => {
    type Row = { name: string; cli?: string; skip?: boolean; files?: Record<string, Record<string, unknown>>; remote?: boolean; mode: string; active: boolean; notice?: string }
    const rows: Row[] = [
      { name: '--permission-mode auto', cli: 'auto', mode: 'auto', active: true },
      { name: 'a repository defaultMode auto', files: { project: { permissions: { defaultMode: 'auto' } } }, mode: 'auto', active: true },
      { name: 'auto starts even on a model the gate refuses', cli: 'auto', files: { user: { disableAutoMode: 'disable' } }, mode: 'auto', active: true },
      { name: 'the skip flag outranks it', skip: true, cli: 'auto', mode: 'bypassPermissions', active: false },
      { name: 'a refused skip flag falls through to it', skip: true, files: { managed: { permissions: { defaultMode: 'auto', disableBypassPermissionsMode: 'disable' } } }, mode: 'auto', active: true, notice: 'Bypass permissions mode was disabled by settings' },
      { name: 'remote sessions ignore defaultMode auto', remote: true, files: { user: { permissions: { defaultMode: 'auto' } } }, mode: 'default', active: false },
    ]
    for (const row of rows) {
      test(row.name, () => {
        for (const [layer, json] of Object.entries(row.files ?? {})) scene.write(layer as never, json)
        if (row.remote) process.env.CLAUDE_CODE_REMOTE = 'true'
        const started = setup.initialPermissionModeFromCLI({ permissionModeCli: row.cli, dangerouslySkipPermissions: row.skip })
        expect(started).toEqual({ mode: row.mode as never, notification: row.notice })
        expect(autoModeState.isAutoModeActive()).toBe(row.active)
      })
    }

    const defaults: Array<[string, Record<string, Record<string, unknown>>, boolean]> = [
      ['no setting', {}, false],
      ['user', { user: { permissions: { defaultMode: 'auto' } } }, true],
      ['project', { project: { permissions: { defaultMode: 'auto' } } }, true],
      ['the managed plan outranks a user auto', { user: { permissions: { defaultMode: 'auto' } }, managed: { permissions: { defaultMode: 'plan' } } }, false],
    ]
    for (const [name, files, isAuto] of defaults) {
      test(`defaultMode auto is read from settings: ${name}`, () => {
        for (const [layer, json] of Object.entries(files)) scene.write(layer as never, json)
        expect(setup.isDefaultPermissionModeAuto()).toBe(isAuto)
      })
    }

    test('the starting context offers auto mode when the gate is open', async () => {
      const open = await setup.initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'default', allowDangerouslySkipPermissions: false, addDirs: [] })
      expect(open.toolPermissionContext.isAutoModeAvailable).toBe(true)
      scene.write('local', { disableAutoMode: 'disable' })
      const closed = await setup.initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'default', allowDangerouslySkipPermissions: false, addDirs: [] })
      expect(closed.toolPermissionContext.isAutoModeAvailable).toBe(false)
    })

    test('in auto mode, rules that would pre-empt the classifier are reported, and left in place', async () => {
      scene.write('user', { permissions: { allow: [DANGEROUS, 'Bash(git status)'] } })
      const started = await setup.initializeToolPermissionContext({
        allowedToolsCli: ['Bash(node:*)', 'Read'],
        disallowedToolsCli: [],
        permissionMode: 'auto',
        allowDangerouslySkipPermissions: false,
        addDirs: [],
      })
      expect(started.dangerousPermissions.map(p => [p.source, p.ruleDisplay])).toEqual([
        ['userSettings', DANGEROUS],
        ['cliArg', 'Bash(node:*)'],
      ])
      expect(started.dangerousPermissions[1]?.sourceDisplay).toBe('--allowed-tools')
      expect(started.toolPermissionContext.alwaysAllowRules.userSettings).toEqual([DANGEROUS, 'Bash(git status)'])
      expect(started.toolPermissionContext.strippedDangerousRules).toBeUndefined()
    })

    test('outside auto mode the same rules are not reported', async () => {
      scene.write('user', { permissions: { allow: [DANGEROUS] } })
      const started = await setup.initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'plan', allowDangerouslySkipPermissions: false, addDirs: [] })
      expect(started.dangerousPermissions).toEqual([])
    })
  })
}
