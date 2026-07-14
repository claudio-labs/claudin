import { test, expect, describe } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../cwd.js'
import { getPlanFilePath, getPlansDirectory, setPlanSlug } from '../plans.js'
import { getSessionId } from '../../bootstrap/state.js'
import { checkEditableInternalPath } from './filesystem.js'

// Regression coverage for the plan-mode "Only the plan file may be edited"
// denial: a plan-file write must be recognized (behavior 'allow') even when
// the session's cached plan slug drifts from the slug embedded in the path
// the model writes. Without this, FileWrite/FileEdit/apply_patch to the plan
// file all get hard-denied by the plan-mode gate and the model is locked out
// of its own plan file.
describe('isSessionPlanFile (via checkEditableInternalPath)', () => {
  function inFreshProject<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'plan-perm-'))
    return runWithCwdOverride(root, () => fn(root))
  }

  test('allows a write to the current-slug plan file', () => {
    inFreshProject(() => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const planPath = getPlanFilePath()
      const decision = checkEditableInternalPath(planPath, {
        file_path: planPath,
        content: 'x',
      })
      expect(decision.behavior).toBe('allow')
    })
  })

  test('allows the plan file even when getPlanSlug() has drifted (regression)', () => {
    inFreshProject(() => {
      // Runtime slug cache holds a freshly generated slug, but the model was
      // told / remembers a path with a different slug.
      setPlanSlug(getSessionId(), 'some-other-generated-slug')
      const drifted = join(
        getPlansDirectory(),
        'unified-rolling-ritchie.md',
      )
      const decision = checkEditableInternalPath(drifted, {
        file_path: drifted,
        content: 'x',
      })
      expect(decision.behavior).toBe('allow')
    })
  })

  test('allows an agent-scoped plan file in the plans dir', () => {
    inFreshProject(() => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const agentPlan = join(
        getPlansDirectory(),
        'unified-rolling-ritchie-agent-abc123.md',
      )
      const decision = checkEditableInternalPath(agentPlan, {
        file_path: agentPlan,
        content: 'x',
      })
      expect(decision.behavior).toBe('allow')
    })
  })

  test('does NOT allow a subdirectory file under the plans dir', () => {
    inFreshProject(() => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const nested = join(getPlansDirectory(), 'sub', 'evil.md')
      const decision = checkEditableInternalPath(nested, {
        file_path: nested,
        content: 'x',
      })
      expect(decision.behavior).toBe('passthrough')
    })
  })

  test('does NOT allow a .md file outside the plans dir', () => {
    inFreshProject(root => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const outside = join(root, 'not-a-plan.md')
      const decision = checkEditableInternalPath(outside, {
        file_path: outside,
        content: 'x',
      })
      expect(decision.behavior).toBe('passthrough')
    })
  })

  test('does NOT allow a traversal escape from the plans dir', () => {
    inFreshProject(() => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const escape = join(getPlansDirectory(), '..', '..', 'escape.md')
      const decision = checkEditableInternalPath(escape, {
        file_path: escape,
        content: 'x',
      })
      expect(decision.behavior).toBe('passthrough')
    })
  })
})
