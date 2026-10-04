/**
 * Characterization of EnterPlanModePermissionRequest, the dialog the model's
 * EnterPlanMode tool asks through. Written before the clean-base rewrite of
 * permissions/modeDialogs; the spec is docs/tech/rewrite/permissions/modeDialogs.md.
 *
 * The dialog does not change the mode itself: it hands the request a
 * session-scoped "set mode to plan" update, and the permission pipeline
 * applies it. What it does change directly is the pending plan-exit notice.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { EnterPlanModePermissionRequest } from 'src/permissions/ui/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js'
import { callerProps, enterPlanRequest, lowerSessionFlags, sessionFlags, type Ledger } from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { flat, isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import { setNeedsPlanModeExitAttachment } from 'src/platform/bootstrap/state.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

isolatedWorld()
beforeEach(lowerSessionFlags)

async function open(mode: PermissionMode = 'default', workerBadge?: { name: string; color: string }) {
  const ledger: Ledger = []
  const confirm = enterPlanRequest(ledger)
  const base = getDefaultAppState()
  const screen = await mount(<EnterPlanModePermissionRequest {...callerProps(ledger, confirm)} workerBadge={workerBadge as never} />, {
    columns: 100,
    appState: { toolPermissionContext: { ...base.toolPermissionContext, mode } },
  })
  return { screen, ledger }
}

const enterPlan = [{ type: 'setMode', mode: 'plan', destination: 'session' }]

describe('EnterPlanModePermissionRequest: what it shows', () => {
  test(
    'asks to enter plan mode, says what plan mode does, and offers yes first',
    async () => {
      const { screen, ledger } = await open()
      const text = flat(screen.text())
      expect(text).toContain('Enter plan mode?')
      for (const fact of [
        'wants to enter plan mode to explore and design an implementation approach',
        'Explore the codebase thoroughly',
        'Identify existing patterns',
        'Design an implementation strategy',
        'Present a plan for your approval',
        'No code changes will be made until you approve the plan',
      ]) {
        expect(text).toContain(fact)
      }
      expect(text).toContain('❯ 1. Yes, enter plan mode 2. No, start implementing now')
      expect(ledger).toEqual([])
    },
    SLOW,
  )

  test(
    "a worker's badge reaches the title",
    async () => {
      const { screen } = await open('default', { name: 'researcher', color: 'blue' })
      expect(flat(screen.text())).toContain('researcher')
    },
    SLOW,
  )
})

describe('EnterPlanModePermissionRequest: the answers', () => {
  const yes: Ledger = [
    { to: 'caller', call: 'done' },
    { to: 'request', call: 'allow', input: {}, updates: enterPlan, feedback: undefined },
  ]
  const no: Ledger = [
    { to: 'caller', call: 'done' },
    { to: 'caller', call: 'reject' },
    { to: 'request', call: 'reject', args: [] },
  ]
  const cases: Array<{ answer: string; keys: string[]; ledger: Ledger }> = [
    { answer: 'Enter on the focused yes', keys: [KEYS.enter], ledger: yes },
    { answer: '"1"', keys: ['1'], ledger: yes },
    { answer: '"2"', keys: ['2'], ledger: no },
    { answer: 'the arrow to no and Enter', keys: [KEYS.down, KEYS.enter], ledger: no },
    { answer: 'Esc', keys: [KEYS.esc], ledger: no },
  ]
  for (const c of cases) {
    test(
      `${c.answer} reports, in order: ${c.ledger.map(e => `${e.to} ${e.call}`).join(', ')}`,
      async () => {
        const { screen, ledger } = await open()
        await screen.press(...c.keys)
        expect(ledger).toEqual(c.ledger)
        // The mode itself is left to whoever applies the update.
        expect(screen.state().toolPermissionContext.mode).toBe('default')
      },
      SLOW,
    )
  }

  const notices: Array<{ from: PermissionMode; keys: string[]; pendingAfter: boolean }> = [
    // Entering plan withdraws a plan-exit notice still waiting to be sent.
    { from: 'default', keys: ['1'], pendingAfter: false },
    { from: 'acceptEdits', keys: ['1'], pendingAfter: false },
    // From plan itself, nothing is entered, so the notice stays.
    { from: 'plan', keys: ['1'], pendingAfter: true },
    // Declining leaves it alone.
    { from: 'default', keys: ['2'], pendingAfter: true },
    { from: 'default', keys: [KEYS.esc], pendingAfter: true },
  ]
  for (const n of notices) {
    test(
      `from ${n.from}, ${n.keys[0] === KEYS.esc ? 'Esc' : `"${n.keys[0]}"`}: a pending plan-exit notice ${n.pendingAfter ? 'stays' : 'is withdrawn'}`,
      async () => {
        const { screen } = await open(n.from)
        setNeedsPlanModeExitAttachment(true)
        await screen.press(...n.keys)
        expect(sessionFlags()).toEqual({ exitedPlan: false, planExitNotice: n.pendingAfter, autoExitNotice: false })
      },
      SLOW,
    )
  }
})
