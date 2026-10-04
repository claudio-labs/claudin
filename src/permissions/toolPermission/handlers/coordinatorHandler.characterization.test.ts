/**
 * The coordinator route: before a coordinator worker shows its dialog, the
 * automated checks are awaited in turn, and only a decision from them
 * answers the request. Everything else falls through to the dialog.
 *
 * Driven with real PermissionRequest hook commands in a temp world. The Bash
 * classifier step is built only with BASH_CLASSIFIER, so it is pinned in
 * toolPermission.classifiers.characterization.test.tsx.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { handleCoordinatorPermission } from 'src/permissions/toolPermission/handlers/coordinatorHandler.js'
import { createPermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
import { contextSink, hookSays, openSession, TURN, type SessionSpec } from 'src/permissions/toolPermission/__testutils__/routeWorld.js'
import { getInMemoryErrors } from 'src/shared/log.js'

const world = useDecisionWorld()
const INPUT = { command: 'make deploy' }
// The error log keeps entries only when error reporting is on and
// nonessential traffic is explicitly allowed.
const REPORTING_ENV = ['DISABLE_ERROR_REPORTING', 'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC'] as const
const savedReporting = REPORTING_ENV.map(name => [name, process.env[name]] as const)
afterEach(() => {
  for (const [name, value] of savedReporting) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function coordinator(spec: SessionSpec = {}, params: { updatedInput?: Record<string, unknown>; suggestions?: PermissionUpdate[]; mode?: string } = {}) {
  const session = openSession(spec)
  const sink = contextSink()
  const ctx = createPermissionContext(standIn({ name: 'Bash' }), INPUT, session, TURN, 'toolu_coord', sink.set)
  const decision = handleCoordinatorPermission({
    ctx,
    updatedInput: params.updatedInput,
    suggestions: params.suggestions,
    permissionMode: params.mode ?? 'default',
  })
  return { decision, session, sink }
}

describe('what the automated checks can settle', () => {
  test('a hook allow answers the request, with the rewritten input when the hook gives none', async () => {
    const { decision } = coordinator(
      { hooks: [world().script(hookSays({ behavior: 'allow' }))] },
      { updatedInput: { command: 'make deploy --dry-run' } },
    )
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'make deploy --dry-run' },
      userModified: false,
      decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
    })
  })

  test('a hook deny answers the request', async () => {
    const { decision, session } = coordinator({ hooks: [world().script(hookSays({ behavior: 'deny', message: 'frozen' }))] })
    expect(await decision).toEqual({
      behavior: 'deny',
      message: 'frozen',
      decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason: 'frozen' },
    })
    expect(session.toolDecisions?.get('toolu_coord')?.source).toBe('hook')
  })

  test('the hooks are given the mode and the suggestions', async () => {
    const w = world()
    const log = `${w.root}/coord.json`
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]
    const { decision } = coordinator({ hooks: [w.script(`printf '%s' "$input" > '${log}'`)] }, { suggestions, mode: 'plan' })
    await decision
    const seen = JSON.parse(readFileSync(log, 'utf8'))
    expect([seen.permission_mode, seen.permission_suggestions]).toEqual(['plan', suggestions])
  })
})

describe('falling through to the dialog', () => {
  test('no hook: no decision', async () => {
    const { decision } = coordinator()
    expect(await decision).toBeNull()
  })

  test('a hook with nothing to say: no decision', async () => {
    const { decision, session } = coordinator({ hooks: [world().script('true')] })
    expect(await decision).toBeNull()
    expect(session.toolDecisions?.get('toolu_coord')).toBeUndefined()
  })

  // The log keeps the last hundred entries, so each case looks for a token of its own.
  const failures: Array<[string, (token: string) => unknown, (token: string) => string]> = [
    ['an error', token => new Error(`state is gone ${token}`), token => `state is gone ${token}`],
    ['a thrown string', token => `state is gone ${token}`, token => `Automated permission check failed: state is gone ${token}`],
  ]
  test.each(failures)('checks that fail with %s fall through and are logged', async (_name, makeThrown, logged) => {
    delete process.env.DISABLE_ERROR_REPORTING
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    const token = crypto.randomUUID()
    const session = openSession({ hooks: [world().script(hookSays({ behavior: 'allow' }))] })
    const broken = {
      ...session,
      getAppState: () => {
        throw makeThrown(token)
      },
    }
    const ctx = createPermissionContext(standIn({ name: 'Bash' }), INPUT, broken as never, TURN, 'toolu_coord', () => {})
    const got = await handleCoordinatorPermission({ ctx, updatedInput: undefined, suggestions: undefined, permissionMode: 'default' })
    expect(got).toBeNull()
    expect(getInMemoryErrors().some(e => e.error.includes(logged(token)))).toBe(true)
  })
})
