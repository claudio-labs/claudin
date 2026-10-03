/**
 * The auto-mode classifier as the shipped build runs it.
 *
 * The build turns TRANSCRIPT_CLASSIFIER and BASH_CLASSIFIER on, and `bun test`
 * folds every `feature()` to false. So under the plain runner this file's one
 * test re-runs the file in a child `bun test` with both flags on, and the
 * checks below run there; a failure in the child fails the parent with the
 * child's output.
 *
 * With the flags on, the classifier's barrel cannot be the first of these
 * modules a process loads: an import cycle through the permission engine
 * reads the classifier tool's name before it is initialized (see the spec's
 * findings). The child therefore loads the tool allowlist first.
 */
import { feature } from 'bun:bundle'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'

// `feature()` has to sit directly in a ternary: any other form throws under `bun test`.
const SHIPPED = feature('TRANSCRIPT_CLASSIFIER') ? true : false
const EXPECTED_IN_CHILD = 13

if (!SHIPPED) {
  test('holds in a fresh process built with the classifier flags on', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--feature=BASH_CLASSIFIER', import.meta.path],
      { cwd: join(import.meta.dir, '..', '..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
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

  test('with the flags off a mounted component never shows a check in progress', async () => {
    const approvals = await import('src/permissions/classifierApprovals.js')
    const { useIsClassifierChecking } = await import('src/permissions/classifierApprovalsHook.js')
    const { createRoot, BaseText } = await import('src/terminal/ink.js')
    const { createFakeTerminal } = await import('src/terminal/__testutils__/fakeTerminal.js')
    function Marker() {
      return <BaseText>{`checking=${String(useIsClassifierChecking('use-1'))}`}</BaseText>
    }
    const terminal = createFakeTerminal()
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
    try {
      root.render(<Marker />)
      for (let i = 0; i < 100 && !terminal.screen().includes('checking='); i++) await Bun.sleep(10)
      approvals.setClassifierChecking('use-1')
      approvals.clearClassifierApprovals()
      await Bun.sleep(30)
      expect(terminal.screen()).toContain('checking=false')
      expect(terminal.transcript()).not.toContain('checking=true')
    } finally {
      root.unmount()
      terminal.close()
    }
  })
} else {
  // Loaded first on purpose; see the header.
  const { isAutoModeAllowlistedTool } = await import('src/permissions/classifierDecision.js')

  const scene = await import('src/permissions/__testutils__/autoModeClassifierScene.js')
  const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
  const model = scene.createModelDouble()
  mock.module('src/agent/sideQuery.js', () => ({ ...realSideQueryModule, sideQuery: model.sideQuery }))

  const classifier = await import('src/permissions/yoloClassifier.js')
  const bash = await import('src/permissions/bashClassifier.js')
  const approvals = await import('src/permissions/classifierApprovals.js')
  const { useIsClassifierChecking } = await import('src/permissions/classifierApprovalsHook.js')
  const denials = await import('src/permissions/autoModeDenials.js')
  const { resetSettingsCache } = await import('src/platform/settings/settingsCache.js')
  const { createRoot, BaseText } = await import('src/terminal/ink.js')
  const { createFakeTerminal } = await import('src/terminal/__testutils__/fakeTerminal.js')

  const stage = scene.useClassifierScene()

  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
    approvals.clearClassifierApprovals()
  })

  beforeEach(() => {
    model.reset()
    writeFileSync(join(stage().configDir, 'settings.json'), '{}')
    resetSettingsCache()
  })

  const judge = (mode = 'auto') =>
    classifier.classifyYoloAction(
      [scene.userSays('tidy the repo')],
      classifier.formatActionForClassifier('Bash', { command: 'git clean -fdx' }),
      scene.toolbox(scene.shellTool),
      scene.permissionContext({ mode }),
      new AbortController().signal,
    )

  describe('the bundled prompt', () => {
    test('is bundled, and every section of its template carries defaults', () => {
      expect(classifier.isClassifierBundled()).toBe(true)
      const rules = classifier.getDefaultExternalAutoModeRules()
      expect(rules.allow.length).toBeGreaterThan(0)
      expect(rules.soft_deny.length).toBeGreaterThan(0)
      expect(rules.environment.length).toBeGreaterThan(0)
    })

    test('assembles with no placeholder left and every default in place', async () => {
      const prompt = classifier.buildDefaultExternalSystemPrompt()
      expect(prompt).not.toContain('<permissions_template>')
      expect(prompt).not.toMatch(/<\/?user_\w+_to_replace>/)
      expect(prompt).toContain('Use the classify_result tool to report your classification.')
      const rules = classifier.getDefaultExternalAutoModeRules()
      for (const rule of [...rules.allow, ...rules.soft_deny, ...rules.environment]) expect(prompt).toContain(`- ${rule}`)
      expect(await classifier.buildYoloSystemPrompt(scene.permissionContext())).toBe(prompt)
    })

    test("the user's settings replace or extend each section", async () => {
      writeFileSync(
        join(stage().configDir, 'settings.json'),
        JSON.stringify({
          autoMode: {
            allow: ['run make lint'],
            soft_deny: ['$defaults', 'touch the production database'],
            environment: [],
          },
        }),
      )
      resetSettingsCache()
      const defaults = classifier.getDefaultExternalAutoModeRules()
      const prompt = await classifier.buildYoloSystemPrompt(scene.permissionContext())

      expect(prompt).toContain('- run make lint')
      for (const rule of defaults.allow) expect(prompt).not.toContain(`- ${rule}\n`)
      const denyBullets = [...defaults.soft_deny, 'touch the production database'].map(rule => `- ${rule}`).join('\n')
      expect(prompt).toContain(denyBullets)
      for (const rule of defaults.environment) expect(prompt).toContain(`- ${rule}`)

      const planned = await classifier.buildYoloSystemPrompt(scene.permissionContext({ mode: 'plan' }))
      expect(planned).toContain('- run make lint\n- Plan mode is active: ')
    })

    test('Bash prompt rules stay out of it even with the Bash classifier built in', async () => {
      const context = scene.permissionContext({
        allow: ['Bash(prompt: anything under /srv)'],
        deny: ['Bash(prompt: reading ~/.ssh)'],
      })
      const prompt = await classifier.buildYoloSystemPrompt(context)
      expect(prompt).not.toContain('anything under /srv')
      expect(prompt).not.toContain('reading ~/.ssh')
    })

    test('the XML route swaps the tool instruction of the real prompt for the tag format', async () => {
      stage().useModel('claude-fable-5')
      model.queue(scene.says('<block>no</block>'))
      expect((await judge()).shouldBlock).toBe(false)
      const sent = scene.systemText(model.sent[0]!)
      expect(sent).not.toContain('Use the classify_result tool')
      expect(sent).toContain('<block>yes</block><reason>')

      stage().useModel('claude-sonnet-4-6')
      model.queue(scene.callsTool('classify_result', { thinking: 't', shouldBlock: true, reason: 'wipes untracked files' }))
      expect(await judge()).toMatchObject({ shouldBlock: true, reason: 'wipes untracked files' })
      expect(scene.systemText(model.sent[1]!)).toContain('Use the classify_result tool to report your classification.')
    })

    test('the classifier tool itself is on the skip list', () => {
      expect(isAutoModeAllowlistedTool(classifier.YOLO_CLASSIFIER_TOOL_NAME)).toBe(true)
    })
  })

  describe('approvals the UI reads back', () => {
    test('a Bash rule approval and an auto-mode approval are kept apart by kind', () => {
      approvals.setClassifierApproval('bash-1', 'Bash(prompt: run tests)')
      approvals.setYoloClassifierApproval('auto-1', 'only lists files')
      expect(approvals.getClassifierApproval('bash-1')).toBe('Bash(prompt: run tests)')
      expect(approvals.getYoloClassifierApproval('auto-1')).toBe('only lists files')
      expect(approvals.getYoloClassifierApproval('bash-1')).toBeUndefined()
      expect(approvals.getClassifierApproval('auto-1')).toBeUndefined()
      expect(approvals.getClassifierApproval('nobody')).toBeUndefined()

      approvals.setYoloClassifierApproval('bash-1', 'now auto')
      expect(approvals.getClassifierApproval('bash-1')).toBeUndefined()
      expect(approvals.getYoloClassifierApproval('bash-1')).toBe('now auto')

      approvals.deleteClassifierApproval('bash-1')
      expect(approvals.getYoloClassifierApproval('bash-1')).toBeUndefined()
      approvals.clearClassifierApprovals()
      expect(approvals.getYoloClassifierApproval('auto-1')).toBeUndefined()
    })

    test('the checking marker notifies on every change and is wiped with the approvals', () => {
      let notified = 0
      const unsubscribe = approvals.subscribeClassifierChecking(() => notified++)
      try {
        approvals.setClassifierChecking('use-1')
        expect(approvals.isClassifierChecking('use-1')).toBe(true)
        expect(approvals.isClassifierChecking('use-2')).toBe(false)
        expect(notified).toBe(1)
        approvals.clearClassifierChecking('use-1')
        expect(approvals.isClassifierChecking('use-1')).toBe(false)
        expect(notified).toBe(2)

        approvals.setClassifierChecking('use-3')
        approvals.clearClassifierApprovals()
        expect(approvals.isClassifierChecking('use-3')).toBe(false)
        expect(notified).toBe(4)
      } finally {
        unsubscribe()
      }
      approvals.setClassifierChecking('use-4')
      expect(notified).toBe(4)
      approvals.clearClassifierApprovals()
    })

    test('a mounted component follows the checking marker of its tool use', async () => {
      function Marker({ id }: { id: string }) {
        return <BaseText>{`checking=${String(useIsClassifierChecking(id))}`}</BaseText>
      }
      const terminal = createFakeTerminal()
      const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false })
      const shows = async (text: string) => {
        for (let i = 0; i < 100 && !terminal.screen().includes(text); i++) await Bun.sleep(10)
        return terminal.screen()
      }
      try {
        root.render(<Marker id="use-9" />)
        expect(await shows('checking=false')).toContain('checking=false')
        approvals.setClassifierChecking('use-9')
        expect(await shows('checking=true')).toContain('checking=true')
        approvals.setClassifierChecking('use-other')
        approvals.clearClassifierChecking('use-9')
        expect(await shows('checking=false')).toContain('checking=false')
      } finally {
        root.unmount()
        terminal.close()
        approvals.clearClassifierApprovals()
      }
    })
  })

  describe('recent denials', () => {
    test('the newest come first and only the last 20 are kept', () => {
      for (let i = 1; i <= 22; i++) {
        denials.recordAutoModeDenial({ toolName: 'Bash', display: `cmd ${i}`, reason: `r${i}`, timestamp: i })
      }
      const kept = denials.getAutoModeDenials()
      expect(kept).toHaveLength(20)
      expect(kept[0]).toEqual({ toolName: 'Bash', display: 'cmd 22', reason: 'r22', timestamp: 22 })
      expect(kept.at(-1)!.display).toBe('cmd 3')
    })

    test('each record yields a new list; a list already handed out does not change', () => {
      const before = denials.getAutoModeDenials()
      const snapshot = [...before]
      denials.recordAutoModeDenial({ toolName: 'Edit', display: 'x', reason: 'y', timestamp: 99 })
      expect(denials.getAutoModeDenials()).not.toBe(before)
      expect(before).toEqual(snapshot)
      expect(denials.getAutoModeDenials()[0]!.toolName).toBe('Edit')
    })
  })

  describe('the Bash prompt-rule classifier', () => {
    test('is on in the build without any test switch', async () => {
      bash.__setBashClassifierEnabledForTests(undefined)
      expect(bash.isClassifierPermissionsEnabled()).toBe(true)
      model.queue(scene.callsTool('classify_match', { matchedIndex: 0, confidence: 'high', reason: 'lists remotes' }))
      const result = await bash.classifyBashCommand('git remote -v', '/w', ['list git remotes'], 'allow', new AbortController().signal, true)
      expect(result).toEqual({ matches: true, matchedDescription: 'list git remotes', confidence: 'high', reason: 'lists remotes' })
    })

    test('generalizes a command through the model', async () => {
      model.queue(scene.callsTool('propose_description', { description: 'list git remotes' }))
      expect(await bash.generateGenericDescription('git remote -v', undefined, new AbortController().signal)).toBe('list git remotes')
    })
  })
}
