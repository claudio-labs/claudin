/**
 * Characterization of ExitPlanModePermissionRequest, the "Ready to code?"
 * dialog the plan tool asks through, and of the three helpers the file exports.
 * Written before the clean-base rewrite of permissions/modeDialogs; the spec is
 * docs/tech/rewrite/permissions/modeDialogs.md.
 *
 * This file runs with every build flag off, where auto mode does not exist.
 * ExitPlanModePermissionRequest.shipped.characterization.test.tsx covers the
 * auto-mode half with TRANSCRIPT_CLASSIFIER on.
 *
 * The one thing replaced is the small-model request that names the session
 * after the plan. Everything else is real: the plan file on disk, the app
 * state, the session flags and the transcript.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import * as React from 'react'
import { getPlanFilePath } from 'src/agent/plans/plans.js'
import { __setBashClassifierEnabledForTests } from 'src/permissions/bashClassifier.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import {
  callerProps,
  fakeEditor,
  lendTerminalToEditor,
  lowerSessionFlags,
  ONE_PIXEL_PNG,
  pasted,
  planRequest,
  pngOnDisk,
  sessionFlags,
  StickyHost,
  writePlan,
  type Ledger,
} from 'src/permissions/ui/__testutils__/modeDialogsRig.js'
import { flat, isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { getSessionId, setMainLoopModelOverride, setSessionPersistenceDisabled } from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { clearSessionMetadata, getCurrentSessionTitle, getTranscriptPath, saveCustomTitle } from 'src/sessions/sessionStorage.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

// --- the one replaced boundary: the request that names the session ---------------
const namingRequests: string[] = []
let namingReply: string | null = '{"name":"plan-the-rollout"}'
const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: async (request: { userPrompt: string }) => {
    namingRequests.push(request.userPrompt)
    if (namingReply === null) throw new Error('model unavailable')
    return { message: { content: [{ type: 'text', text: namingReply }] } }
  },
}))
const { ExitPlanModePermissionRequest, autoNameSessionFromPlan, buildPermissionUpdates, buildPlanApprovalOptions } = await import(
  'src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
)

const world = isolatedWorld()
const saved = { visual: process.env.VISUAL, teams: process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS }
beforeAll(() => {
  process.env.VISUAL = 'vim'
  getExternalEditor.cache.clear?.()
  setMainLoopModelOverride('claude-sonnet-4-6')
})
afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  for (const [key, value] of [
    ['VISUAL', saved.visual],
    ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', saved.teams],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getExternalEditor.cache.clear?.()
  setMainLoopModelOverride(undefined)
})
beforeEach(() => {
  lowerSessionFlags()
  clearSessionMetadata()
  setSessionPersistenceDisabled(false)
  __setBashClassifierEnabledForTests(undefined)
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  namingRequests.length = 0
  namingReply = '{"name":"plan-the-rollout"}'
})

const PLAN = '# Rollout\n\n1. migrate the table\n2. ship the flag'
const setMode = (mode: string) => [{ type: 'setMode', mode, destination: 'session' }]
const settle = () => Bun.sleep(400)
/** Waits for an answer that goes through an asynchronous step, such as resizing an image. */
async function untilReported(ledger: Ledger, count: number) {
  // The first resize loads the image library, which is slow on a busy machine.
  const deadline = Date.now() + 20_000
  while (ledger.length < count && Date.now() < deadline) await Bun.sleep(20)
}

type Setup = {
  plan?: string | null
  input?: Record<string, unknown>
  clear?: boolean
  bypass?: boolean
  auto?: boolean
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

async function open(setup: Setup = {}) {
  if (setup.plan !== null) writePlan(setup.plan ?? PLAN)
  const ledger: Ledger = []
  const confirm = planRequest(ledger, { input: setup.input, usage: setup.usage })
  const base = getDefaultAppState()
  const screen = await mount(<ExitPlanModePermissionRequest {...callerProps(ledger, confirm)} />, {
    columns: 120,
    appState: {
      settings: { ...base.settings, showClearContextOnPlanAccept: setup.clear ?? false },
      toolPermissionContext: {
        ...base.toolPermissionContext,
        mode: 'plan',
        isBypassPermissionsModeAvailable: setup.bypass ?? false,
        isAutoModeAvailable: setup.auto ?? false,
      },
    },
  })
  return { screen, ledger }
}

/** The numbered answers on screen, in order. */
function answers(frame: string): string[] {
  // An answer sits behind the pointer or its blank; a numbered line of the plan does not.
  return [...frame.matchAll(/^\s*(?:❯| ) \d+\. (.+?)\s*$/gm)].map(m => m[1]!)
}

// --- the exported helpers ----------------------------------------------------------

describe('buildPlanApprovalOptions (flags off)', () => {
  type Row = { clear: boolean; percent: number | null; bypass: boolean; auto: boolean; labels: string[]; values: string[] }
  const tail = ['Yes, manually approve edits', 'No, keep planning']
  const tailValues = ['yes-default-keep-context', 'no']
  const rows: Row[] = [
    { clear: false, percent: null, bypass: false, auto: false, labels: ['Yes, auto-accept edits', ...tail], values: ['yes-accept-edits-keep-context', ...tailValues] },
    { clear: false, percent: 40, bypass: true, auto: false, labels: ['Yes, and bypass permissions', ...tail], values: ['yes-accept-edits-keep-context', ...tailValues] },
    // Auto is never offered without the build flag, whatever the context says.
    { clear: false, percent: null, bypass: false, auto: true, labels: ['Yes, auto-accept edits', ...tail], values: ['yes-accept-edits-keep-context', ...tailValues] },
    {
      clear: true,
      percent: 12,
      bypass: false,
      auto: true,
      labels: ['Yes, clear context (12% used) and auto-accept edits', 'Yes, auto-accept edits', ...tail],
      values: ['yes-accept-edits', 'yes-accept-edits-keep-context', ...tailValues],
    },
    {
      clear: true,
      percent: null,
      bypass: true,
      auto: false,
      labels: ['Yes, clear context and bypass permissions', 'Yes, and bypass permissions', ...tail],
      values: ['yes-bypass-permissions', 'yes-accept-edits-keep-context', ...tailValues],
    },
  ]
  for (const row of rows) {
    test(`clear=${row.clear} percent=${row.percent} bypass=${row.bypass} auto=${row.auto}`, () => {
      const changes: string[] = []
      const options = buildPlanApprovalOptions({
        showClearContext: row.clear,
        usedPercent: row.percent,
        isAutoModeAvailable: row.auto,
        isBypassPermissionsModeAvailable: row.bypass,
        onFeedbackChange: v => changes.push(v),
      })
      expect(options.map(o => o.label)).toEqual(row.labels)
      expect<unknown>(options.map(o => o.value)).toEqual(row.values)
      const feedback = options.at(-1) as { type?: string; placeholder?: string; description?: string; onChange?: (v: string) => void }
      expect(feedback.type).toBe('input')
      expect(feedback.placeholder).toBe('Tell Claudin what to change')
      expect(feedback.description).toBe('shift+tab to approve with this feedback')
      feedback.onChange?.('more tests')
      expect(changes).toEqual(['more tests'])
      expect(options.slice(0, -1).every(o => (o as { type?: string }).type === undefined)).toBe(true)
    })
  }
})

describe('buildPermissionUpdates', () => {
  const prompts = [
    { tool: 'Bash' as const, prompt: 'run tests' },
    { tool: 'Bash' as const, prompt: 'install dependencies' },
  ]
  const modes: Array<[PermissionMode, string]> = [
    ['acceptEdits', 'acceptEdits'],
    ['bypassPermissions', 'bypassPermissions'],
    ['default', 'default'],
    ['plan', 'plan'],
    // The session update only speaks the external modes, and auto is not one.
    ['auto', 'default'],
  ]
  for (const [mode, reported] of modes) {
    test(`${mode}: one session-scoped setMode to ${reported}, and no rules while the classifier is off`, () => {
      expect<unknown>(buildPermissionUpdates(mode)).toEqual(setMode(reported))
      expect<unknown>(buildPermissionUpdates(mode, prompts)).toEqual(setMode(reported))
    })
  }
  test('with the Bash classifier on, the requested prompts become session allow rules', () => {
    __setBashClassifierEnabledForTests(true)
    expect<unknown>(buildPermissionUpdates('acceptEdits', prompts)).toEqual([
      ...setMode('acceptEdits'),
      {
        type: 'addRules',
        rules: [
          { toolName: 'Bash', ruleContent: 'prompt: run tests' },
          { toolName: 'Bash', ruleContent: 'prompt: install dependencies' },
        ],
        behavior: 'allow',
        destination: 'session',
      },
    ])
    expect<unknown>(buildPermissionUpdates('default', [])).toEqual(setMode('default'))
    expect<unknown>(buildPermissionUpdates('default')).toEqual(setMode('default'))
  })
})

describe('autoNameSessionFromPlan', () => {
  const long = `${'a'.repeat(990)}KEEP-THIS${'z'.repeat(40)}DROPPED`
  test('names an unnamed session after the head of the plan, in the session and its transcript', async () => {
    autoNameSessionFromPlan(long, false)
    await settle()
    expect(namingRequests).toHaveLength(1)
    expect(namingRequests[0]).toContain('KEEP-T')
    expect(namingRequests[0]).not.toContain('DROPPED')
    expect(namingRequests[0]).not.toContain('z'.repeat(40))
    expect(getCurrentSessionTitle(getSessionId())).toBe('plan-the-rollout')
    const transcript = readFileSync(getTranscriptPath(), 'utf8')
    expect(transcript).toContain('"customTitle":"plan-the-rollout"')
  })

  type Skip = { why: string; arrange: () => void | Promise<void>; clear: boolean; asks: boolean; title: string | undefined }
  const skips: Skip[] = [
    { why: 'the session already has a title', arrange: () => saveCustomTitle(getSessionId() as UUID, 'mine'), clear: false, asks: false, title: 'mine' },
    // Clearing context starts a new session, so an old title does not stop the request,
    // but a title present when the answer comes back is never overwritten.
    { why: 'clearing context, with a title already set', arrange: () => saveCustomTitle(getSessionId() as UUID, 'mine'), clear: true, asks: true, title: 'mine' },
    { why: 'session persistence is off', arrange: () => setSessionPersistenceDisabled(true), clear: false, asks: false, title: undefined },
    {
      why: 'the user keeps no transcripts (cleanupPeriodDays 0)',
      arrange: () => {
        writeFileSync(join(world().config, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }))
        resetSettingsCache()
      },
      clear: false,
      asks: false,
      title: undefined,
    },
    { why: 'the model gives no name', arrange: () => void (namingReply = '{"title":"x"}'), clear: false, asks: true, title: undefined },
    { why: 'the model call fails', arrange: () => void (namingReply = null), clear: false, asks: true, title: undefined },
  ]
  for (const s of skips) {
    test(`${s.why}: ${s.asks ? 'asks, but' : 'does not ask, and'} leaves the title ${s.title ?? 'unset'}`, async () => {
      await s.arrange()
      autoNameSessionFromPlan(PLAN, s.clear)
      await settle()
      expect(namingRequests.length).toBe(s.asks ? 1 : 0)
      expect(getCurrentSessionTitle(getSessionId())).toBe(s.title)
    })
  }
})

// --- the dialog ----------------------------------------------------------------------

describe('ExitPlanModePermissionRequest: what it shows', () => {
  test(
    'the plan from the plan file, rendered, and the answers for a plain session',
    async () => {
      // input.plan is what hooks and the SDK see; the dialog reads the file.
      const { screen, ledger } = await open({ input: { plan: 'NOT THE PLAN' } })
      const frame = screen.text()
      const text = flat(frame)
      expect(text).toContain('Ready to code?')
      expect(text).toContain("Here is Claude's plan:")
      expect(text).toContain('Rollout')
      expect(text).not.toContain('# Rollout')
      expect(text).toContain('1. migrate the table')
      expect(text).not.toContain('NOT THE PLAN')
      expect(text).toContain('Claude has written up a plan and is ready to execute. Would you like to proceed?')
      expect(answers(frame).slice(-3)).toEqual(['Yes, auto-accept edits', 'Yes, manually approve edits', 'Tell Claudin what to change'])
      expect(text).toContain('shift+tab to approve with this feedback')
      expect(ledger).toEqual([])
    },
    SLOW,
  )

  test(
    'names the editor ctrl+g opens, and the plan file it would edit',
    async () => {
      const { screen } = await open()
      const text = flat(screen.text())
      expect(text).toContain('ctrl-g to edit in Vim')
      expect(text.replace(/ /g, '')).toContain(join(world().project, '.claudin', 'plans').replace(/ /g, ''))
    },
    SLOW,
  )

  const layouts: Array<{ setup: Setup; first: string[] }> = [
    { setup: { bypass: true }, first: ['Yes, and bypass permissions', 'Yes, manually approve edits'] },
    { setup: { auto: true }, first: ['Yes, auto-accept edits', 'Yes, manually approve edits'] },
    { setup: { clear: true }, first: ['Yes, clear context (2% used) and auto-accept edits', 'Yes, auto-accept edits'] },
    { setup: { clear: true, bypass: true }, first: ['Yes, clear context (2% used) and bypass permissions', 'Yes, and bypass permissions'] },
  ]
  for (const { setup, first } of layouts) {
    test(
      `${JSON.stringify(setup)}: starts with ${first.join(' / ')}`,
      async () => {
        const { screen } = await open({ ...setup, usage: { input_tokens: 3_000, output_tokens: 10, cache_read_input_tokens: 1_000 } })
        expect(answers(screen.text()).slice(0, 2)).toEqual(first)
      },
      SLOW,
    )
  }

  test(
    'the share of the context used counts input, cache writes and cache reads against the model window',
    async () => {
      const { screen } = await open({
        clear: true,
        usage: { input_tokens: 50_000, output_tokens: 999_999, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 20_000 },
      })
      expect(answers(screen.text())[0]).toBe('Yes, clear context (50% used) and auto-accept edits')
    },
    SLOW,
  )

  test(
    'the plan tool\'s requested prompts are listed only while the Bash classifier is on',
    async () => {
      const input = { allowedPrompts: [{ tool: 'Bash', prompt: 'run the test suite' }] }
      const off = await open({ input })
      expect(flat(off.screen.text())).not.toContain('Requested permissions')
      await off.screen.close()
      __setBashClassifierEnabledForTests(true)
      const on = await open({ input })
      const text = flat(on.screen.text())
      expect(text).toContain('Requested permissions:')
      expect(text).toContain('· Bash(prompt: run the test suite)')
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: approving and keeping the context', () => {
  type Case = { setup: Setup; keys: string[]; mode: string }
  const cases: Case[] = [
    { setup: {}, keys: ['1'], mode: 'acceptEdits' },
    { setup: {}, keys: [KEYS.enter], mode: 'acceptEdits' },
    { setup: {}, keys: ['2'], mode: 'default' },
    { setup: {}, keys: [KEYS.down, KEYS.enter], mode: 'default' },
    // The same answer goes to bypass when bypass is offered.
    { setup: { bypass: true }, keys: ['1'], mode: 'bypassPermissions' },
    { setup: { bypass: true }, keys: ['2'], mode: 'default' },
    { setup: { clear: true }, keys: ['2'], mode: 'acceptEdits' },
    { setup: { clear: true, bypass: true }, keys: ['2'], mode: 'bypassPermissions' },
    { setup: { clear: true, bypass: true }, keys: ['3'], mode: 'default' },
    // Shift+tab is the "auto-accept edits" shortcut, which also lands in bypass when it is offered.
    { setup: {}, keys: ['\x1B[Z'], mode: 'acceptEdits' },
    { setup: { bypass: true }, keys: ['\x1B[Z'], mode: 'bypassPermissions' },
  ]
  for (const c of cases) {
    const keyName = c.keys.map(k => (k === '\x1B[Z' ? 'shift+tab' : k === KEYS.enter ? 'Enter' : k === KEYS.down ? 'down' : `"${k}"`)).join(' ')
    test(
      `${JSON.stringify(c.setup)}, ${keyName}: session mode ${c.mode}, plan exit marked`,
      async () => {
        const { screen, ledger } = await open(c.setup)
        await screen.press(...c.keys)
        expect(ledger).toEqual([
          { to: 'caller', call: 'done' },
          { to: 'request', call: 'allow', input: {}, updates: setMode(c.mode), feedback: undefined },
        ])
        expect(sessionFlags()).toEqual({ exitedPlan: true, planExitNotice: true, autoExitNotice: false })
        // The mode change travels in the update; the dialog leaves the context and the next message alone.
        expect(screen.state().toolPermissionContext.mode).toBe('plan')
        expect(screen.state().initialMessage).toBeFalsy()
      },
      SLOW,
    )
  }

  test(
    'with the Bash classifier on, approving also allows the requested prompts for the session',
    async () => {
      __setBashClassifierEnabledForTests(true)
      const { screen, ledger } = await open({ input: { allowedPrompts: [{ tool: 'Bash', prompt: 'run the test suite' }] } })
      await screen.press('2')
      expect(ledger[1]).toEqual({
        to: 'request',
        call: 'allow',
        input: {},
        updates: [
          ...setMode('default'),
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'prompt: run the test suite' }], behavior: 'allow', destination: 'session' },
        ],
        feedback: undefined,
      })
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: approving and clearing the context', () => {
  type Case = { setup: Setup; keys: string[]; mode: string }
  const cases: Case[] = [
    { setup: { clear: true }, keys: ['1'], mode: 'acceptEdits' },
    { setup: { clear: true, bypass: true }, keys: ['1'], mode: 'bypassPermissions' },
    // With clear-context on, shift+tab clears and auto-accepts edits, even when the first answer offers bypass.
    { setup: { clear: true, bypass: true }, keys: ['\x1B[Z'], mode: 'acceptEdits' },
  ]
  for (const c of cases) {
    test(
      `${JSON.stringify(c.setup)}, ${c.keys[0] === '\x1B[Z' ? 'shift+tab' : `"${c.keys[0]}"`}: the plan becomes the next message, to run in ${c.mode}`,
      async () => {
        const allowedPrompts = [{ tool: 'Bash', prompt: 'run the test suite' }]
        const { screen, ledger } = await open({ ...c.setup, input: { allowedPrompts } })
        await screen.press(...c.keys)
        // The tool use is turned down to free the loop; the REPL starts over from the message.
        expect(ledger).toEqual([
          { to: 'caller', call: 'done' },
          { to: 'caller', call: 'reject' },
          { to: 'request', call: 'reject', args: [] },
        ])
        const next = screen.state().initialMessage!
        expect(next.clearContext).toBe(true)
        expect(next.mode).toBe(c.mode as PermissionMode)
        expect<unknown>(next.allowedPrompts).toEqual(allowedPrompts)
        expect((next.message as { planContent?: string }).planContent).toBe(PLAN)
        expect(next.message.type).toBe('user')
        const content = next.message.message.content as string
        expect(content.startsWith(`Implement the following plan:\n\n${PLAN}\n\n`)).toBe(true)
        expect(content).toContain(`read the full transcript at: ${getTranscriptPath()}`)
        expect(content).toContain('exact code snippets, error messages')
        expect(content).not.toContain('TeamCreate')
        expect(content).not.toContain('User feedback on this plan')
        expect(sessionFlags()).toEqual({ exitedPlan: true, planExitNotice: false, autoExitNotice: false })
      },
      SLOW,
    )
  }

  test(
    'with agent teams on, the message suggests a team; feedback typed under "No" is appended',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const { screen } = await open({ clear: true })
      await screen.press(KEYS.down, KEYS.down, KEYS.down, ...'  add docs  ', KEYS.up, KEYS.up, KEYS.up, KEYS.enter)
      const content = screen.state().initialMessage!.message.message.content as string
      const team = content.indexOf('using the TeamCreate tool to create a team')
      const feedback = content.indexOf('\n\nUser feedback on this plan: add docs')
      expect(team).toBeGreaterThan(content.indexOf('read the full transcript'))
      expect(content).toContain('broken down into multiple independent tasks')
      expect(feedback).toBeGreaterThan(team)
      expect(content.endsWith('User feedback on this plan: add docs')).toBe(true)
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: feedback, declining and Esc', () => {
  const declined: Ledger = [
    { to: 'caller', call: 'done' },
    { to: 'caller', call: 'reject' },
    { to: 'request', call: 'reject', args: [] },
  ]
  test(
    'Esc turns the plan down with no reason, and the session stays in plan',
    async () => {
      const { screen, ledger } = await open({ bypass: true })
      await screen.press(KEYS.esc)
      expect(ledger).toEqual(declined)
      expect(sessionFlags()).toEqual({ exitedPlan: false, planExitNotice: false, autoExitNotice: false })
      expect(screen.state().initialMessage).toBeFalsy()
    },
    SLOW,
  )

  for (const typed of ['', '   ']) {
    test(
      `Enter on "No" with ${typed ? 'only spaces' : 'nothing'} typed turns the plan down with no reason, like Esc`,
      async () => {
        const { screen, ledger } = await open()
        await screen.press('3', ...typed, KEYS.enter)
        expect(ledger).toEqual(declined)
        expect(sessionFlags().exitedPlan).toBe(false)
      },
      SLOW,
    )
  }

  test(
    'typed feedback and Enter on "No" turn the plan down with the trimmed feedback as the reason',
    async () => {
      const { screen, ledger } = await open()
      await screen.press('3', ...'  split step 2  ', KEYS.enter)
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'caller', call: 'reject' },
        { to: 'request', call: 'reject', args: ['split step 2', undefined] },
      ])
      expect(sessionFlags().exitedPlan).toBe(false)
    },
    SLOW,
  )

  const carried: Array<{ how: string; keys: string[]; mode: string }> = [
    { how: 'moving up to "Yes, auto-accept edits"', keys: [KEYS.up, KEYS.up, KEYS.enter], mode: 'acceptEdits' },
    { how: 'moving up to "manually approve"', keys: [KEYS.up, KEYS.enter], mode: 'default' },
    { how: 'shift+tab from the field', keys: ['\x1B[Z'], mode: 'acceptEdits' },
  ]
  for (const { how, keys, mode } of carried) {
    test(
      `feedback typed under "No" rides along when approving by ${how}`,
      async () => {
        const { screen, ledger } = await open()
        await screen.press('3', ...' also update the README ', ...keys)
        expect(ledger).toEqual([
          { to: 'caller', call: 'done' },
          { to: 'request', call: 'allow', input: {}, updates: setMode(mode), feedback: 'also update the README' },
        ])
      },
      SLOW,
    )
  }
})

describe('ExitPlanModePermissionRequest: an empty plan', () => {
  for (const plan of [null, '   \n\t']) {
    test(
      `${plan === null ? 'no plan file' : 'a blank plan file'}: a short yes/no question`,
      async () => {
        const { screen, ledger } = await open({ plan, bypass: true, clear: true })
        const frame = screen.text()
        expect(flat(frame)).toContain('Exit plan mode?')
        expect(flat(frame)).toContain('Claude wants to exit plan mode')
        expect(answers(frame)).toEqual(['Yes', 'No'])
        expect(flat(frame)).not.toContain('Ready to code?')
        expect(ledger).toEqual([])
      },
      SLOW,
    )
  }

  const cases: Array<{ answer: string; keys: string[]; ledger: Ledger; flags: ReturnType<typeof sessionFlags> }> = [
    {
      answer: 'yes',
      keys: ['1'],
      ledger: [
        { to: 'caller', call: 'done' },
        { to: 'request', call: 'allow', input: {}, updates: setMode('default'), feedback: undefined },
      ],
      flags: { exitedPlan: true, planExitNotice: true, autoExitNotice: false },
    },
    {
      answer: 'no',
      keys: ['2'],
      ledger: [
        { to: 'caller', call: 'done' },
        { to: 'caller', call: 'reject' },
        { to: 'request', call: 'reject', args: [] },
      ],
      flags: { exitedPlan: false, planExitNotice: false, autoExitNotice: false },
    },
    {
      answer: 'Esc',
      keys: [KEYS.esc],
      ledger: [
        { to: 'caller', call: 'done' },
        { to: 'caller', call: 'reject' },
        { to: 'request', call: 'reject', args: [] },
      ],
      flags: { exitedPlan: false, planExitNotice: false, autoExitNotice: false },
    },
  ]
  for (const c of cases) {
    test(
      `${c.answer}: ${c.ledger.map(e => `${e.to} ${e.call}`).join(', ')}`,
      async () => {
        const { screen, ledger } = await open({ plan: null, bypass: true })
        await screen.press(...c.keys)
        // Even with bypass offered, an empty plan exits to the default mode.
        expect(ledger).toEqual(c.ledger)
        expect(sessionFlags()).toEqual(c.flags)
      },
      SLOW,
    )
  }

  test(
    'approving an empty plan does not name the session',
    async () => {
      const { screen } = await open({ plan: null })
      await screen.press('1')
      await settle()
      expect(namingRequests).toEqual([])
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: the sticky footer', () => {
  async function openSticky(setup: Setup = {}) {
    if (setup.plan !== null) writePlan(setup.plan ?? PLAN)
    const ledger: Ledger = []
    const confirm = planRequest(ledger)
    const base = getDefaultAppState()
    const host = (show: boolean) => (
      <StickyHost render={setFooter => (show ? <ExitPlanModePermissionRequest {...callerProps(ledger, confirm)} setStickyFooter={setFooter} /> : null)} />
    )
    const screen = await mount(host(true), {
      columns: 120,
      appState: {
        settings: { ...base.settings, showClearContextOnPlanAccept: false },
        toolPermissionContext: { ...base.toolPermissionContext, mode: 'plan', isBypassPermissionsModeAvailable: setup.bypass ?? false },
      },
      ready: frame => frame.includes('Would you like to proceed?') || frame.includes('Exit plan mode?'),
    })
    return { screen, ledger, hide: () => screen.replace(host(false)) }
  }

  test(
    'the answers move to the footer the layout supplies, and answer from there',
    async () => {
      const { screen, ledger } = await openSticky({ bypass: true })
      const text = flat(screen.text())
      expect(text).toContain('Would you like to proceed?')
      // Like the prompt's border, the footer's carries the working directory.
      expect(screen.text().trimEnd().split('\n').at(-1)).toContain(basename(getCwd()))
      expect(text).not.toContain('Claude has written up a plan and is ready to execute')
      expect(text).toContain('ctrl-g to edit in Vim')
      expect(answers(screen.text())).toEqual(['Yes, and bypass permissions', 'Yes, manually approve edits', 'Tell Claudin what to change'])
      // The plan still shows above it.
      expect(text).toContain('1. migrate the table')
      await screen.press('1')
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'request', call: 'allow', input: {}, updates: setMode('bypassPermissions'), feedback: undefined },
      ])
    },
    SLOW,
  )

  test(
    'Esc in the footer turns the plan down; leaving clears the footer',
    async () => {
      const { screen, ledger, hide } = await openSticky()
      await screen.press(KEYS.esc)
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'caller', call: 'reject' },
        { to: 'request', call: 'reject', args: [] },
      ])
      await hide()
      await screen.until(frame => !frame.includes('Would you like to proceed?'), 'the footer to clear')
    },
    SLOW,
  )

  test(
    'an empty plan keeps its own question and leaves the footer alone',
    async () => {
      const { screen } = await openSticky({ plan: null })
      const text = flat(screen.text())
      expect(text).toContain('Exit plan mode?')
      expect(text).not.toContain('Would you like to proceed?')
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: naming the session', () => {
  const cases: Array<{ answer: string; setup: Setup; keys: string[]; asks: boolean }> = [
    { answer: 'approving and keeping the context', setup: {}, keys: ['1'], asks: true },
    { answer: 'approving and clearing the context', setup: { clear: true }, keys: ['1'], asks: true },
    { answer: 'turning it down with feedback', setup: {}, keys: ['3', ...'no', KEYS.enter], asks: false },
    { answer: 'Esc', setup: {}, keys: [KEYS.esc], asks: false },
  ]
  for (const c of cases) {
    test(
      `${c.answer}: ${c.asks ? 'names the session after the plan' : 'leaves the session unnamed'}`,
      async () => {
        const { screen } = await open(c.setup)
        await screen.press(...c.keys)
        await settle()
        expect(namingRequests.length).toBe(c.asks ? 1 : 0)
        if (c.asks) expect(namingRequests[0]).toContain('migrate the table')
        expect(getCurrentSessionTitle(getSessionId())).toBe(c.asks ? 'plan-the-rollout' : undefined)
      },
      SLOW,
    )
  }

  test(
    'a session named by the user keeps its name when the plan is approved',
    async () => {
      await saveCustomTitle(getSessionId() as UUID, 'my-name')
      const { screen } = await open()
      await screen.press('2')
      await settle()
      expect(namingRequests).toEqual([])
      expect(getCurrentSessionTitle(getSessionId())).toBe('my-name')
      expect(existsSync(getTranscriptPath())).toBe(true)
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: editing the plan with ctrl+g', () => {
  let giveBack: (() => void) | undefined
  const useEditor = (body: string) => {
    process.env.VISUAL = fakeEditor(world().home, body)
    getExternalEditor.cache.clear?.()
  }
  afterEach(() => {
    giveBack?.()
    giveBack = undefined
    process.env.VISUAL = 'vim'
    getExternalEditor.cache.clear?.()
  })
  const CTRL_G = '\x07'

  test(
    'the editor opens the plan file itself; its edit shows at once and is sent with the approval',
    async () => {
      useEditor('printf "3. write the release notes\\n" >> "$1"')
      const { screen, ledger } = await open({ plan: `${PLAN}\n` })
      const path = getPlanFilePath()
      expect(flat(screen.text())).toContain('ctrl-g to edit in Plan-editor')
      giveBack = lendTerminalToEditor()
      await screen.press(CTRL_G)
      const edited = `${PLAN}\n3. write the release notes\n`
      expect(readFileSync(path, 'utf8')).toBe(edited)
      const text = flat(await screen.until(frame => frame.includes('write the release notes'), 'the edited plan'))
      expect(text).toContain('Plan saved!')
      await screen.press('2')
      // Once edited here, the plan travels in the input so the model sees the change.
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'request', call: 'allow', input: { plan: edited }, updates: setMode('default'), feedback: undefined },
      ])
    },
    SLOW,
  )

  test(
    'an editor that changes nothing still says saved, for five seconds, and the approval carries no plan',
    async () => {
      useEditor('true')
      const { screen, ledger } = await open()
      giveBack = lendTerminalToEditor()
      await screen.press(CTRL_G)
      await screen.until(frame => flat(frame).includes('Plan saved!'), 'the saved note')
      await Bun.sleep(4_000)
      expect(flat(screen.text())).toContain('Plan saved!')
      await screen.until(frame => !flat(frame).includes('Plan saved!'), 'the saved note to go')
      await screen.press('1')
      expect(ledger[1]).toEqual({ to: 'request', call: 'allow', input: {}, updates: setMode('acceptEdits'), feedback: undefined })
    },
    SLOW,
  )

  test(
    'an editor that fails raises a warning naming it and its exit code, and the plan stays',
    async () => {
      useEditor('exit 3')
      const { screen, ledger } = await open()
      giveBack = lendTerminalToEditor()
      await screen.press(CTRL_G)
      await Bun.sleep(200)
      const { current, queue } = screen.state().notifications
      expect([current, ...queue].filter(Boolean)).toEqual([
        { key: 'external-editor-error', text: 'Plan-editor exited with code 3', color: 'warning', priority: 'high' },
      ])
      expect(flat(screen.text())).not.toContain('Plan saved!')
      expect(ledger).toEqual([])
    },
    SLOW,
  )

  test(
    'in the sticky footer, the editor hint and the saved note sit under the answers',
    async () => {
      useEditor('printf "3. tag the release\\n" >> "$1"')
      writePlan(`${PLAN}\n`)
      const ledger: Ledger = []
      const confirm = planRequest(ledger)
      const base = getDefaultAppState()
      const screen = await mount(
        <StickyHost render={setFooter => <ExitPlanModePermissionRequest {...callerProps(ledger, confirm)} setStickyFooter={setFooter} />} />,
        {
          columns: 120,
          appState: { toolPermissionContext: { ...base.toolPermissionContext, mode: 'plan' } },
          ready: frame => frame.includes('Would you like to proceed?'),
        },
      )
      giveBack = lendTerminalToEditor()
      await screen.press(CTRL_G)
      const text = flat(await screen.until(frame => flat(frame).includes('Plan saved!'), 'the saved note'))
      expect(text.indexOf('Plan saved!')).toBeGreaterThan(text.indexOf('Would you like to proceed?'))
      expect(text).toMatch(/ctrl-g to edit in\s*Plan-editor/)
      expect(text).toContain('3. tag the release')
    },
    SLOW,
  )
})

describe('ExitPlanModePermissionRequest: images under "No"', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL_PNG } }
  async function withImage() {
    const opened = await open()
    await opened.screen.press('3', pasted(pngOnDisk(world().home)))
    await opened.screen.until(frame => frame.includes('[Image #'), 'the image chip')
    // The terminal's paste handling settles a moment after the chip shows; a key
    // pressed before that is swallowed by it, not by the dialog.
    await Bun.sleep(1_500)
    return opened
  }

  test(
    'an image alone turns the plan down, pointing at the image, with the image attached',
    async () => {
      const { screen, ledger } = await withImage()
      await screen.press(KEYS.enter)
      await untilReported(ledger, 3)
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'caller', call: 'reject' },
        { to: 'request', call: 'reject', args: ['(See attached image)', [image]] },
      ])
    },
    SLOW,
  )

  test(
    'with feedback typed too, the feedback is the reason and the image rides along',
    async () => {
      const { screen, ledger } = await withImage()
      await screen.press(...'like this mockup', KEYS.enter)
      await untilReported(ledger, 3)
      expect(ledger.at(-1)).toEqual({ to: 'request', call: 'reject', args: ['like this mockup', [image]] })
    },
    SLOW,
  )

  test(
    'a removed image is gone: the empty answer is a plain decline',
    async () => {
      const { screen, ledger } = await withImage()
      await screen.press(KEYS.down, '\x7f')
      await screen.until(frame => !frame.includes('[Image #'), 'the image to go')
      await screen.press(KEYS.enter)
      expect(ledger.at(-1)).toEqual({ to: 'request', call: 'reject', args: [] })
    },
    SLOW,
  )

  test(
    'approving drops the images: only typed feedback reaches the approval',
    async () => {
      const { screen, ledger } = await withImage()
      await screen.press(KEYS.up, KEYS.enter)
      expect(ledger).toEqual([
        { to: 'caller', call: 'done' },
        { to: 'request', call: 'allow', input: {}, updates: setMode('default'), feedback: undefined },
      ])
    },
    SLOW,
  )
})
