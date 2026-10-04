/**
 * The classifier reason in the debug panel exists only in a build with
 * BASH_CLASSIFIER or TRANSCRIPT_CLASSIFIER on; the shipped build has both,
 * plain `bun test` has neither. Under the plain runner this file starts itself
 * again once per flag, each child with only that flag, and fails if a child
 * does.
 */
// With the classifier flags on, the decision module has to load before the
// classifier modules, or an import cycle trips.
import 'src/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const EITHER_FLAG = feature('BASH_CLASSIFIER') ? true : feature('TRANSCRIPT_CLASSIFIER') ? true : false

if (!EITHER_FLAG) {
  for (const flag of ['BASH_CLASSIFIER', 'TRANSCRIPT_CLASSIFIER']) {
    test(`with only ${flag} on, a classifier reason names the classifier`, async () => {
      const child = Bun.spawn([process.execPath, 'test', `--feature=${flag}`, import.meta.path], {
        cwd: resolve(import.meta.dir, '..', '..', '..'),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const report = `${out}\n${err}`
      const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
      const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
      if (code !== 0 || failed !== 0 || passed < 2) {
        throw new Error(`the ${flag} run failed (exit ${code}, ${passed} passed):\n${report.slice(-6_000)}`)
      }
    }, 120_000)
  }
} else {
  const React = await import('react')
  const rig = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
  const { PermissionDecisionDebugInfo } = await import('src/permissions/ui/PermissionDecisionDebugInfo.js')
  type Result = React.ComponentProps<typeof PermissionDecisionDebugInfo>['permissionResult']

  rig.isolatedWorld()
  rig.withTruecolor()

  const show = async (result: Result) => {
    const screen = await rig.mount(<PermissionDecisionDebugInfo permissionResult={result} />, { columns: 120 })
    await Bun.sleep(50)
    return screen
  }

  describe('a classifier reason', () => {
    test('reads "<name> classifier: <reason>" with the name in bold', async () => {
      const screen = await show({
        behavior: 'ask',
        message: 'm',
        decisionReason: { type: 'classifier', classifier: 'wren-gate', reason: 'matched a prompt rule' },
      })
      const row = rig.linesOf(screen.text()).find(line => line.includes('Reason'))
      expect(row).toBe('   Reason wren-gate classifier: matched a prompt rule')
      expect(rig.styleBefore(screen.styled(), 'wren-gate')).toContain('\u001B[1m')
      expect(rig.styleBefore(screen.styled(), ' classifier:')).not.toContain('\u001B[1m')
    }, rig.SLOW)

    test('inside a compound command too', async () => {
      const screen = await show({
        behavior: 'ask',
        message: 'm',
        decisionReason: {
          type: 'subcommandResults',
          reasons: new Map([
            ['npm publish', { behavior: 'ask', message: 'x', decisionReason: { type: 'classifier', classifier: 'wren-gate', reason: 'publishes' } }],
          ]),
        },
      })
      expect(screen.text()).toContain('⎿  wren-gate classifier: publishes')
    }, rig.SLOW)
  })
}
