/**
 * Permission-mode transitions: which side effects fire on which edge, and
 * which edges must leave the context object untouched.
 *
 * NOTE ON SCOPE: `feature('TRANSCRIPT_CLASSIFIER')` resolves to `false` under
 * `bun test`, so the auto-mode half of `transitionPermissionMode` /
 * `prepareContextForPlanMode` and the whole of `transitionPlanAutoMode` are
 * unreachable from here. What is pinned below is the plan-mode bookkeeping and
 * the ref-equality contract, both of which run in every build. The classifier
 * arms are covered by the surface pin only — see permissionSetup.surface.test.ts.
 *
 * These functions mutate process-global session state, so every test snapshots
 * the three flags it can touch and puts them back.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  hasExitedPlanModeInSession,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import {
  prepareContextForPlanMode,
  transitionPermissionMode,
  transitionPlanAutoMode,
} from 'src/permissions/permissionSetup.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

function ctx(
  mode: PermissionMode,
  extra: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...extra,
  } as ToolPermissionContext
}

let saved: [boolean, boolean, boolean]

beforeEach(() => {
  saved = [
    hasExitedPlanModeInSession(),
    needsPlanModeExitAttachment(),
    needsAutoModeExitAttachment(),
  ]
  setHasExitedPlanMode(false)
  setNeedsPlanModeExitAttachment(false)
  setNeedsAutoModeExitAttachment(false)
})

afterEach(() => {
  setHasExitedPlanMode(saved[0])
  setNeedsPlanModeExitAttachment(saved[1])
  setNeedsAutoModeExitAttachment(saved[2])
})

describe('transitionPermissionMode — plan bookkeeping', () => {
  test('leaving plan mode arms the plan-exit attachment', () => {
    transitionPermissionMode('plan', 'default', ctx('plan'))
    expect(needsPlanModeExitAttachment()).toBe(true)
  })

  test('leaving plan mode records that plan was exited this session', () => {
    transitionPermissionMode('plan', 'acceptEdits', ctx('plan'))
    expect(hasExitedPlanModeInSession()).toBe(true)
  })

  test('entering plan mode disarms a pending plan-exit attachment', () => {
    setNeedsPlanModeExitAttachment(true)
    transitionPermissionMode('default', 'plan', ctx('default'))
    expect(needsPlanModeExitAttachment()).toBe(false)
  })

  test('entering plan mode does not record a plan exit', () => {
    transitionPermissionMode('default', 'plan', ctx('default'))
    expect(hasExitedPlanModeInSession()).toBe(false)
  })

  test('a transition that touches neither side of plan leaves both flags alone', () => {
    transitionPermissionMode('default', 'acceptEdits', ctx('default'))
    expect(needsPlanModeExitAttachment()).toBe(false)
    expect(hasExitedPlanModeInSession()).toBe(false)
  })
})

describe('transitionPermissionMode — auto bookkeeping', () => {
  test('leaving auto mode arms the auto-exit attachment', () => {
    transitionPermissionMode('auto', 'default', ctx('auto'))
    expect(needsAutoModeExitAttachment()).toBe(true)
  })

  test('entering auto mode disarms a pending auto-exit attachment', () => {
    setNeedsAutoModeExitAttachment(true)
    transitionPermissionMode('default', 'auto', ctx('default'))
    expect(needsAutoModeExitAttachment()).toBe(false)
  })

  test('auto→plan is left to the plan-entry path, not treated as an auto exit', () => {
    transitionPermissionMode('auto', 'plan', ctx('auto'))
    expect(needsAutoModeExitAttachment()).toBe(false)
  })

  test('plan→auto is left to the plan-exit path, not treated as an auto entry', () => {
    setNeedsAutoModeExitAttachment(true)
    transitionPermissionMode('plan', 'auto', ctx('plan'))
    expect(needsAutoModeExitAttachment()).toBe(true)
  })
})

describe('transitionPermissionMode — context shape', () => {
  test('leaving plan clears the stashed pre-plan mode', () => {
    const before = ctx('plan', { prePlanMode: 'acceptEdits' })
    const after = transitionPermissionMode('plan', 'default', before)
    expect(after.prePlanMode).toBeUndefined()
  })

  test('clearing the pre-plan mode preserves everything else', () => {
    const before = ctx('plan', {
      prePlanMode: 'acceptEdits',
      alwaysAllowRules: { localSettings: ['Bash(git status:*)'] },
    })
    const after = transitionPermissionMode('plan', 'default', before)
    expect(after.alwaysAllowRules).toEqual(before.alwaysAllowRules)
    expect(after.mode).toBe('plan')
  })

  test('leaving plan with no stashed mode preserves reference equality', () => {
    // The caller re-renders on identity, so spreading unconditionally would
    // cost a render on every shift-tab.
    const before = ctx('plan')
    expect(transitionPermissionMode('plan', 'default', before)).toBe(before)
  })

  test('a transition unrelated to plan preserves reference equality', () => {
    const before = ctx('default', { prePlanMode: 'acceptEdits' })
    expect(transitionPermissionMode('default', 'acceptEdits', before)).toBe(
      before,
    )
  })

  test('a no-op transition returns the context untouched', () => {
    const before = ctx('plan', { prePlanMode: 'acceptEdits' })
    expect(transitionPermissionMode('plan', 'plan', before)).toBe(before)
  })
})

describe('prepareContextForPlanMode', () => {
  test('stashes the current mode as prePlanMode', () => {
    expect(prepareContextForPlanMode(ctx('acceptEdits')).prePlanMode).toBe(
      'acceptEdits',
    )
    expect(prepareContextForPlanMode(ctx('default')).prePlanMode).toBe(
      'default',
    )
  })

  test('does not change the mode itself — the caller sets it', () => {
    expect(prepareContextForPlanMode(ctx('acceptEdits')).mode).toBe(
      'acceptEdits',
    )
  })

  test('re-entering plan mode is a no-op, by identity', () => {
    // Otherwise prePlanMode would be overwritten with 'plan' and ExitPlanMode
    // would have nowhere to return to.
    const before = ctx('plan', { prePlanMode: 'acceptEdits' })
    expect(prepareContextForPlanMode(before)).toBe(before)
  })

  test('the input context is not mutated', () => {
    const before = ctx('acceptEdits')
    prepareContextForPlanMode(before)
    expect(before.prePlanMode).toBeUndefined()
  })
})

describe('transitionPlanAutoMode', () => {
  test('is inert when the classifier is not built in', () => {
    // Gate-off contract only. With TRANSCRIPT_CLASSIFIER folded to false this
    // function returns its input for every mode, so no probe in this build can
    // distinguish its arms — the surface pin is what guards it.
    const planCtx = ctx('plan', { prePlanMode: 'default' })
    expect(transitionPlanAutoMode(planCtx)).toBe(planCtx)
    const defaultCtx = ctx('default')
    expect(transitionPlanAutoMode(defaultCtx)).toBe(defaultCtx)
  })
})
