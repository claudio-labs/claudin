/**
 * Characterization of permission setup: the mode a session starts in, the
 * context its permission checks start from, the bypass-permissions kill
 * switch, and the order shift+tab walks the modes in.
 *
 * Everything here holds whether or not the TRANSCRIPT_CLASSIFIER build flag
 * is on, so the file runs under the plain runner and under the flagged one.
 * The auto-mode half lives in the two `setup.auto*` suites beside it. A few
 * answers that only the plain runner gives sit in the last block, which
 * registers only when the flag is off.
 *
 * Settings are real files in a temp tree (see __testutils__/permissionScene).
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasExitedPlanModeInSession,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import * as autoModeState from 'src/permissions/autoModeState.js'
import { checkAndDisableAutoModeIfNeeded } from 'src/permissions/bypassPermissionsKillswitch.js'
import { cyclePermissionMode, getNextPermissionMode } from 'src/permissions/getNextPermissionMode.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import {
  createDisabledBypassPermissionsContext,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  isDefaultPermissionModeAuto,
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
  prepareContextForPlanMode,
  shouldPlanUseAutoMode,
  transitionPermissionMode,
  transitionPlanAutoMode,
  verifyAutoModeGateAccess,
} from 'src/permissions/permissionSetup.js'
import { shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'
import { type Layer, usePermissionScene } from 'src/permissions/permissionSetup/__testutils__/permissionScene.js'
import { getToolsForDefaultPreset } from 'src/tools/tools.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const scene = usePermissionScene()

function context(over: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return { ...getEmptyToolPermissionContext(), ...over }
}

type Startup = {
  allowed?: string[]
  denied?: string[]
  base?: string[]
  mode?: PermissionMode
  skipFlag?: boolean
  dirs?: string[]
}

function startUp(input: Startup = {}) {
  return initializeToolPermissionContext({
    allowedToolsCli: input.allowed ?? [],
    disallowedToolsCli: input.denied ?? [],
    baseToolsCli: input.base,
    permissionMode: input.mode ?? 'default',
    allowDangerouslySkipPermissions: input.skipFlag ?? false,
    addDirs: input.dirs ?? [],
  })
}

const BYPASS_REFUSED = 'Bypass permissions mode was disabled by settings'

describe('the tool lists given on the command line', () => {
  const lists: Array<[string, string[], string[]]> = [
    ['nothing given', [], []],
    ['one name', ['Read'], ['Read']],
    ['commas separate', ['Read,Write,Grep'], ['Read', 'Write', 'Grep']],
    ['spaces separate', ['Read Write'], ['Read', 'Write']],
    ['runs of separators collapse and ends are trimmed', ['  Read ,  Write ,, Grep  '], ['Read', 'Write', 'Grep']],
    ['only separators', [' , ,  '], []],
    ['empty elements are skipped', ['Read', '', 'Write'], ['Read', 'Write']],
    ['each element is its own list', ['Read,Write', 'Bash(ls)'], ['Read', 'Write', 'Bash(ls)']],
    ['a comma inside parentheses is content', ['Bash(npm run test, lint),Edit'], ['Bash(npm run test, lint)', 'Edit']],
    ['a space inside parentheses is content', ['Bash(git log --oneline) Read'], ['Bash(git log --oneline)', 'Read']],
    ['nested parentheses closing together', ['Bash(echo (a, b)),Read'], ['Bash(echo (a, b))', 'Read']],
    ['an unclosed parenthesis runs to the end of its element', ['Bash(ls, Read', 'Write'], ['Bash(ls, Read', 'Write']],
  ]
  for (const [name, input, expected] of lists) {
    test(`allowed/disallowed: ${name}`, () => {
      expect(parseToolListFromCLI(input)).toEqual(expected)
    })
  }

  const presetSpellings = [['default'], ['DEFAULT'], ['  Default '], ['', 'default']]
  for (const spelling of presetSpellings) {
    test(`base tools: ${JSON.stringify(spelling)} names the default preset`, () => {
      expect(parseBaseToolsFromCLI(spelling)).toEqual(getToolsForDefaultPreset())
    })
  }

  const customBases: Array<[string[], string[]]> = [
    [['Read,Bash'], ['Read', 'Bash']],
    [['default', 'Read'], ['default', 'Read']],
    [['de', 'fault'], ['de', 'fault']],
    [[], []],
  ]
  for (const [input, expected] of customBases) {
    test(`base tools: ${JSON.stringify(input)} is a plain list`, () => {
      expect(parseBaseToolsFromCLI(input)).toEqual(expected)
    })
  }
})

describe('the mode a session starts in', () => {
  type Row = {
    name: string
    files?: Partial<Record<Layer, Record<string, unknown>>>
    remote?: boolean
    skip?: boolean
    cli?: string
    mode: PermissionMode
    refused?: boolean
  }
  const disable = { permissions: { disableBypassPermissionsMode: 'disable' } }
  const rows: Row[] = [
    { name: 'no flag and no setting', mode: 'default' },
    { name: '--dangerously-skip-permissions', skip: true, mode: 'bypassPermissions' },
    { name: '--permission-mode plan', cli: 'plan', mode: 'plan' },
    { name: '--permission-mode with an unknown name', cli: 'yolo', mode: 'default' },
    { name: 'the skip flag outranks --permission-mode', skip: true, cli: 'plan', mode: 'bypassPermissions' },
    { name: '--permission-mode outranks defaultMode', cli: 'acceptEdits', files: { user: { permissions: { defaultMode: 'plan' } } }, mode: 'acceptEdits' },
    { name: 'user defaultMode', files: { user: { permissions: { defaultMode: 'plan' } } }, mode: 'plan' },
    { name: 'the managed defaultMode outranks the user one', files: { user: { permissions: { defaultMode: 'acceptEdits' } }, managed: { permissions: { defaultMode: 'plan' } } }, mode: 'plan' },
    { name: 'local defaultMode outranks the project one', files: { project: { permissions: { defaultMode: 'plan' } }, local: { permissions: { defaultMode: 'acceptEdits' } } }, mode: 'acceptEdits' },
    { name: 'a repository can choose acceptEdits', files: { project: { permissions: { defaultMode: 'acceptEdits' } } }, mode: 'acceptEdits' },
    { name: 'a repository can choose bypassPermissions', files: { project: { permissions: { defaultMode: 'bypassPermissions' } } }, mode: 'bypassPermissions' },
    { name: 'the managed kill switch refuses the skip flag', skip: true, files: { managed: disable }, mode: 'default', refused: true },
    { name: 'a refused skip flag falls through to --permission-mode', skip: true, cli: 'plan', files: { managed: disable }, mode: 'plan', refused: true },
    { name: 'a refused --permission-mode bypassPermissions', cli: 'bypassPermissions', files: { user: disable }, mode: 'default', refused: true },
    { name: 'a refused defaultMode bypassPermissions', files: { user: { permissions: { defaultMode: 'bypassPermissions', disableBypassPermissionsMode: 'disable' } } }, mode: 'default', refused: true },
    { name: 'a repository can refuse bypass too', skip: true, files: { project: disable }, mode: 'default', refused: true },
    { name: 'the --settings file can refuse bypass', skip: true, files: { flag: disable }, mode: 'default', refused: true },
    { name: 'the kill switch says nothing when bypass was not asked for', cli: 'plan', files: { managed: disable }, mode: 'plan' },
    { name: 'remote: defaultMode bypassPermissions is ignored', remote: true, files: { user: { permissions: { defaultMode: 'bypassPermissions' } } }, mode: 'default' },
    { name: 'remote: defaultMode dontAsk is ignored', remote: true, files: { user: { permissions: { defaultMode: 'dontAsk' } } }, mode: 'default' },
    { name: 'remote: defaultMode plan is kept', remote: true, files: { user: { permissions: { defaultMode: 'plan' } } }, mode: 'plan' },
    { name: 'remote: defaultMode acceptEdits is kept', remote: true, files: { user: { permissions: { defaultMode: 'acceptEdits' } } }, mode: 'acceptEdits' },
    { name: 'remote: the skip flag still applies', remote: true, skip: true, mode: 'bypassPermissions' },
  ]
  for (const row of rows) {
    test(row.name, () => {
      for (const [layer, json] of Object.entries(row.files ?? {})) scene.write(layer as Layer, json)
      if (row.remote) process.env.CLAUDE_CODE_REMOTE = '1'
      const started = initialPermissionModeFromCLI({ permissionModeCli: row.cli, dangerouslySkipPermissions: row.skip })
      expect(started.mode).toBe(row.mode)
      expect(started.notification).toBe(row.refused ? BYPASS_REFUSED : undefined)
    })
  }
})

describe('the context a session starts with', () => {
  test('CLI rules land under cliArg; allow rules are normalized, deny rules kept as typed', async () => {
    const { toolPermissionContext, warnings, dangerousPermissions } = await startUp({
      allowed: ['Read,Task', 'Bash(echo (hi))'],
      denied: ['Task', 'Bash(rm:*)'],
    })
    expect(toolPermissionContext.alwaysAllowRules.cliArg).toEqual(['Read', 'Agent', 'Bash(echo \\(hi\\))'])
    expect(toolPermissionContext.alwaysDenyRules.cliArg).toEqual(['Task', 'Bash(rm:*)'])
    expect(toolPermissionContext.alwaysAskRules).toEqual({})
    expect(toolPermissionContext.mode).toBe('default')
    expect(warnings).toEqual([])
    expect(dangerousPermissions).toEqual([])
  })

  test('the mode is taken as given', async () => {
    for (const mode of ['plan', 'acceptEdits', 'dontAsk'] as const) {
      expect((await startUp({ mode })).toolPermissionContext.mode).toBe(mode)
    }
  })

  test('--base-tools denies every default tool it does not name, legacy names included', async () => {
    const all = getToolsForDefaultPreset()
    const { toolPermissionContext } = await startUp({ base: ['Read,Task'], denied: ['WebFetch'] })
    const denied = toolPermissionContext.alwaysDenyRules.cliArg ?? []
    expect(denied[0]).toBe('WebFetch')
    expect(denied.slice(1)).toEqual(all.filter(name => name !== 'Read' && name !== 'Agent'))
  })

  test('--base-tools default, or an empty list, denies nothing extra', async () => {
    for (const base of [['default'], []]) {
      expect((await startUp({ base })).toolPermissionContext.alwaysDenyRules.cliArg).toEqual([])
    }
  })

  test('rules from every settings file are loaded under their source', async () => {
    scene.write('user', { permissions: { allow: ['Bash(git status)'] } })
    scene.write('project', { permissions: { allow: ['Bash(npm test)'], ask: ['WebFetch'] } })
    scene.write('local', { permissions: { deny: ['Bash(curl:*)'] } })
    scene.write('managed', { permissions: { deny: ['Bash(sudo:*)'] } })
    const { toolPermissionContext: ctx } = await startUp()
    expect(ctx.alwaysAllowRules.userSettings).toEqual(['Bash(git status)'])
    expect(ctx.alwaysAllowRules.projectSettings).toEqual(['Bash(npm test)'])
    expect(ctx.alwaysAskRules.projectSettings).toEqual(['WebFetch'])
    expect(ctx.alwaysDenyRules.localSettings).toEqual(['Bash(curl:*)'])
    expect(ctx.alwaysDenyRules.policySettings).toEqual(['Bash(sudo:*)'])
  })

  type BypassRow = {
    name: string
    mode?: PermissionMode
    skipFlag?: boolean
    files?: Partial<Record<Layer, Record<string, unknown>>>
    available: boolean
  }
  const allow = { permissions: { allowBypassPermissionsMode: true } }
  const disable = { permissions: { disableBypassPermissionsMode: 'disable' } }
  const bypassRows: BypassRow[] = [
    { name: 'nothing asks for it', available: false },
    { name: 'the session starts in bypassPermissions', mode: 'bypassPermissions', available: true },
    { name: '--allow-dangerously-skip-permissions', skipFlag: true, available: true },
    { name: 'user settings allow it', files: { user: allow }, available: true },
    { name: 'local settings allow it', files: { local: allow }, available: true },
    { name: 'the --settings file allows it', files: { flag: allow }, available: true },
    { name: 'managed settings allow it', files: { managed: allow }, available: true },
    { name: 'a repository cannot offer it', files: { project: allow }, available: false },
    { name: 'the managed kill switch beats the mode', mode: 'bypassPermissions', files: { managed: disable }, available: false },
    { name: 'a repository kill switch beats the flag', skipFlag: true, files: { project: disable }, available: false },
    { name: 'a kill switch beats an allow in the same file', files: { user: { permissions: { allowBypassPermissionsMode: true, disableBypassPermissionsMode: 'disable' } } }, available: false },
  ]
  for (const row of bypassRows) {
    test(`bypass in the mode list: ${row.name}`, async () => {
      for (const [layer, json] of Object.entries(row.files ?? {})) scene.write(layer as Layer, json)
      const { toolPermissionContext } = await startUp({ mode: row.mode, skipFlag: row.skipFlag })
      expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(row.available)
    })
  }

  test('extra directories from --add-dir and from settings join as cliArg; bad ones warn or vanish', async () => {
    const fromFlag = join(scene.scratch, 'flag-dir')
    const fromSettings = join(scene.scratch, 'settings-dir')
    const aFile = join(scene.scratch, 'notes.txt')
    mkdirSync(fromFlag)
    mkdirSync(fromSettings)
    writeFileSync(aFile, 'x')
    scene.write('user', { permissions: { additionalDirectories: [fromSettings] } })

    const { toolPermissionContext, warnings } = await startUp({
      dirs: [fromFlag, join(scene.scratch, 'gone'), join(scene.checkout, '.claudin'), aFile],
    })

    expect([...toolPermissionContext.additionalWorkingDirectories.entries()]).toEqual([
      [fromSettings, { path: fromSettings, source: 'cliArg' }],
      [fromFlag, { path: fromFlag, source: 'cliArg' }],
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(aFile)
    expect(warnings[0]).toContain('is not a directory')
  })

  test('a repository can widen the working directories through its own settings', async () => {
    const outside = join(scene.scratch, 'outside-the-checkout')
    mkdirSync(outside)
    scene.write('project', { permissions: { additionalDirectories: [outside] } })
    const { toolPermissionContext } = await startUp()
    expect(toolPermissionContext.additionalWorkingDirectories.get(outside)).toEqual({ path: outside, source: 'cliArg' })
  })

  test('an empty --add-dir entry warns', async () => {
    const { warnings, toolPermissionContext } = await startUp({ dirs: [''] })
    expect(warnings).toHaveLength(1)
    expect(toolPermissionContext.additionalWorkingDirectories.size).toBe(0)
  })

  test('a PWD that is a symlink to the start directory joins as a session directory', async () => {
    const link = join(scene.scratch, 'link-to-checkout')
    symlinkSync(scene.checkout, link)
    process.env.PWD = link
    const { toolPermissionContext } = await startUp()
    expect([...toolPermissionContext.additionalWorkingDirectories.entries()]).toEqual([
      [link, { path: link, source: 'session' }],
    ])
  })

  const pwdCases: Array<[string, () => string | undefined]> = [
    ['equal to the start directory', () => scene.checkout],
    ['a plain other directory', () => scene.scratch],
    ['a symlink to somewhere else', () => {
      const link = join(scene.scratch, 'link-elsewhere')
      symlinkSync(join(scene.scratch, 'home'), link)
      return link
    }],
    ['unset', () => undefined],
  ]
  for (const [name, pwd] of pwdCases) {
    test(`a PWD ${name} adds nothing`, async () => {
      const value = pwd()
      if (value === undefined) delete process.env.PWD
      else process.env.PWD = value
      expect((await startUp()).toolPermissionContext.additionalWorkingDirectories.size).toBe(0)
    })
  }
})

describe('the bypass-permissions kill switch', () => {
  const layers: Layer[] = ['user', 'project', 'local', 'flag', 'managed']
  test('is off with no settings', () => {
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })
  for (const layer of layers) {
    test(`turns on from the ${layer} settings`, () => {
      scene.write(layer, { permissions: { disableBypassPermissionsMode: 'disable' } })
      expect(isBypassPermissionsModeDisabled()).toBe(true)
    })
  }

  const modes: Array<[PermissionMode, PermissionMode]> = [
    ['bypassPermissions', 'default'],
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'plan'],
    ['dontAsk', 'dontAsk'],
  ]
  for (const [from, to] of modes) {
    test(`revoking it from ${from} leaves ${to}, with bypass gone from the list`, () => {
      const before = context({ mode: from, isBypassPermissionsModeAvailable: true, alwaysAllowRules: { session: ['Read'] } })
      const after = createDisabledBypassPermissionsContext(before)
      expect(after).not.toBe(before)
      expect(after.mode).toBe(to)
      expect(after.isBypassPermissionsModeAvailable).toBe(false)
      expect(after.alwaysAllowRules).toEqual({ session: ['Read'] })
      expect(before.mode).toBe(from)
      expect(before.isBypassPermissionsModeAvailable).toBe(true)
    })
  }
})

describe('why auto mode is unavailable', () => {
  const texts: Array<[Parameters<typeof getAutoModeUnavailableNotification>[0], string]> = [
    ['settings', 'auto mode disabled by settings'],
    ['circuit-breaker', 'auto mode is unavailable for your plan'],
    ['model', 'auto mode unavailable for this model'],
  ]
  for (const [reason, text] of texts) {
    test(`the notice for "${reason}"`, () => {
      expect(getAutoModeUnavailableNotification(reason)).toBe(text)
    })
  }

  const switches: Array<[Layer, Record<string, unknown>]> = [
    ['user', { disableAutoMode: 'disable' }],
    ['project', { disableAutoMode: 'disable' }],
    ['local', { permissions: { disableAutoMode: 'disable' } }],
    ['flag', { disableAutoMode: 'disable' }],
    ['managed', { permissions: { disableAutoMode: 'disable' } }],
  ]
  for (const [layer, json] of switches) {
    test(`disableAutoMode in the ${layer} settings closes the gate and names settings`, () => {
      scene.write(layer, json)
      expect(isAutoModeGateEnabled()).toBe(false)
      expect(getAutoModeUnavailableReason()).toBe('settings')
    })
  }

  test('a model that is not cleared for it closes the gate and names the model', () => {
    scene.useModel('gpt-5.4')
    expect(isAutoModeGateEnabled()).toBe(false)
    expect(getAutoModeUnavailableReason()).toBe('model')
  })
})

describe('the shift+tab order', () => {
  const order: Array<[PermissionMode, boolean, PermissionMode]> = [
    ['default', false, 'acceptEdits'],
    ['default', true, 'acceptEdits'],
    ['acceptEdits', false, 'plan'],
    ['plan', false, 'default'],
    ['plan', true, 'bypassPermissions'],
    ['bypassPermissions', true, 'default'],
    ['dontAsk', false, 'default'],
    ['auto', false, 'default'],
  ]
  for (const [from, bypass, to] of order) {
    test(`${from}${bypass ? ' (bypass offered)' : ''} -> ${to}`, () => {
      const ctx = context({ mode: from, isBypassPermissionsModeAvailable: bypass, isAutoModeAvailable: false })
      expect(getNextPermissionMode(ctx)).toBe(to)
      expect(getNextPermissionMode(ctx, { leadAgentId: 'lead' })).toBe(to)
    })
  }

  test('cycling returns the next mode and the context prepared for it, without setting the mode', () => {
    const inPlan = context({ mode: 'plan', prePlanMode: 'acceptEdits', isAutoModeAvailable: false })
    const { nextMode, context: prepared } = cyclePermissionMode(inPlan)
    expect(nextMode).toBe('default')
    expect(prepared.mode).toBe('plan')
    expect(prepared.prePlanMode).toBeUndefined()
    expect(hasExitedPlanModeInSession()).toBe(true)
  })

  test('cycling between two plain modes hands back the same context', () => {
    const ctx = context({ mode: 'default' })
    const cycled = cyclePermissionMode(ctx)
    expect(cycled.nextMode).toBe('acceptEdits')
    expect(cycled.context).toBe(ctx)
  })
})

describe('a mode change', () => {
  test('to the same mode changes nothing', () => {
    setNeedsPlanModeExitAttachment(true)
    const ctx = context({ mode: 'plan', prePlanMode: 'default' })
    expect(transitionPermissionMode('plan', 'plan', ctx)).toBe(ctx)
    expect(needsPlanModeExitAttachment()).toBe(true)
    expect(hasExitedPlanModeInSession()).toBe(false)
  })

  test('leaving plan marks the exit and clears the remembered mode', () => {
    const ctx = context({ mode: 'plan', prePlanMode: 'acceptEdits' })
    const after = transitionPermissionMode('plan', 'acceptEdits', ctx)
    expect(after.prePlanMode).toBeUndefined()
    expect(after.mode).toBe('plan')
    expect(needsPlanModeExitAttachment()).toBe(true)
    expect(hasExitedPlanModeInSession()).toBe(true)
  })

  test('leaving plan with nothing remembered hands back the same context', () => {
    const ctx = context({ mode: 'plan' })
    expect(transitionPermissionMode('plan', 'default', ctx)).toBe(ctx)
  })

  test('entering plan withdraws a pending plan-exit notice', () => {
    setNeedsPlanModeExitAttachment(true)
    transitionPermissionMode('default', 'plan', context())
    expect(needsPlanModeExitAttachment()).toBe(false)
    expect(hasExitedPlanModeInSession()).toBe(false)
  })

  test('leaving auto queues the auto-exit notice', () => {
    transitionPermissionMode('auto', 'default', context({ mode: 'auto' }))
    expect(needsAutoModeExitAttachment()).toBe(true)
  })

  test('between two plain modes it hands back the same context', () => {
    setNeedsAutoModeExitAttachment(true)
    const ctx = context()
    expect(transitionPermissionMode('default', 'acceptEdits', ctx)).toBe(ctx)
    expect(needsAutoModeExitAttachment()).toBe(true)
  })
})

describe('the auto-mode flags a session carries', () => {
  const flags: Array<[string, (v: boolean) => void, () => boolean]> = [
    ['active', autoModeState.setAutoModeActive, autoModeState.isAutoModeActive],
    ['asked for on the command line', autoModeState.setAutoModeFlagCli, autoModeState.getAutoModeFlagCli],
    ['circuit broken', autoModeState.setAutoModeCircuitBroken, autoModeState.isAutoModeCircuitBroken],
  ]
  for (const [name, set, get] of flags) {
    test(`"${name}" starts false, holds what it is given, and resets`, () => {
      expect(get()).toBe(false)
      set(true)
      expect(get()).toBe(true)
      autoModeState._resetForTesting()
      expect(get()).toBe(false)
      set(true)
      set(false)
      expect(get()).toBe(false)
    })
  }

  test('the flags are independent of each other', () => {
    autoModeState.setAutoModeFlagCli(true)
    expect(autoModeState.isAutoModeActive()).toBe(false)
    expect(autoModeState.isAutoModeCircuitBroken()).toBe(false)
  })
})

if (!shipped) {
  describe('with TRANSCRIPT_CLASSIFIER off, auto mode cannot be reached', () => {
    test('no model clears the gate', () => {
      expect(isAutoModeGateEnabled()).toBe(false)
      expect(getAutoModeUnavailableReason()).toBe('model')
    })

    test('nothing reads as auto or opted in', () => {
      scene.write('user', { skipAutoPermissionPrompt: true })
      expect(isDefaultPermissionModeAuto()).toBe(false)
      expect(shouldPlanUseAutoMode()).toBe(false)
    })

    test('plan entry only remembers the mode, and plan reconciliation does nothing', () => {
      const ctx = context({ mode: 'auto', strippedDangerousRules: { session: ['Bash(*)'] } })
      expect(prepareContextForPlanMode(ctx)).toEqual({ ...ctx, prePlanMode: 'auto' })
      const inPlan = context({ mode: 'plan', prePlanMode: 'auto' })
      expect(transitionPlanAutoMode(inPlan)).toBe(inPlan)
    })

    test('a transition into auto is not refused', () => {
      const ctx = context()
      expect(transitionPermissionMode('default', 'auto', ctx)).toBe(ctx)
    })

    test('the startup check still moves a session out of auto, naming the model', async () => {
      const inAuto = context({ mode: 'auto', isAutoModeAvailable: true })
      const { updateContext, notification } = await verifyAutoModeGateAccess(inAuto)
      expect(notification).toBe('auto mode unavailable for this model')
      expect(updateContext(inAuto)).toMatchObject({ mode: 'default', isAutoModeAvailable: false })
      expect(needsAutoModeExitAttachment()).toBe(true)
    })

    test('the startup gate check never touches the app state', async () => {
      let calls = 0
      await checkAndDisableAutoModeIfNeeded(context({ mode: 'auto' }), () => {
        calls++
      })
      expect(calls).toBe(0)
    })
  })
}
