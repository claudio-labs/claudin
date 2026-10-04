/**
 * What the characterization suites do not reach: the nested-parenthesis fix
 * (finding 3), the start-mode picker and the start-context builder driven
 * through their inputs, and the order of a refused entry into auto.
 *
 * The flagged block needs TRANSCRIPT_CLASSIFIER; under the plain runner this
 * file also starts a flagged child run of itself.
 */
import { describe, expect, test } from 'bun:test'
import type { AddDirectoryResult } from 'src/commands/add-dir/validation.js'
import {
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'
import * as autoModeState from 'src/permissions/autoModeState.js'
import {
  initializeToolPermissionContext,
  parseToolListFromCLI,
  shouldPlanUseAutoMode,
  transitionPermissionMode,
} from 'src/permissions/permissionSetup.js'
import { delegateToShippedBuild, shipped } from 'src/permissions/permissionSetup/__testutils__/shippedFlag.js'
import { usePermissionScene } from 'src/permissions/permissionSetup/__testutils__/permissionScene.js'
import { AutoModeGateClosedError } from 'src/permissions/permissionSetup/modeTransition.js'
import { type StartModeInputs, pickStartMode } from 'src/permissions/permissionSetup/startup/startMode.js'
import {
  type StartContextInputs,
  buildStartContext,
} from 'src/permissions/permissionSetup/startup/startContext.js'

const scene = usePermissionScene()

describe('nested parentheses on the command line (finding 3)', () => {
  const lists: Array<[string, string[], string[]]> = [
    ['a space after an inner group', ['Bash(f(x) y)'], ['Bash(f(x) y)']],
    ['a comma after an inner group', ['Bash(f(x), y),Read'], ['Bash(f(x), y)', 'Read']],
    ['two levels deep', ['Bash(a(b(c) d) e) Read'], ['Bash(a(b(c) d) e)', 'Read']],
    ['a stray closer outside any group', ['Read) Write'], ['Read)', 'Write']],
    ['other whitespace is trimmed, not split on', ['Read\t,\nWrite'], ['Read', 'Write']],
  ]
  for (const [name, input, expected] of lists) {
    test(name, () => {
      expect(parseToolListFromCLI(input)).toEqual(expected)
    })
  }

  test('a deny rule with an inner group stays one deny rule', async () => {
    const { toolPermissionContext } = await initializeToolPermissionContext({
      allowedToolsCli: [],
      disallowedToolsCli: ['Bash(f(x) y)'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      addDirs: [],
    })
    expect(toolPermissionContext.alwaysDenyRules.cliArg).toEqual(['Bash(f(x) y)'])
  })
})

describe('picking the start mode', () => {
  const none: StartModeInputs = {
    skipPermissions: false,
    modeFlag: undefined,
    settingsDefaultMode: undefined,
    remote: false,
    bypassKilled: false,
  }
  const rows: Array<[string, Partial<StartModeInputs>, ReturnType<typeof pickStartMode>]> = [
    ['nothing asked', {}, { mode: 'default', bypassRefused: false }],
    ['an empty --permission-mode counts as absent', { modeFlag: '', settingsDefaultMode: 'plan' }, { mode: 'plan', bypassRefused: false }],
    ['every bypass candidate is skipped by the kill switch', { skipPermissions: true, modeFlag: 'bypassPermissions', settingsDefaultMode: 'bypassPermissions', bypassKilled: true }, { mode: 'default', bypassRefused: true }],
    ['a refusal still lets a later candidate win', { skipPermissions: true, settingsDefaultMode: 'acceptEdits', bypassKilled: true }, { mode: 'acceptEdits', bypassRefused: true }],
    ['remote drops a settings bypass but not the flag', { remote: true, skipPermissions: true, settingsDefaultMode: 'bypassPermissions' }, { mode: 'bypassPermissions', bypassRefused: false }],
    ['remote drops a settings dontAsk', { remote: true, settingsDefaultMode: 'dontAsk' }, { mode: 'default', bypassRefused: false }],
  ]
  for (const [name, over, expected] of rows) {
    test(name, () => {
      expect(pickStartMode({ ...none, ...over })).toEqual(expected)
    })
  }
})

describe('building the start context from its inputs', () => {
  const inputs = (over: Partial<StartContextInputs> = {}): StartContextInputs => ({
    mode: 'default',
    cliAllowRules: [],
    cliDenyRules: [],
    rulesFromDisk: [],
    bypassOffered: false,
    autoOffered: undefined,
    extraDirectories: [],
    symlinkedPwd: undefined,
    ...over,
  })
  const verdicts: Record<string, AddDirectoryResult> = {
    '/outer': { resultType: 'success', absolutePath: '/outer' },
    '/outer/inner': { resultType: 'success', absolutePath: '/outer/inner' },
    '/missing': { resultType: 'pathNotFound', directoryPath: '/missing', absolutePath: '/missing' },
    '/covered': { resultType: 'alreadyInWorkingDirectory', directoryPath: '/covered', workingDir: '/' },
    '/a-file': { resultType: 'notADirectory', directoryPath: '/a-file', absolutePath: '/a-file' },
    '': { resultType: 'emptyPath' },
  }
  /** Rejects a path inside one already added, the way the real check does. */
  async function validateDirectory(path: string, context: ToolPermissionContext): Promise<AddDirectoryResult> {
    for (const added of context.additionalWorkingDirectories.keys()) {
      if (path.startsWith(`${added}/`)) return { resultType: 'alreadyInWorkingDirectory', directoryPath: path, workingDir: added }
    }
    return verdicts[path]!
  }
  const deps = { validateDirectory, explainRejection: (r: AddDirectoryResult) => `rejected:${r.resultType}` }

  test('each directory is checked against those added before it', async () => {
    const { context } = await buildStartContext(inputs({ extraDirectories: ['/outer', '/outer/inner'] }), deps)
    expect([...context.additionalWorkingDirectories.keys()]).toEqual(['/outer'])
  })

  test('missing and covered directories are silent; a file and an empty entry warn', async () => {
    const { context, warnings } = await buildStartContext(
      inputs({ extraDirectories: ['/missing', '/covered', '/a-file', ''] }),
      deps,
    )
    expect(context.additionalWorkingDirectories.size).toBe(0)
    expect(warnings).toEqual(['rejected:notADirectory', 'rejected:emptyPath'])
  })

  test('a symlinked PWD joins last, as a session directory', async () => {
    const { context } = await buildStartContext(inputs({ extraDirectories: ['/outer'], symlinkedPwd: '/link' }), deps)
    expect([...context.additionalWorkingDirectories.values()]).toEqual([
      { path: '/outer', source: 'cliArg' },
      { path: '/link', source: 'session' },
    ])
  })

  const offers: Array<[boolean | undefined, boolean]> = [[undefined, false], [false, true], [true, true]]
  for (const [autoOffered, present] of offers) {
    test(`isAutoModeAvailable is ${present ? 'set' : 'absent'} when the offer is ${autoOffered}`, async () => {
      const { context } = await buildStartContext(inputs({ autoOffered }), deps)
      expect('isAutoModeAvailable' in context).toBe(present)
      expect(context.isAutoModeAvailable).toBe(autoOffered)
    })
  }
})

if (!shipped) {
  delegateToShippedBuild(import.meta.path)
} else {
  describe('a refused entry into auto', () => {
    test('throws a typed error before any notice or flag moves', () => {
      scene.write('user', { disableAutoMode: 'disable' })
      setNeedsAutoModeExitAttachment(true)
      setNeedsPlanModeExitAttachment(true)
      const ctx = { ...getEmptyToolPermissionContext(), mode: 'plan' as const }
      expect(() => transitionPermissionMode('plan', 'auto', ctx)).toThrow(AutoModeGateClosedError)
      expect(needsAutoModeExitAttachment()).toBe(true)
      expect(needsPlanModeExitAttachment()).toBe(true)
      expect(autoModeState.isAutoModeActive()).toBe(false)
    })
  })

  describe('plan borrowing auto', () => {
    test('a trusted layer that exists but says nothing does not opt in, whatever the repository says', () => {
      scene.write('user', { permissions: {} })
      scene.write('project', { skipAutoPermissionPrompt: true })
      expect(shouldPlanUseAutoMode()).toBe(false)
    })
  })
}
