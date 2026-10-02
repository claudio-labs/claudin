/**
 * The REPL screen as someone at the keyboard meets it: a whole <REPL> on the
 * fake terminal, keys in, the painted frame and the app store read back.
 *
 * A turn never reaches a model. The `onBeforeQuery` prop sees each turn and
 * either refuses it or holds it open until the test lets go; that is how "a
 * turn is running" is set up here.
 *
 * Left out on purpose, because the lever deletes them: the remote, direct-
 * connect and SSH session hooks, remote-agent task restore and the bridge.
 * Submit-path behaviour (stash, immediate commands, history) is pinned beside
 * useOnSubmit.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Text } from 'src/terminal/ink.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { createAssistantMessage, createProgressMessage, createStopHookSummaryMessage, createUserMessage } from 'src/agent/messages/factories.js'
import { createAttachmentMessage } from 'src/agent/attachments/shared.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { closeSidePanel, openSidePanel } from 'src/terminal/sidePanelStore.js'
import { restoreWorktreeSession } from 'src/vcs/git/worktree/session.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { getCommandQueue } from 'src/agent/messageQueueManager.js'
import { setupReplMocks, teardownReplMocks } from 'src/agent/repl/__testutils__/replTestHarness.js'
import {
  KEY,
  fixtureCommand,
  gate,
  mountLiveRepl,
  promptRow,
  releaseAllRepls,
  settle,
  transcriptPart,
  type LiveRepl,
  type MountOptions,
} from 'src/agent/repl/__testutils__/liveRepl.js'

const TIMEOUT = 60_000
const SPINNER = 'esc to interrupt'
const DETAILED = 'Showing detailed transcript'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)
afterEach(releaseAllRepls)

/** A REPL whose turns are recorded and, while held, kept running. */
async function replWithTurns(options: MountOptions = {}) {
  const inputs: string[] = []
  const conversations: Message[][] = []
  let hold: ReturnType<typeof gate<boolean>> | null = null
  const repl = await mountLiveRepl({
    ...options,
    props: {
      ...options.props,
      onBeforeQuery: async (input, conversation) => {
        inputs.push(input)
        conversations.push([...conversation])
        return hold ? hold.promise : false
      },
    },
  })
  return {
    repl,
    inputs,
    conversations,
    holdNextTurn() {
      hold = gate<boolean>()
    },
    async startTurn(text: string) {
      hold = gate<boolean>()
      await send(repl, text)
      await repl.waitFor('the spinner', screen => screen.includes(SPINNER))
      await settle()
    },
    release() {
      const open = hold
      hold = null
      open?.open(false)
    },
  }
}

async function send(repl: LiveRepl, text: string): Promise<void> {
  await repl.type(text)
  await repl.type(KEY.enter)
}

function withState(change: (state: Record<string, unknown>) => void): (base: AppState) => AppState {
  return base => {
    const next = { ...base } as unknown as Record<string, unknown>
    change(next)
    return next as unknown as AppState
  }
}

describe('a running turn', () => {
  test('shows the spinner, and Esc stops it and hands the prompt back once the turn settles', async () => {
    const { repl, startTurn, release } = await replWithTurns()
    await startTurn('a question to take back')
    await repl.type(KEY.escape)
    await repl.waitFor('the spinner to go', screen => !screen.includes(SPINNER))

    release()
    const screen = await repl.waitFor('the prompt back', s => promptRow(s) === '❯ a question to take back')
    expect(transcriptPart(screen)).not.toContain('a question to take back')
  }, TIMEOUT)

  test('a prompt sent meanwhile waits in the queue and runs right after', async () => {
    const { repl, inputs, startTurn, release } = await replWithTurns()
    await startTurn('first')
    await send(repl, 'second')
    await repl.waitFor('the queued prompt', screen => screen.includes('second'))
    expect(getCommandQueue().map(command => command.value)).toEqual(['second'])
    expect(inputs).toEqual(['first'])

    release()
    await repl.waitFor('the queued turn', () => inputs.length === 2)
    expect(inputs).toEqual(['first', 'second'])
  }, TIMEOUT)

  test('a command that stops foreground work ends the turn, empties the queue and kills running agents', async () => {
    const stop = fixtureCommand('stop', {
      immediate: true,
      view: run => {
        run.context.stopForegroundWork?.()
        run.done()
        return null
      },
    })
    const agent = localAgent('agent-stop', 'running')
    const { repl, inputs, startTurn, release } = await replWithTurns({
      props: { commands: [stop.command] },
      state: withState(s => {
        s.tasks = { [agent.id]: agent }
      }),
    })
    await startTurn('busy')
    await send(repl, 'waiting in line')
    await repl.waitFor('the queued prompt', screen => screen.includes('waiting in line'))
    await send(repl, '/stop')
    await repl.waitFor('the spinner to go', screen => !screen.includes(SPINNER))

    // Dropped, not run: had it stayed queued it would start the moment the
    // stopped turn let go of the guard.
    await Bun.sleep(300)
    expect(inputs).toEqual(['busy'])
    expect(getCommandQueue()).toEqual([])
    const tasks = repl.store().getState().tasks as Record<string, { status: string }>
    expect(tasks[agent.id]!.status).toBe('killed')
    release()
  }, TIMEOUT)
})

describe('the detailed transcript (ctrl+o)', () => {
  test('opens over the prompt, and each exit key brings the prompt back', async () => {
    const { repl, inputs } = await replWithTurns()
    await send(repl, 'something to look at')
    await repl.waitFor('the turn', () => inputs.length === 1)

    for (const exit of [KEY.ctrlO, KEY.escape, 'q']) {
      await repl.type(KEY.ctrlO)
      const open = await repl.waitFor('the transcript', screen => screen.includes(DETAILED))
      await settle()
      expect(open).toContain('something to look at')
      expect(promptRow(open)).not.toStartWith('❯')
      await repl.type(exit)
      await repl.waitFor(`the prompt after ${JSON.stringify(exit)}`, s => !s.includes(DETAILED) && promptRow(s) === '❯')
    }
  }, TIMEOUT)
})

describe('in fullscreen', () => {
  const FULLSCREEN = { CLAUDIN_NO_FLICKER: '1', VISUAL: undefined, EDITOR: undefined }

  async function fullscreenWith(prompts: string[], env: Record<string, string | undefined> = {}) {
    const ctx = await replWithTurns({ env: { ...FULLSCREEN, ...env } })
    for (const text of prompts) {
      await send(ctx.repl, text)
      await ctx.repl.waitFor(`turn "${text}"`, () => ctx.inputs.includes(text))
    }
    await ctx.repl.type(KEY.ctrlO)
    await ctx.repl.waitFor('the transcript', screen => screen.includes(DETAILED))
    await settle()
    return ctx
  }

  test('/ searches the transcript and shows where the match is', async () => {
    const { repl } = await fullscreenWith(['alpha one', 'beta two', 'beta three'])
    await repl.type('/')
    await repl.type('beta')
    await repl.type(KEY.enter)
    const counted = await repl.waitFor('the match count', screen => /n\/N to navigate\s+\d\/2/.test(screen))
    const before = /(\d)\/2/.exec(counted)![1]
    await repl.type('n')
    await repl.waitFor('the next match', screen => {
      const now = /(\d)\/2/.exec(screen)
      return now !== null && now[1] !== before
    })
  }, TIMEOUT)

  test('v renders the transcript to a temp file and hands that file to $VISUAL', async () => {
    // A stand-in editor: its name reads as a GUI editor, so it is spawned
    // detached, and all it does is record the path it was given.
    const editorDir = mkdtempSync(join(tmpdir(), 'repl-editor-'))
    const stub = join(editorDir, 'code-stub')
    const opened = join(editorDir, 'opened')
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`)
    chmodSync(stub, 0o755)
    getExternalEditor.cache.clear?.()
    try {
      const { repl } = await fullscreenWith(['write me down'], { VISUAL: stub })
      await repl.type('v')
      await repl.waitFor('the editor', () => existsSync(opened))
      const written = readdirSync(join(repl.dir, 'tmp')).filter(name => name.startsWith('cc-transcript-'))
      expect(written).toHaveLength(1)
      const path = join(repl.dir, 'tmp', written[0]!)
      await repl.waitFor('the path to land', () => readFileSync(opened, 'utf8') === path)
      expect(readFileSync(path, 'utf8')).toContain('write me down')
      await repl.waitFor('the note', s => s.includes(`opening ${join(repl.dir, 'tmp')}`))
    } finally {
      getExternalEditor.cache.clear?.()
      rmSync(editorDir, { recursive: true, force: true })
    }
  }, TIMEOUT)

  test('[ switches to the scrollback dump, after which / no longer opens a search', async () => {
    const { repl } = await fullscreenWith(['dump this', 'dump that'])
    await repl.type('[')
    await repl.type('/')
    await repl.type('dump')
    await repl.type(KEY.enter)
    await Bun.sleep(300)
    expect(repl.screen()).not.toMatch(/\d\/2/)
    expect(repl.screen()).toContain(DETAILED)
  }, TIMEOUT)

  // DEFECT: `q` is bound to transcript:exit, but in fullscreen the REPL's own
  // transcript key handler takes `q`, runs only its frozen-state reset and
  // stops the key there, so the transcript stays open. Esc still leaves.
  test('q does not leave the transcript (Esc does)', async () => {
    const { repl } = await fullscreenWith(['stay here'])
    await repl.type('q')
    await Bun.sleep(300)
    expect(repl.screen()).toContain(DETAILED)
    await repl.type(KEY.escape)
    await repl.waitFor('the prompt', s => !s.includes(DETAILED) && promptRow(s) === '❯')
  }, TIMEOUT)

  test('page up scrolls back through a long conversation', async () => {
    const history = Array.from({ length: 40 }, (_, i) => createUserMessage({ content: `old line ${i}` }))
    const repl = await mountLiveRepl({ env: FULLSCREEN, props: { initialMessages: history } })
    await repl.waitFor('the newest line', screen => screen.includes('old line 39'))
    expect(repl.screen()).not.toContain('old line 5\n')
    for (let i = 0; i < 6; i++) await repl.type(KEY.pageUp)
    await repl.waitFor('older lines', screen => /old line 1\d\b/.test(screen) && !screen.includes('old line 39'))
  }, TIMEOUT)

  test('a side panel opens beside the chat with the conversation, and follows the turns', async () => {
    const seen: Array<{ count: number; nonce: number }> = []
    function Reviewer(props: { messages: Message[]; changeNonce: number }): React.ReactNode {
      seen.push({ count: props.messages.length, nonce: props.changeNonce })
      return <Text>{`reviewer sees ${props.messages.length} at ${props.changeNonce}`}</Text>
    }
    const { repl, inputs } = await replWithTurns({ env: FULLSCREEN, columns: 160 })
    await send(repl, 'before the panel')
    await repl.waitFor('the turn', () => inputs.length === 1)

    openSidePanel(Reviewer)
    await repl.waitFor('the panel', screen => screen.includes('reviewer sees'))
    expect(promptRow(repl.screen())).toContain('❯')
    const atOpen = seen.at(-1)!
    expect(atOpen.count).toBeGreaterThan(0)

    await send(repl, 'with the panel open')
    await repl.waitFor('the turn', () => inputs.length === 2)
    await repl.waitFor('the panel to follow', () => {
      const last = seen.at(-1)!
      return last.nonce === atOpen.nonce + 1 && last.count > atOpen.count
    })

    closeSidePanel()
    await repl.waitFor('the panel to close', screen => !screen.includes('reviewer sees'))
  }, TIMEOUT)
})

describe('a resumed conversation', () => {
  test('is on screen from the first frame', async () => {
    const repl = await mountLiveRepl({
      props: {
        initialMessages: [
          createUserMessage({ content: 'what did we decide' }),
          createAssistantMessage({ content: 'we kept the parser' }),
        ],
      },
    })
    const screen = await repl.waitFor('the old turn', s => s.includes('we kept the parser'))
    expect(transcriptPart(screen)).toContain('what did we decide')
  }, TIMEOUT)

  const stopHook = (toolUseID: string, hookEvent: 'Stop' | 'SubagentStop', statusMessage?: string): Message =>
    createProgressMessage({
      toolUseID,
      parentToolUseID: toolUseID,
      data: { type: 'hook_progress', hookEvent, hookName: hookEvent, command: 'check.sh', statusMessage },
    }) as unknown as Message
  const finished = (toolUseID: string): Message =>
    createAttachmentMessage({
      type: 'hook_success',
      hookName: 'Stop',
      hookEvent: 'Stop',
      toolUseID,
      content: '',
      command: 'check.sh',
    } as never) as unknown as Message

  const suffixes: Array<{ name: string; messages: Message[]; shows: string | null }> = [
    { name: 'one stop hook', messages: [stopHook('h1', 'Stop')], shows: 'running stop hook' },
    { name: 'one subagent stop hook', messages: [stopHook('h1', 'SubagentStop')], shows: 'running subagent stop hook' },
    {
      name: 'two hooks, one finished',
      messages: [stopHook('h1', 'Stop'), stopHook('h1', 'Stop'), finished('h1')],
      shows: 'running stop hooks… 1/2',
    },
    { name: 'a status message', messages: [stopHook('h1', 'Stop', 'Linting')], shows: 'Linting…' },
    {
      name: 'a status message over two hooks',
      messages: [stopHook('h1', 'Stop', 'Linting'), stopHook('h1', 'Stop')],
      shows: 'Linting… 0/2',
    },
    {
      name: 'only an older execution',
      messages: [stopHook('old', 'Stop'), stopHook('h2', 'Stop')],
      shows: 'running stop hook',
    },
    {
      name: 'hooks already summarised',
      messages: [
        stopHook('h1', 'Stop'),
        createStopHookSummaryMessage(1, [], [], false, undefined, false, 'info', 'h1') as unknown as Message,
      ],
      shows: null,
    },
  ]

  for (const { name, messages, shows } of suffixes) {
    test(`with stop hooks in flight, the spinner names them: ${name}`, async () => {
      const ctx = await replWithTurns({ props: { initialMessages: messages } })
      await ctx.startTurn('go')
      const screen = ctx.repl.screen()
      if (shows === null) {
        expect(screen).not.toMatch(/stop hook|Linting/)
      } else {
        await ctx.repl.waitFor(`the suffix ${shows}`, s => s.includes(shows))
      }
      ctx.release()
    }, TIMEOUT)
  }
})

describe('an initial message left in the app state', () => {
  const cases: Array<{
    name: string
    message: Record<string, unknown>
    check: (repl: LiveRepl, inputs: string[]) => Promise<void> | void
  }> = [
    {
      name: 'is submitted as a prompt on mount',
      message: {},
      check: (_repl, inputs) => {
        expect(inputs).toEqual(['carry on with the plan'])
      },
    },
    {
      name: 'switches the permission mode it names',
      message: { mode: 'acceptEdits' },
      check: repl => {
        const state = repl.store().getState()
        expect(state.toolPermissionContext.mode).toBe('acceptEdits')
        expect(state.initialMessage).toBeNull()
      },
    },
    {
      name: 'clears the earlier conversation first when asked',
      message: { clearContext: true },
      check: async repl => {
        await repl.waitFor('the old turn to go', screen => !screen.includes('earlier exchange'))
      },
    },
  ]

  for (const { name, message, check } of cases) {
    test(name, async () => {
      const ctx = await replWithTurns({
        props: { initialMessages: [createUserMessage({ content: 'earlier exchange' })] },
        state: withState(s => {
          s.initialMessage = { message: createUserMessage({ content: 'carry on with the plan' }), ...message }
        }),
      })
      await ctx.repl.waitFor('the turn', () => ctx.inputs.length === 1)
      await check(ctx.repl, ctx.inputs)
    }, TIMEOUT)
  }
})

/** What every task in the store carries, whatever its kind. */
function taskShell(id: string, kind: string, status: string) {
  return { id, type: kind, status, description: `${kind} ${id}`, startTime: Date.now(), outputFile: '', outputOffset: 0, notified: false }
}

const NOTHING_REPORTED = Object.fromEntries(
  ['lastReportedToolCount', 'lastReportedTokenCount'].map(field => [field, 0]),
)

function localAgent(id: string, status: string, extra: Record<string, unknown> = {}) {
  const flags = { retrieved: false, isBackgrounded: true, retain: true, diskLoaded: true }
  return {
    ...taskShell(id, 'local_agent', status),
    ...NOTHING_REPORTED,
    ...flags,
    agentId: id,
    agentType: 'general-purpose',
    prompt: 'do the thing',
    pendingMessages: [] as string[],
    messages: [createUserMessage({ content: `brief for ${id}` })],
    ...extra,
  }
}

function teammate(id: string) {
  const identity = { agentId: `${id}@team`, agentName: id, teamName: 'team', planModeRequired: false, parentSessionId: 'lead' }
  const flags = { isIdle: false, shutdownRequested: false, awaitingPlanApproval: false }
  return {
    ...taskShell(id, 'in_process_teammate', 'running'),
    ...NOTHING_REPORTED,
    ...flags,
    identity,
    prompt: 'help out',
    pendingUserMessages: [] as string[],
    messages: [] as Message[],
    permissionMode: 'default',
  }
}

describe('while an agent is being viewed', () => {
  function viewing(task: { id: string }) {
    return withState(s => {
      s.tasks = { [task.id]: task }
      s.viewingAgentTaskId = task.id
      s.viewSelectionMode = 'viewing-agent'
    })
  }

  test('a running agent gets the typed text in its transcript and its pending queue', async () => {
    const agent = localAgent('agent-live', 'running')
    const { repl, inputs } = await replWithTurns({ state: viewing(agent) })
    await repl.waitFor('the agent transcript', screen => screen.includes('brief for agent-live'))
    await send(repl, 'also check the tests')
    await repl.waitFor('the message in the agent view', screen => screen.includes('also check the tests'))

    const task = repl.store().getState().tasks[agent.id] as unknown as { pendingMessages: string[] }
    expect(task.pendingMessages).toEqual(['also check the tests'])
    expect(inputs).toEqual([])
  }, TIMEOUT)

  test('a finished agent that cannot be resumed says so', async () => {
    const agent = localAgent('agent-done', 'completed')
    const { repl, inputs } = await replWithTurns({ state: viewing(agent) })
    await send(repl, 'one more thing')
    await repl.waitFor('the failure note', screen => screen.includes('Failed to resume agent'))
    expect(inputs).toEqual([])
  }, TIMEOUT)

  test('an agent the view holds but has not read from disk is marked loaded, its live messages kept', async () => {
    const agent = localAgent('agent-cold', 'running', { diskLoaded: false })
    const repl = await mountLiveRepl({ state: viewing(agent) })
    await repl.waitFor('the bootstrap', () => {
      const task = repl.store().getState().tasks[agent.id] as unknown as { diskLoaded: boolean }
      return task.diskLoaded
    })
    const task = repl.store().getState().tasks[agent.id] as unknown as { messages: Message[] }
    expect(task.messages.map(m => m.uuid)).toEqual(agent.messages.map(m => m.uuid))
  }, TIMEOUT)

  test('a teammate gets the typed text as a pending user message', async () => {
    const mate = teammate('mate')
    const { repl, inputs } = await replWithTurns({ state: viewing(mate) })
    await send(repl, 'please rebase')
    await repl.waitFor('the delivery', () => {
      const task = repl.store().getState().tasks[mate.id] as unknown as { pendingUserMessages: string[] }
      return task.pendingUserMessages.length === 1
    })
    const task = repl.store().getState().tasks[mate.id] as unknown as { pendingUserMessages: string[] }
    expect(task.pendingUserMessages).toEqual(['please rebase'])
    expect(inputs).toEqual([])
  }, TIMEOUT)
})

describe('notices', () => {
  test('rings the bell when a turn ended and nobody has touched the prompt since', async () => {
    try {
      const { repl, inputs } = await replWithTurns({
        prepare: () => {
          saveGlobalConfig(config => ({ ...config, messageIdleNotifThresholdMs: 40, preferredNotifChannel: 'terminal_bell' }))
        },
      })
      // BEL also ends every OSC sequence (the window title is one), so only a
      // BEL standing on its own counts as the bell.
      const bells = () => repl.terminal.transcript().replace(/\u001B\][^\u0007]*\u0007/g, '').split('\u0007').length - 1
      await send(repl, 'ping')
      await repl.waitFor('the turn', () => inputs.length === 1)
      expect(bells()).toBe(0)
      await repl.waitFor('the bell', () => bells() === 1, 5_000)
    } finally {
      resetGlobalConfigForTests()
    }
  }, TIMEOUT)

  test('a slow worktree creation without sparse paths suggests them, once', async () => {
    restoreWorktreeSession({
      originalCwd: '/nowhere',
      worktreePath: '/nowhere/wt',
      worktreeName: 'wt',
      sessionId: 'session',
      creationDurationMs: 21_400,
    })
    try {
      const { repl, conversations } = await replWithTurns()
      for (const text of ['one', 'two']) {
        await send(repl, text)
        await repl.waitFor(`turn "${text}"`, () => conversations.length === (text === 'one' ? 1 : 2))
      }
      const tips = conversations[1]!.filter(
        m => m.type === 'system' && String((m as { content?: unknown }).content).startsWith('Worktree creation took 21s'),
      )
      expect(tips).toHaveLength(1)
    } finally {
      restoreWorktreeSession(null)
    }
  }, TIMEOUT)
})
