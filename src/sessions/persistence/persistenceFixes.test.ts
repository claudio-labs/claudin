/**
 * The behaviour the rewrite of `sessions/persistence` changed on purpose: the
 * spec's "fix" findings. The characterization suites pass on the old and the
 * new code alike, so each fix is pinned here.
 */
import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  getSessionId,
  setFlagSettingsInline,
  setSessionPersistenceDisabled,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { usePersistenceSandbox } from 'src/sessions/__testutils__/persistenceSandbox.js'
import {
  adoptResumedSessionFile,
  flushSessionStorage,
  getAgentTranscriptPath,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  hydrateFromCCRv2InternalEvents,
  reAppendSessionMetadata,
  recordTranscript,
  removeTranscriptMessage,
  restoreSessionMetadata,
  saveAgentColor,
  saveCustomTitle,
  saveTag,
  saveWorktreeState,
  setInternalEventReader,
} from 'src/sessions/sessionStorage.js'
import { asAgentId, asSessionId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = usePersistenceSandbox()

const AT = '2026-03-14T09:26:53.000Z'
const current = (): UUID => getSessionId() as UUID

function uuidOf(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function prompt(n: number, text: string, extra: Record<string, unknown> = {}): Message {
  return createUserMessage({ content: text, uuid: uuidOf(n), timestamp: AT, ...extra })
}

async function openTranscript(): Promise<void> {
  await recordTranscript([prompt(1, 'start')])
  await flushSessionStorage()
}

const USER_SWITCHES: Array<{ name: string; on: () => void }> = [
  { name: '--no-session-persistence', on: () => setSessionPersistenceDisabled(true) },
  { name: 'cleanupPeriodDays: 0', on: () => (setFlagSettingsInline({ cleanupPeriodDays: 0 }), resetSettingsCache()) },
  { name: 'CLAUDIN_SKIP_PROMPT_HISTORY', on: () => (process.env.CLAUDIN_SKIP_PROMPT_HISTORY = '1') },
]

describe('finding 1: a metadata save creates its transcript owner-only', () => {
  test('even when it also creates the project directory', async () => {
    expect(existsSync(dirname(sandbox.transcript()))).toBe(false)
    await saveTag(current(), 'first')
    expect(statSync(sandbox.transcript()).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(sandbox.transcript())).mode & 0o777).toBe(0o700)
  })
})

describe('finding 2: metadata honours the persistence switches', () => {
  for (const { name, on } of USER_SWITCHES) {
    test(`${name}: saves for the current session are cached, not written`, async () => {
      on()
      await saveCustomTitle(current(), 'Cached only')
      await saveTag(current(), 'kept')
      await saveAgentColor(current(), 'teal')
      expect(existsSync(dirname(sandbox.transcript()))).toBe(false)
      expect([getCurrentSessionTitle(asSessionId(current())), getCurrentSessionTag(current())]).toEqual(['Cached only', 'kept'])
      setSessionPersistenceDisabled(false)
    })

    test(`${name}: an open transcript gets no worktree line and no re-append`, async () => {
      await openTranscript()
      const before = sandbox.text()
      on()
      restoreSessionMetadata({ customTitle: 'T', tag: 'g' })
      saveWorktreeState({ originalCwd: '/a', worktreePath: '/a/w', worktreeName: 'w', sessionId: 's' })
      reAppendSessionMetadata()
      adoptResumedSessionFile()
      await flushSessionStorage()
      expect(sandbox.text()).toBe(before)
      setSessionPersistenceDisabled(false)
    })

    test(`${name}: another session's existing file is still written, a missing one is not created`, async () => {
      const existing = '0ddba11c-0000-4000-8000-0000000000aa' as UUID
      const missing = '0ddba11c-0000-4000-8000-0000000000bb' as UUID
      const projectDir = dirname(sandbox.transcript())
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${existing}.jsonl`), '')
      on()
      await saveTag(existing, 'theirs')
      await saveTag(missing, 'nobody')
      expect(sandbox.entries(join(projectDir, `${existing}.jsonl`)).map(e => e.tag)).toEqual(['theirs'])
      expect(existsSync(join(projectDir, `${missing}.jsonl`))).toBe(false)
      setSessionPersistenceDisabled(false)
    })
  }
})

describe('finding 3: removal cuts only the line whose own uuid matches', () => {
  test('a later line quoting the uuid in a nested member stays', async () => {
    const quoting = prompt(2, 'quotes the first', { toolUseResult: { quoted: { uuid: uuidOf(1) } } })
    await recordTranscript([prompt(1, 'target'), quoting, prompt(3, 'after')])
    await flushSessionStorage()
    await removeTranscriptMessage(uuidOf(1))
    expect(sandbox.entries().map(e => e.uuid)).toEqual([uuidOf(2), uuidOf(3)])
  })
})

describe('finding 6: a failed batch written by the timer', () => {
  test('is logged, not left as an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      writeFileSync(join(sandbox.root, 'a-file'), '')
      process.env.CLAUDIN_CONFIG_DIR = join(sandbox.root, 'a-file')
      await recordTranscript([prompt(1, 'lost')])
      await Bun.sleep(250)
      expect(unhandled).toEqual([])
      // The batch was consumed by the timer: nothing is left to fail.
      expect(await flushSessionStorage().then(() => 'resolved')).toBe('resolved')
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})

describe('finding 8: the last prompt drops carriage returns', () => {
  test('CRLF and lone CR become spaces', async () => {
    await openTranscript()
    await recordTranscript([prompt(2, 'first\r\nsecond\rthird\r\n'), createAssistantMessage({ content: 'ok' })])
    await flushSessionStorage()
    const before = sandbox.entries().length
    reAppendSessionMetadata()
    expect(sandbox.entries().slice(before)).toEqual([{ type: 'last-prompt', lastPrompt: 'first second third', sessionId: current() }])
  })
})

describe('finding 9: CCR v2 agent ids are checked before they name a file', () => {
  test('ids that are not one safe path segment are dropped', async () => {
    const line = (n: number) => ({ type: 'assistant', uuid: uuidOf(n), isSidechain: true })
    const unsafe = ['../escape', 'a/b', 'a\\b', '..', '.hidden', '/abs']
    setInternalEventReader(
      async () => [{ payload: line(1) }],
      async () => [...unsafe.map((agent_id, i) => ({ payload: line(10 + i), agent_id })), { payload: line(2), agent_id: 'a1b2c3' }],
    )
    expect(await hydrateFromCCRv2InternalEvents(crypto.randomUUID())).toBe(true)
    const kept = getAgentTranscriptPath(asAgentId('a1b2c3'))
    expect(readdirSync(dirname(kept))).toEqual(['agent-a1b2c3.jsonl'])
    expect(readdirSync(dirname(dirname(kept)))).toEqual(['subagents'])
    expect(sandbox.entries(kept).map(e => e.uuid)).toEqual([uuidOf(2)])
  })
})
