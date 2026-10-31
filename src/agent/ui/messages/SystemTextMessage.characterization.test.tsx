// Characterization of SystemTextMessage as it renders today, one test per
// `message.subtype` branch. Written before a change to how TurnDurationMessage
// derives its "· N background tasks still running" suffix, so the rest of the
// file is pinned while that one expression moves.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import React from 'react'
import stripAnsi from 'strip-ansi'

import {
  createAgentsKilledMessage,
  createAwaySummaryMessage,
  createBridgeStatusMessage,
  createPermissionRetryMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createSystemAPIErrorMessage,
  createSystemMessage,
  createTurnDurationMessage,
} from 'src/agent/messages/factories.js'
import { createMemorySavedMessage } from 'src/agent/messages/messages.js'
import { TURN_COMPLETION_VERBS } from 'src/agent/prompts/turnCompletionVerbs.js'
import type { TaskState } from 'src/agent/tasks/types.js'
import { SystemTextMessage } from 'src/agent/ui/messages/SystemTextMessage.js'
import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import type { SystemMessage } from 'src/shared/types/message.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

type RenderOpts = {
  verbose?: boolean
  addMargin?: boolean
  isTranscriptMode?: boolean
  tasks?: TaskState[]
}

async function render(message: SystemMessage, opts: RenderOpts = {}): Promise<string> {
  const initialState = {
    ...getDefaultAppState(),
    tasks: Object.fromEntries((opts.tasks ?? []).map(t => [t.id, t])),
  }
  return stripAnsi(
    await renderToString(
      <AppStateProvider initialState={initialState}>
        <SystemTextMessage
          message={message}
          addMargin={opts.addMargin ?? false}
          verbose={opts.verbose ?? false}
          isTranscriptMode={opts.isTranscriptMode}
        />
      </AppStateProvider>,
      160,
    ),
  )
}

const task = (type: string, id: string, over: Record<string, unknown> = {}) =>
  taskFixture(type, { id, ...over }) as unknown as TaskState

describe('turn_duration', () => {
  test('says "<verb> for <duration>" with a verb from the completion list', async () => {
    const line = (await render(createTurnDurationMessage(393_000))).trim()
    expect(line).toContain('for 6m 33s')
    const verb = line.replace(/^\S+\s+/, '').split(' for ')[0]
    expect(TURN_COMPLETION_VERBS).toContain(verb)
  })

  test('no background tasks: no suffix', async () => {
    expect(await render(createTurnDurationMessage(393_000))).not.toContain('still running')
  })

  test('one running local_bash task: "· 1 shell still running"', async () => {
    const line = await render(createTurnDurationMessage(393_000), { tasks: [task('local_bash', 'b1')] })
    expect(line).toContain('for 6m 33s · 1 shell still running')
  })

  test('two tasks of different types: "· 2 background tasks still running"', async () => {
    const line = await render(createTurnDurationMessage(393_000), {
      tasks: [task('local_bash', 'b1'), task('local_agent', 'a1')],
    })
    expect(line).toContain('for 6m 33s · 2 background tasks still running')
  })

  test('a finished task does not count', async () => {
    const line = await render(createTurnDurationMessage(393_000), {
      tasks: [task('local_bash', 'b1', { status: 'completed' })],
    })
    expect(line).not.toContain('still running')
  })

  test('a budget under its limit shows tokens / limit (pct) and the nudges', async () => {
    const line = await render(createTurnDurationMessage(1_000, { tokens: 250_000, limit: 500_000, nudges: 2 }))
    expect(line).toContain('for 1s · 250.0k / 500.0k (50%) · 2 nudges')
  })

  test('a budget at its limit says "used (… min ✔)", one nudge singular', async () => {
    const line = await render(createTurnDurationMessage(1_000, { tokens: 600_000, limit: 500_000, nudges: 1 }))
    expect(line).toContain('600.0k used (500.0k min ✔) · 1 nudge')
    expect(line).not.toContain('nudges')
  })

  test('a budget with no nudges has no nudge text', async () => {
    const line = await render(createTurnDurationMessage(1_000, { tokens: 1, limit: 4, nudges: 0 }))
    expect(line).toContain('1 / 4 (25%)')
    expect(line).not.toContain('nudge')
  })

  describe('with showTurnDuration off', () => {
    let saved: boolean | undefined
    beforeEach(() => {
      saved = getGlobalConfig().showTurnDuration
      saveGlobalConfig(c => ({ ...c, showTurnDuration: false }))
    })
    afterEach(() => {
      saveGlobalConfig(c => ({ ...c, showTurnDuration: saved ?? true }))
    })

    test('renders nothing without a budget', async () => {
      expect((await render(createTurnDurationMessage(393_000))).trim()).toBe('')
    })

    test('renders only the budget, without the leading separator', async () => {
      const line = (await render(createTurnDurationMessage(393_000, { tokens: 1, limit: 4, nudges: 0 }))).trim()
      expect(line).not.toContain('for 6m 33s')
      expect(line).toMatch(/^\S+\s+1 \/ 4 \(25%\)$/)
    })
  })
})

describe('memory_saved', () => {
  test('one row per written file, by basename', async () => {
    const out = await render(createMemorySavedMessage(['/repo/.claudin/memory/a.md', '/repo/.claudin/memory/b.md']))
    expect(out).toContain('Saved 2 memories')
    expect(out).toContain('a.md')
    expect(out).toContain('b.md')
    expect(out).not.toContain('/repo/.claudin')
  })
})

describe('away_summary', () => {
  test('renders the summary text', async () => {
    expect(await render(createAwaySummaryMessage('While you were away: built the thing'))).toContain(
      'While you were away: built the thing',
    )
  })
})

describe('agents_killed', () => {
  test('says all background agents stopped', async () => {
    expect(await render(createAgentsKilledMessage())).toContain('All background agents stopped')
  })
})

describe('bridge_status', () => {
  test('shows the remote-control line and the url', async () => {
    const out = await render(createBridgeStatusMessage('https://example.test/s/1'))
    expect(out).toContain('/remote-control is active. Code in CLI or at')
    expect(out).toContain('https://example.test/s/1')
    expect(out).not.toContain('⎿')
  })

  test('adds the upgrade nudge when present', async () => {
    const out = await render(createBridgeStatusMessage('https://example.test/s/1', 'Upgrade for more'))
    expect(out).toContain('⎿ Upgrade for more')
  })
})

describe('scheduled_task_fire', () => {
  test('renders the content', async () => {
    expect(await render(createScheduledTaskFireMessage('Running nightly sweep'))).toContain('Running nightly sweep')
  })
})

describe('permission_retry', () => {
  test('lists the allowed commands comma-separated', async () => {
    expect(await render(createPermissionRetryMessage(['git status', 'ls']))).toContain('Allowed git status, ls')
  })
})

describe('informational', () => {
  test('an info message is hidden unless verbose', async () => {
    const msg = createSystemMessage('just so you know', 'info')
    expect((await render(msg)).trim()).toBe('')
    expect(await render(msg, { verbose: true })).toContain('just so you know')
  })

  test('a warning renders with a dot, trimmed', async () => {
    const out = await render(createSystemMessage('   careful now   ', 'warning'))
    expect(out).toMatch(/\S\s+careful now/)
  })

  test('an error renders', async () => {
    expect(await render(createSystemMessage('it broke', 'error'))).toContain('it broke')
  })

  test('non-string content renders nothing', async () => {
    const msg = { ...createSystemMessage('x', 'warning'), content: undefined } as unknown as SystemMessage
    expect((await render(msg)).trim()).toBe('')
  })
})

describe('api_error', () => {
  test('a retrying server error shows the retry line from the fourth attempt', async () => {
    const error = APIError.generate(500, undefined, 'internal error', new Headers())
    expect(await render(createSystemAPIErrorMessage(error, 3_000, 4, 10))).toContain('Retrying in')
    expect(await render(createSystemAPIErrorMessage(error, 3_000, 1, 10))).not.toContain('Retrying in')
  })
})

describe('stop_hook_summary', () => {
  const infos = [
    { command: 'echo done', durationMs: 10 },
    { command: 'prompt', promptText: 'Did you finish?', durationMs: 20 },
  ]

  test('with no errors, no prevention and no label it renders nothing', async () => {
    const msg = createStopHookSummaryMessage(2, infos, [], false, undefined, false, 'info')
    expect((await render(msg)).trim()).toBe('')
  })

  test('labelled: "Ran N <label> hooks", the commands only in transcript mode', async () => {
    const msg = createStopHookSummaryMessage(2, infos, [], false, undefined, false, 'info', undefined, 'PreToolUse')
    const plain = await render(msg)
    expect(plain).toContain('Ran 2 PreToolUse hooks')
    expect(plain).not.toContain('echo done')

    const transcript = await render(msg, { isTranscriptMode: true })
    expect(transcript).toContain('echo done')
    expect(transcript).toContain('prompt: Did you finish?')
  })

  test('labelled with one hook says "hook"', async () => {
    const msg = createStopHookSummaryMessage(1, [infos[0]!], [], false, undefined, false, 'info', undefined, 'Stop')
    expect(await render(msg)).toContain('Ran 1 Stop hook')
    expect(await render(msg)).not.toContain('Stop hooks')
  })

  test('errors: "Ran N stop hooks" with one "Stop hook error" row each', async () => {
    const msg = createStopHookSummaryMessage(2, infos, ['boom', 'bang'], false, undefined, false, 'warning')
    const out = await render(msg)
    expect(out).toContain('Ran 2 stop hooks')
    expect(out).toContain('Stop hook error: boom')
    expect(out).toContain('Stop hook error: bang')
    // Non-verbose: the commands are folded behind the expand hint
    expect(out).not.toContain('echo done')
    expect(out).toContain('expand')
  })

  test('verbose lists each command, the prompt hook as "prompt: <text>"', async () => {
    const msg = createStopHookSummaryMessage(2, infos, ['boom'], false, undefined, false, 'warning')
    const out = await render(msg, { verbose: true })
    expect(out).toMatch(/⎿\s+echo done/)
    expect(out).toMatch(/⎿\s+prompt: Did you finish\?/)
    expect(out).not.toContain('expand')
  })

  test('a prevented continuation shows the stop reason', async () => {
    const msg = createStopHookSummaryMessage(1, [], [], true, 'Tests are failing', false, 'warning')
    const out = await render(msg)
    expect(out).toContain('Ran 1 stop hook')
    expect(out).toMatch(/⎿\s+Tests are failing/)
  })
})
