/**
 * Characterization of `SessionPreview`, the read-only view of one session
 * that the session list opens on Ctrl+V, written before its clean-base
 * rewrite.
 *
 * The list hands it a session as the list loaded it: an entry that knows its
 * transcript but carries no messages yet. The preview reads the conversation
 * itself, shows it as the transcript view would, with a footer giving the
 * session's age, its message count and its branch, and answers two keys:
 * Enter to resume, Esc to go back.
 *
 * Sessions here are copies of the fixture transcript, listed by the same
 * loader the picker uses, so the entries are the ones the preview gets in
 * the app.
 */
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { loadFullLog, loadSameRepoMessageLogsProgressive } from 'src/sessions/sessionStorage.js'
import { KEYS, mountInApp, placeSession, type SessionCopy, useResumeWorld } from 'src/sessions/ui/__testutils__/resumeRig.js'
import { SessionPreview } from 'src/sessions/ui/SessionPreview.js'
import type { LogOption } from 'src/shared/types/logs.js'

const TIMEOUT = 30_000
const world = useResumeWorld()

const CONVERSATION = ['Let us fix the parser.', 'On it.', 'That is all for now.']

/** The session as the list hands it over: listed, not yet read. */
async function listedSession(copy: Partial<SessionCopy> = {}): Promise<{ log: LogOption; transcript: string }> {
  const { id, transcript } = placeSession({ project: world.sandbox.projectDir, ...copy })
  const { logs } = await loadSameRepoMessageLogsProgressive([world.sandbox.projectDir])
  const log = logs.find(entry => entry.sessionId === id)
  if (!log) throw new Error('the loader did not list the placed session')
  return { log, transcript }
}

type Calls = { exits: number; selected: LogOption[] }

async function preview(log: LogOption) {
  const calls: Calls = { exits: 0, selected: [] }
  const handlers = {
    onExit: () => {
      calls.exits++
    },
    onSelect: (chosen: LogOption) => {
      calls.selected.push(chosen)
    },
  }
  const view = await mountInApp(<SessionPreview log={log} {...handlers} />)
  return { view, calls }
}

/** The text of the frame that showed the loading notice, or '' if none did. */
function loadingFrame(painted: string): string {
  const frames = painted.split('\u001B[?2026h').map(frame => stripAnsi(frame))
  return frames.find(frame => frame.includes('Loading session…')) ?? ''
}

/** The footer: the last two non-empty lines of the screen. */
function footer(screen: string): string[] {
  return screen
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-2)
}

describe('SessionPreview', () => {
  test('a listed session is read first, then shown with its age, message count and branch', async () => {
    const { log } = await listedSession({ minutesAgo: 30 })
    expect(log.messages).toEqual([])
    const { view } = await preview(log)
    const shown = await view.waitFor('3 messages')
    expect(loadingFrame(view.painted())).toContain('Esc to cancel')
    expect(loadingFrame(view.painted())).not.toContain('Enter to resume')
    for (const line of CONVERSATION) expect(shown).toContain(line)
    expect(footer(shown)).toEqual(['30m ago · 3 messages · parser-fix', 'Enter to resume · Esc to cancel'])
  }, TIMEOUT)

  const footers = [
    { name: 'no branch: no branch part', copy: { branch: null }, expected: '2h ago · 3 messages' },
    { name: 'another branch, a longer conversation', copy: { branch: 'lexer-work', reply: 'And the lexer?', minutesAgo: 3 }, expected: '3m ago · 4 messages · lexer-work' },
  ]
  for (const { name, copy, expected } of footers) {
    test(`footer, ${name}`, async () => {
      const { log } = await listedSession({ minutesAgo: 120, ...copy })
      const { view } = await preview(log)
      const shown = await view.waitFor('messages')
      expect(footer(shown)[0]).toBe(expected)
    }, TIMEOUT)
  }

  test('Enter hands back the session with its conversation read', async () => {
    const { log } = await listedSession()
    const { view, calls } = await preview(log)
    await view.waitFor('3 messages')
    await Bun.sleep(100)
    await view.press(KEYS.enter)
    expect(calls.exits).toBe(0)
    expect(calls.selected).toHaveLength(1)
    const chosen = calls.selected[0]!
    expect(chosen.sessionId).toBe(log.sessionId)
    expect(chosen.messages.map(message => message.type)).toEqual(['user', 'assistant', 'assistant'])
  }, TIMEOUT)

  test('Esc goes back without choosing', async () => {
    const { log } = await listedSession()
    const { view, calls } = await preview(log)
    await view.waitFor('3 messages')
    await Bun.sleep(100)
    await view.press(KEYS.escape)
    expect(calls).toEqual({ exits: 1, selected: [] })
  }, TIMEOUT)

  test('a session already read is shown at once and handed back as it is', async () => {
    const { log } = await listedSession({ minutesAgo: 10 })
    const full = await loadFullLog(log)
    const { view, calls } = await preview(full)
    const shown = await view.waitFor('3 messages')
    expect(view.painted()).not.toContain('Loading session…')
    expect(footer(shown)[0]).toBe('10m ago · 3 messages · parser-fix')
    await Bun.sleep(100)
    await view.press(KEYS.enter)
    expect(calls.selected).toEqual([full])
  }, TIMEOUT)

  test('handed another session, it reads and shows that one instead', async () => {
    const first = await listedSession({ minutesAgo: 30 })
    const second = await listedSession({ minutesAgo: 5, branch: 'lexer-work', reply: 'And the lexer?' })
    let show: (log: LogOption) => void = () => undefined
    function Switcher(): React.ReactNode {
      const [log, setLog] = React.useState(first.log)
      show = setLog
      return <SessionPreview log={log} onExit={() => undefined} onSelect={chosen => selected.push(chosen)} />
    }
    const selected: LogOption[] = []
    const view = await mountInApp(<Switcher />)
    await view.waitFor('30m ago · 3 messages')
    show(second.log)
    const shown = await view.waitFor('And the lexer?')
    expect(footer(shown)[0]).toBe('5m ago · 4 messages · lexer-work')
    await Bun.sleep(100)
    await view.press(KEYS.enter)
    expect(selected.map(chosen => [chosen.sessionId, chosen.messages.length])).toEqual([[second.log.sessionId, 4]])
  }, TIMEOUT)

  test('a session whose transcript is gone shows an empty conversation, and Enter still hands it back', async () => {
    const { log, transcript } = await listedSession()
    rmSync(transcript)
    const { view, calls } = await preview(log)
    const shown = await view.waitFor('messages')
    expect(shown).not.toContain(CONVERSATION[0])
    expect(footer(shown)).toEqual(['30m ago · 0 messages · parser-fix', 'Enter to resume · Esc to cancel'])
    await Bun.sleep(100)
    await view.press(KEYS.enter)
    expect(calls.selected.map(chosen => chosen.sessionId)).toEqual([log.sessionId])
  }, TIMEOUT)
})
