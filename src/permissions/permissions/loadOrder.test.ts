/**
 * Fix 1 of the decision spec: the decision module reaches the auto-mode
 * classifier and its allowlist when it decides, not when it loads. Loading
 * them eagerly broke any run that imported the classifier first, because the
 * allowlist read the classifier's tool name before it was initialised.
 *
 * The hazard only exists with the auto-mode build flag, so under plain
 * `bun test` this file reruns itself in a child with the flags on.
 */
// Order matters: the classifier first, then the decision module.
import 'src/permissions/yoloClassifier.js'
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  ASSISTANT_TURN,
  makeCtx,
  standIn,
  useDecisionWorld,
} from 'src/permissions/__testutils__/decisionWorld.js'

if (!feature('TRANSCRIPT_CLASSIFIER')) {
  test('with the auto-mode flags on, the classifier may load before the decision', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--feature=BASH_CLASSIFIER', import.meta.path],
      { cwd: resolve(import.meta.dir, '..', '..', '..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    expect({ code, passed: /(\d+) pass/.exec(report)?.[1], failed: /(\d+) fail/.exec(report)?.[1] }).toEqual({
      code: 0,
      passed: '1',
      failed: '0',
    })
  }, 120_000)
} else {
  useDecisionWorld()

  test('a decision that needs the allowlist works after the classifier loaded first', async () => {
    const read = standIn({ name: 'Read', verdict: { behavior: 'ask', message: 'm' } })
    const decision = await hasPermissionsToUseTool(
      read,
      { file_path: '/x' },
      makeCtx({ tools: [read], permissions: { mode: 'auto' } }),
      ASSISTANT_TURN,
      'toolu_load_order',
    )
    expect([decision.behavior, decision.decisionReason]).toEqual(['allow', { type: 'mode', mode: 'auto' }])
  })
}
