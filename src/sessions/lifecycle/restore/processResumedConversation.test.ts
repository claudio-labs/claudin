/**
 * What the characterization suite does not reach: a resume that names no
 * session to take over (the current session carries on, and must not be left
 * with a transcript that holds nothing but metadata), and the transcript the
 * process had open before taking a session over.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { createUserMessage } from 'src/agent/messages/messages.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  enterProject,
  loadLatest,
  repositoryWithWorktree,
  resumeContext,
  transcriptEntries,
  useRestoreSandbox,
  writeSession,
} from 'src/sessions/__testutils__/restoreHarness.js'
import { processResumedConversation } from 'src/sessions/lifecycle/restore/processResumedConversation.js'
import {
  flushSessionStorage,
  getCurrentSessionTitle,
  getProject,
  getTranscriptPath,
  recordTranscript,
  setSessionFileForTesting,
} from 'src/sessions/sessionStorage.js'
import type { SessionId } from 'src/shared/types/ids.js'

const sandbox = useRestoreSandbox()

async function resumeWithoutSessionId(): Promise<SessionId> {
  await writeSession({ title: 'Parser fixes', tag: 'bugfix' })
  const loaded = await loadLatest()
  const current = getSessionId()

  await processResumedConversation(
    { ...loaded, sessionId: undefined },
    { forkSession: false },
    resumeContext(sandbox.projectDir),
  )
  await flushSessionStorage()
  return current
}

describe('processResumedConversation — no session to take over', () => {
  test('the current session carries on, with the metadata cached but no transcript written', async () => {
    const current = await resumeWithoutSessionId()

    expect(getSessionId()).toBe(current)
    expect(getCurrentSessionTitle(getSessionId())).toBe('Parser fixes')
    expect(getProject().sessionFile).toBeNull()
    expect(existsSync(getTranscriptPath())).toBe(false)
  })

  test('the metadata reaches the transcript with the first message', async () => {
    await resumeWithoutSessionId()

    await recordTranscript([createUserMessage({ content: 'Carry on.' })])
    await flushSessionStorage()

    const entries = transcriptEntries(getTranscriptPath())
    expect(entries.find(entry => entry.type === 'custom-title')?.customTitle).toBe('Parser fixes')
    expect(entries.find(entry => entry.type === 'tag')?.tag).toBe('bugfix')
  })
})

describe('processResumedConversation — taking a session over', () => {
  test('nothing for the resumed session lands in the transcript the process had open', async () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    await writeSession({ worktree: session })
    rmSync(worktree, { recursive: true, force: true })
    const loaded = await loadLatest()
    const leftBehind = join(sandbox.root, 'left-behind.jsonl')
    writeFileSync(leftBehind, '')
    setSessionFileForTesting(leftBehind)

    await processResumedConversation(loaded, { forkSession: false }, resumeContext(repo))
    await flushSessionStorage()

    expect(readFileSync(leftBehind, 'utf8')).toBe('')
  })
})
