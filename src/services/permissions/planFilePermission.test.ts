import { test, expect, describe } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getPlansDirectory, setPlanSlug } from 'src/agent/plans/plans.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { checkEditableInternalPath } from 'src/services/permissions/filesystem.js'

// Regression coverage for the plan-mode "Only the plan file may be edited"
// denial: a plan-file write must be recognized (behavior 'allow') even when
// the session's cached plan slug drifts from the slug embedded in the path
// the model writes. Without this, FileWrite/FileEdit/apply_patch to the plan
// file all get hard-denied by the plan-mode gate and the model is locked out
// of its own plan file.
//
// NOTE: these tests deliberately build plan paths from getPlansDirectory()
// directly rather than getPlanFilePath()/getPlanSlug(). Under the full suite,
// planDossier.test.ts leaks a mock.module for the plans helpers (bun's
// mock.module leaks across files and mock.restore() doesn't revert it), which
// makes getPlanFilePath() return a foreign fixture path. Routing only through
// getPlansDirectory() (unmocked here) keeps these hermetic.
describe('isSessionPlanFile (via checkEditableInternalPath)', () => {
  function inFreshProject<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'plan-perm-'))
    return runWithCwdOverride(root, () => fn(root))
  }

  function planPath(filename: string): string {
    return join(getPlansDirectory(), filename)
  }

  test('allows a write to the current-slug plan file', () => {
    inFreshProject(() => {
      setPlanSlug(getSessionId(), 'unified-rolling-ritchie')
      const p = planPath('unified-rolling-ritchie.md')
      const decision = checkEditableInternalPath(p, {
        file_path: p,
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
      const drifted = planPath('unified-rolling-ritchie.md')
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
      const agentPlan = planPath('unified-rolling-ritchie-agent-abc123.md')
      const decision = checkEditableInternalPath(agentPlan, {
        file_path: agentPlan,
        content: 'x',
      })
      expect(decision.behavior).toBe('allow')
    })
  })

  test('does NOT allow a subdirectory file under the plans dir', () => {
    inFreshProject(() => {
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
      const escape = join(getPlansDirectory(), '..', '..', 'escape.md')
      const decision = checkEditableInternalPath(escape, {
        file_path: escape,
        content: 'x',
      })
      expect(decision.behavior).toBe('passthrough')
    })
  })

  test('still allows the plan file after a Bash `cd` moved the session cwd (regression)', () => {
    // The symptom users hit: during planning the model runs `cd sub && ls`,
    // Shell.ts persists the new cwd, and the next write to its own plan file
    // comes back "Only the plan file may be edited".
    const root = mkdtempSync(join(tmpdir(), 'plan-perm-cd-'))
    const previousCwd = getCwdState()
    const previousOriginalCwd = getOriginalCwd()
    try {
      setOriginalCwd(root)
      setCwdState(root)
      const p = join(getPlansDirectory(), 'unified-rolling-ritchie.md')

      setCwdState(join(root, 'sub'))
      const decision = checkEditableInternalPath(p, {
        file_path: p,
        content: 'x',
      })

      expect(decision.behavior).toBe('allow')
    } finally {
      setCwdState(previousCwd)
      setOriginalCwd(previousOriginalCwd)
    }
  })
})
