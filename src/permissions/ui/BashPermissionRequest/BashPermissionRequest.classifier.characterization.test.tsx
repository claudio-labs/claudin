/**
 * The part of the Bash permission dialog that only exists with BASH_CLASSIFIER
 * on (the shipped build): the line under the title that follows the Bash
 * classifier, the locked list once it approved, and Esc dismissing that
 * checkmark. The spec is docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * `bun test` folds every build flag to false, so under the plain runner this
 * file only starts a child `bun test --feature=BASH_CLASSIFIER` of itself and
 * fails with the child's report. In the child, the dialog also asks a model
 * for a rule description; that call is the one boundary replaced.
 */
import { feature } from 'bun:bundle'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { dirname, join } from 'node:path'

const classifierBuild: boolean = feature('BASH_CLASSIFIER') ? true : false

if (!classifierBuild) {
  test('passes again in a child run with BASH_CLASSIFIER on', async () => {
    const checkout = join(dirname(import.meta.path), '..', '..', '..', '..')
    const child = Bun.spawn([process.execPath, 'test', '--feature=BASH_CLASSIFIER', import.meta.path], {
      cwd: checkout,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '1')
    if (exit !== 0 || failed !== 0 || passed === 0) throw new Error(`the flagged run did not pass (exit ${exit}):\n${report}`)
    expect(passed).toBeGreaterThan(0)
  }, 180_000)
} else {
  const realSideQuery = { ...(await import('src/agent/sideQuery.js')) }
  mock.module('src/agent/sideQuery.js', () => ({
    ...realSideQuery,
    sideQuery: async () => ({ content: [{ type: 'text', text: 'no proposal' }] }),
  }))
  afterAll(() => {
    mock.module('src/agent/sideQuery.js', () => realSideQuery)
  })
  await classifierSuite()
}

async function classifierSuite(): Promise<void> {
  const { BashTool } = await import('src/tools/BashTool/BashTool.js')
  const rig = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
  const dialogs = await import('src/permissions/ui/__testutils__/toolDialogRig.js')
  type Tool = import('src/tools/Tool.js').Tool

  rig.isolatedWorld()
  const { enter, esc } = rig.KEYS
  const INPUT = { command: 'npm run build' }
  const askWith = (confirm: Record<string, unknown>) =>
    dialogs.ask({
      tool: BashTool as unknown as Tool,
      input: INPUT,
      permissionResult: { behavior: 'ask', message: 'asking', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' }] } as never,
      confirm,
    })
  /** The line right under the title. */
  const subtitle = (frame: string) => dialogs.shown(frame)[2]

  describe('classifier build: the line under the title', () => {
    test(
      'approved by a rule: a tick, "Auto-approved" and the rule it matched',
      async () => {
        const asked = await askWith({ classifierAutoApproved: true, classifierMatchedRule: 'run the build' })
        expect(subtitle(asked.screen.text())).toBe('✔ Auto-approved · matched "run the build"')
      },
      rig.SLOW,
    )

    test(
      'approved with no rule named: the tick and "Auto-approved" alone',
      async () => {
        const asked = await askWith({ classifierAutoApproved: true })
        expect(subtitle(asked.screen.text())).toBe('✔ Auto-approved')
      },
      rig.SLOW,
    )

    test(
      'while the classifier runs, "Attempting to auto-approve…"; once it gives up, "Requires manual approval"',
      async () => {
        const asked = await askWith({ classifierCheckInProgress: true })
        expect(subtitle(asked.screen.text())).toBe('Attempting to auto-approve…')
        await asked.update({ classifierCheckInProgress: false })
        await asked.screen.until(frame => subtitle(frame) === 'Requires manual approval', 'the manual-approval line')
        expect(await dialogs.answer(asked, ['1'])).toEqual(dialogs.allowed(INPUT, [], undefined))
      },
      rig.SLOW,
    )

    test(
      'never checked: no line, the command follows the title',
      async () => {
        const asked = await askWith({})
        expect(subtitle(asked.screen.text())).toBe('npm run build')
        await asked.update({ classifierCheckInProgress: false })
        expect(subtitle(asked.screen.text())).toBe('npm run build')
      },
      rig.SLOW,
    )
  })

  describe('classifier build: answering after an approval', () => {
    test(
      'the list is locked: digits and Enter do nothing',
      async () => {
        const asked = await askWith({ classifierAutoApproved: true })
        expect(await dialogs.answer(asked, ['1', '2', '3', enter])).toEqual([])
      },
      rig.SLOW,
    )

    test(
      'Esc dismisses the checkmark and neither allows nor denies',
      async () => {
        let dismissed = 0
        const asked = await askWith({ classifierAutoApproved: true, onDismissCheckmark: () => dismissed++ })
        expect(await dialogs.answer(asked, [esc])).toEqual([])
        expect(dismissed).toBe(1)
        expect(asked.screen.state().attribution.escapeCount).toBe(0)
      },
      rig.SLOW,
    )

    test(
      'without an approval, Esc is the usual deny and the checkmark is left alone',
      async () => {
        let dismissed = 0
        const asked = await askWith({ onDismissCheckmark: () => dismissed++ })
        expect(await dialogs.answer(asked, [esc])).toEqual(dialogs.denied())
        expect(dismissed).toBe(0)
      },
      rig.SLOW,
    )

    test(
      'without an approval, Esc over the decision details (no list on screen) does nothing at all',
      async () => {
        let dismissed = 0
        const asked = await askWith({ onDismissCheckmark: () => dismissed++ })
        expect(await dialogs.answer(asked, ['\x04', esc])).toEqual([])
        expect(dismissed).toBe(0)
      },
      rig.SLOW,
    )

    test(
      'the classifier build offers the same three options, and allow-always saves the same local prefix rule',
      async () => {
        const asked = await askWith({})
        await Bun.sleep(250)
        expect(dialogs.shown(asked.screen.text()).filter(line => /^(❯ )?\d\./.test(line))).toEqual([
          '❯ 1. Yes',
          '2. Yes, and don’t ask again for: npm run:*',
          '3. No',
        ])
        expect(await dialogs.answer(asked, ['2'])).toEqual(dialogs.allowed(INPUT, [dialogs.allowRule('Bash', 'npm run:*')]))
      },
      rig.SLOW,
    )
  })
}
