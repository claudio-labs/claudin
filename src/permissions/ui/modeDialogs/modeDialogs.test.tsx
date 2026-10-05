/**
 * Unit tests for the pieces the permissions/modeDialogs rewrite split out:
 * the plan-exit answers and outcomes as pure data, the clear-context prompt,
 * and the bypass warning's injected process exit. The dialogs themselves are
 * pinned by the characterization suites beside them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { AutoModeOptInDialog } from 'src/permissions/ui/AutoModeOptInDialog.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { BypassPermissionsModeDialog } from 'src/permissions/ui/BypassPermissionsModeDialog.js'
import { ExitPlanModePermissionRequest } from 'src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { callerProps, type Ledger, lowerSessionFlags, planRequest, writePlan } from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { setSessionPersistenceDisabled } from 'src/platform/bootstrap/state.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { clearContextPrompt } from 'src/permissions/ui/modeDialogs/clearContextPrompt.js'
import {
  answerFor,
  type PlanAnswer,
  type PlanOffer,
  planApprovalChoices,
  type ResponseValue,
  shortcutAnswer,
} from 'src/permissions/ui/modeDialogs/planExitChoices.js'
import { type ApprovingAnswer, type PlanExitFacts, planExitOutcome } from 'src/permissions/ui/modeDialogs/planExitOutcome.js'

describe('planApprovalChoices', () => {
  const offer = (o: Partial<PlanOffer>): PlanOffer => ({
    showClearContext: false,
    usedPercent: null,
    autoOffered: false,
    bypassOffered: false,
    ...o,
  })
  const rows: Array<{ offer: PlanOffer; choices: Array<[string, ResponseValue]> }> = [
    {
      offer: offer({ showClearContext: true, usedPercent: 9, autoOffered: true, bypassOffered: true }),
      choices: [
        ['Yes, clear context (9% used) and use auto mode', 'yes-auto-clear-context'],
        ['Yes, and use auto mode', 'yes-resume-auto-mode'],
        ['Yes, manually approve edits', 'yes-default-keep-context'],
      ],
    },
    {
      offer: offer({ showClearContext: true, bypassOffered: true }),
      choices: [
        ['Yes, clear context and bypass permissions', 'yes-bypass-permissions'],
        ['Yes, and bypass permissions', 'yes-accept-edits-keep-context'],
        ['Yes, manually approve edits', 'yes-default-keep-context'],
      ],
    },
    {
      offer: offer({}),
      choices: [
        ['Yes, auto-accept edits', 'yes-accept-edits-keep-context'],
        ['Yes, manually approve edits', 'yes-default-keep-context'],
      ],
    },
  ]
  for (const row of rows) {
    test(JSON.stringify(row.offer), () => {
      expect(planApprovalChoices(row.offer).map(c => [c.label, c.value])).toEqual(row.choices)
    })
  }
})

describe('answerFor and shortcutAnswer', () => {
  const decoded: Array<[ResponseValue, boolean, PlanAnswer]> = [
    ['yes-auto-clear-context', false, { kind: 'clear', elevation: 'auto' }],
    ['yes-bypass-permissions', true, { kind: 'clear', elevation: 'bypass' }],
    ['yes-accept-edits', true, { kind: 'clear', elevation: 'edits' }],
    ['yes-resume-auto-mode', true, { kind: 'keep', elevation: 'auto' }],
    ['yes-accept-edits-keep-context', true, { kind: 'keep', elevation: 'bypass' }],
    ['yes-accept-edits-keep-context', false, { kind: 'keep', elevation: 'edits' }],
    ['yes-default-keep-context', true, { kind: 'manual' }],
    ['no', true, { kind: 'feedback' }],
  ]
  for (const [value, bypassOffered, answer] of decoded) {
    test(`${value} with bypass ${bypassOffered ? 'offered' : 'not offered'}`, () => {
      expect(answerFor(value, { bypassOffered })).toEqual(answer)
    })
  }

  test('shift+tab: bypass only through the keep-context slot, accept-edits whenever clear-context is on', () => {
    expect(shortcutAnswer({ showClearContext: false, bypassOffered: true })).toEqual({ kind: 'keep', elevation: 'bypass' })
    expect(shortcutAnswer({ showClearContext: false, bypassOffered: false })).toEqual({ kind: 'keep', elevation: 'edits' })
    expect(shortcutAnswer({ showClearContext: true, bypassOffered: true })).toEqual({ kind: 'clear', elevation: 'edits' })
  })
})

describe('planExitOutcome', () => {
  const facts = (f: Partial<PlanExitFacts> = {}): PlanExitFacts => ({ autoBuiltIn: true, gateOpen: true, autoActive: false, ...f })
  type Row = {
    answer: ApprovingAnswer
    facts: PlanExitFacts
    expected: ReturnType<typeof planExitOutcome>
  }
  const allow = { route: 'allow', planExitNotice: true, nameSession: true } as const
  const restart = { route: 'restart', planExitNotice: false, nameSession: true } as const
  const rows: Row[] = [
    { answer: { kind: 'keep', elevation: 'edits' }, facts: facts(), expected: { ...allow, mode: 'acceptEdits', auto: 'untouched' } },
    { answer: { kind: 'keep', elevation: 'bypass' }, facts: facts(), expected: { ...allow, mode: 'bypassPermissions', auto: 'untouched' } },
    { answer: { kind: 'manual' }, facts: facts({ autoActive: true }), expected: { ...allow, mode: 'default', auto: 'leave' } },
    { answer: { kind: 'keep', elevation: 'auto' }, facts: facts(), expected: { ...allow, mode: 'auto', auto: 'enterContext' } },
    // The gate is read at the answer: closed, auto falls back to the default mode.
    {
      answer: { kind: 'keep', elevation: 'auto' },
      facts: facts({ gateOpen: false, autoActive: true }),
      expected: { ...allow, mode: 'default', auto: 'leave' },
    },
    // A build without auto mode never enters it, whatever the gate says.
    { answer: { kind: 'keep', elevation: 'auto' }, facts: facts({ autoBuiltIn: false }), expected: { ...allow, mode: 'default', auto: 'untouched' } },
    { answer: { kind: 'clear', elevation: 'auto' }, facts: facts({ autoActive: true }), expected: { ...restart, mode: 'auto', auto: 'enterFlag' } },
    { answer: { kind: 'clear', elevation: 'auto' }, facts: facts({ gateOpen: false }), expected: { ...restart, mode: 'default', auto: 'untouched' } },
    { answer: { kind: 'clear', elevation: 'bypass' }, facts: facts(), expected: { ...restart, mode: 'bypassPermissions', auto: 'untouched' } },
    { answer: { kind: 'clear', elevation: 'edits' }, facts: facts({ autoActive: true }), expected: { ...restart, mode: 'acceptEdits', auto: 'leave' } },
    // The empty plan's Yes: always the default mode, and it stops a running auto mode.
    {
      answer: { kind: 'plainExit' },
      facts: facts({ autoActive: true }),
      expected: { route: 'allow', planExitNotice: true, nameSession: false, mode: 'default', auto: 'leave' },
    },
  ]
  for (const row of rows) {
    test(`${JSON.stringify(row.answer)} ${JSON.stringify(row.facts)}`, () => {
      expect(planExitOutcome(row.answer, row.facts)).toEqual(row.expected)
    })
  }
})

describe('clearContextPrompt', () => {
  const base = { plan: '# Plan\n\n1. do it', transcriptPath: '/t/session.jsonl', teamsEnabled: false, feedback: '' }

  test('the plan verbatim first, then the transcript it came from', () => {
    const prompt = clearContextPrompt(base)
    expect(prompt.startsWith('Implement the following plan:\n\n# Plan\n\n1. do it\n\n')).toBe(true)
    expect(prompt).toContain('exact code snippets, error messages')
    expect(prompt.endsWith('read the full transcript at: /t/session.jsonl')).toBe(true)
    expect(prompt).not.toContain('TeamCreate')
  })

  test('teams, then feedback, in that order and at the end', () => {
    const prompt = clearContextPrompt({ ...base, teamsEnabled: true, feedback: 'add docs' })
    const transcript = prompt.indexOf('read the full transcript')
    const team = prompt.indexOf('using the TeamCreate tool to create a team')
    expect(prompt).toContain('broken down into multiple independent tasks')
    expect(team).toBeGreaterThan(transcript)
    expect(prompt.endsWith('\n\nUser feedback on this plan: add docs')).toBe(true)
  })
})

describe('ExitPlanModePermissionRequest answers once', () => {
  isolatedWorld()
  beforeEach(() => {
    lowerSessionFlags()
    // Keeps the session-naming request from reaching a model.
    setSessionPersistenceDisabled(true)
  })
  afterEach(() => setSessionPersistenceDisabled(false))

  test(
    'a second answer after the first is ignored',
    async () => {
      writePlan('# Plan\n\n1. do it')
      const ledger: Ledger = []
      const confirm = planRequest(ledger)
      const base = getDefaultAppState()
      const screen = await mount(<ExitPlanModePermissionRequest {...callerProps(ledger, confirm)} />, {
        columns: 120,
        appState: { toolPermissionContext: { ...base.toolPermissionContext, mode: 'plan' } },
      })
      await screen.press('2', '1', KEYS.esc)
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'request', call: 'allow', input: {}, updates: [{ type: 'setMode', mode: 'default', destination: 'session' }], feedback: undefined },
      ])
    },
    SLOW,
  )
})

describe('AutoModeOptInDialog: the frame cancel and a single answer', () => {
  const world = isolatedWorld()
  const userSettings = () => join(world().config, 'settings.json')

  async function open() {
    writeFileSync(userSettings(), JSON.stringify({ theme: 'dark' }))
    resetSettingsCache()
    const heard = { accepted: 0, declined: 0 }
    const screen = await mount(
      <AutoModeOptInDialog onAccept={() => (heard.accepted += 1)} onDecline={() => (heard.declined += 1)} declineExits />,
      { columns: 110 },
    )
    return { screen, heard }
  }

  test(
    '"n", which only the frame takes, declines and writes nothing',
    async () => {
      const { screen, heard } = await open()
      await screen.press('n')
      expect(heard).toEqual({ accepted: 0, declined: 1 })
      expect(JSON.parse(readFileSync(userSettings(), 'utf8'))).toEqual({ theme: 'dark' })
    },
    SLOW,
  )

  test(
    'the caller hears only the first answer',
    async () => {
      const { screen, heard } = await open()
      await screen.press('2', '1', KEYS.esc)
      expect(heard).toEqual({ accepted: 1, declined: 0 })
      expect(JSON.parse(readFileSync(userSettings(), 'utf8'))).toEqual({ theme: 'dark', skipAutoPermissionPrompt: true })
    },
    SLOW,
  )
})

describe('BypassPermissionsModeDialog with an injected exit', () => {
  isolatedWorld()
  const cases: Array<{ answer: string; keys: string[]; exits: number[]; accepted: number }> = [
    { answer: 'Enter on the focused refusal', keys: [KEYS.enter], exits: [1], accepted: 0 },
    { answer: '"1"', keys: ['1'], exits: [1], accepted: 0 },
    { answer: 'Esc', keys: [KEYS.esc], exits: [0], accepted: 0 },
    { answer: '"2"', keys: ['2'], exits: [], accepted: 1 },
    { answer: 'a single Ctrl+C', keys: [KEYS.ctrlC], exits: [], accepted: 0 },
    // The frame's own cancel key, which the list does not take.
    { answer: '"n"', keys: ['n'], exits: [0], accepted: 0 },
  ]
  for (const c of cases) {
    test(
      `${c.answer}: exits ${JSON.stringify(c.exits)}, accepts ${c.accepted}`,
      async () => {
        const exits: number[] = []
        let accepted = 0
        const screen = await mount(<BypassPermissionsModeDialog onAccept={() => (accepted += 1)} exitProcess={code => exits.push(code)} />)
        await screen.press(...c.keys)
        expect(exits).toEqual(c.exits)
        expect(accepted).toBe(c.accepted)
      },
      SLOW,
    )
  }
})
