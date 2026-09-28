/**
 * Characterization of resuming and forking a session
 * (`processResumedConversation` in sessionRestore.ts), pinned before the
 * clean-base rewrite of `sessions/lifecycle`.
 *
 * A resumed session is rebuilt from its transcript: the session id and the
 * transcript file are taken over, the cost is restored, the metadata is cached
 * and re-stamped at the end of the file, the agent and its model come back,
 * and the session returns to the worktree it was in. A fork takes the
 * conversation but none of the original session's ownership. The tests write
 * real transcripts with the session storage API into a temp
 * CLAUDIN_CONFIG_DIR, load them with the loader `--continue` uses, and hand
 * the result over as the CLI does.
 *
 * The rest of sessionRestore.ts (the agent, the todo list and file history,
 * the worktree helpers) is in sessionLifecycle.restoreState.characterization.
 *
 * Not reachable here: `feature('COORDINATOR_MODE')` is false under `bun test`,
 * so the coordinator branches (mode matching, the mode stamp, the agent
 * reload after a mode switch) never run. The spec describes them.
 */
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { getTotalCost } from 'src/agent/cost-tracker.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import {
  getMainLoopModelOverride,
  getMainThreadAgentType,
  getSessionId,
  getSessionProjectDir,
} from 'src/platform/bootstrap/state.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import { eventually } from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  agent,
  definitions,
  enterProject,
  loadLatest,
  repositoryWithWorktree,
  resumeContext,
  transcriptEntries,
  useRestoreSandbox,
  writeSession,
} from 'src/sessions/__testutils__/restoreHarness.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import { processResumedConversation } from 'src/sessions/sessionRestore.js'
import {
  cacheSessionTitle,
  flushSessionStorage,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  getProject,
  recordTranscript,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { getCurrentWorktreeSession } from 'src/vcs/git/worktree.js'

const sandbox = useRestoreSandbox()

const context = (overrides?: Parameters<typeof resumeContext>[1]) =>
  resumeContext(sandbox.projectDir, overrides)

/** The text of the last entry of a transcript, which must be a message. */
function lastMessageText(transcript: string): string {
  const last = transcriptEntries(transcript).at(-1)!
  return (last.message as { content: string }).content
}

describe('processResumedConversation — continuing a session', () => {
  test('takes the session over: its id, its project dir, and its transcript file', async () => {
    const { id, transcript } = await writeSession({ title: 'Parser fixes' })
    const loaded = await loadLatest()

    await processResumedConversation(
      loaded,
      { forkSession: false, transcriptPath: loaded.fullPath },
      context(),
    )

    expect(getSessionId()).toBe(asSessionId(id))
    expect(getSessionProjectDir()).toBe(dirname(transcript))
    await recordTranscript([createUserMessage({ content: 'Picking up where we left off.' })])
    await flushSessionStorage()
    expect(transcriptEntries(transcript).at(-1)?.type).toBe('user')
    expect(lastMessageText(transcript)).toBe('Picking up where we left off.')
  })

  test("re-stamps the session's metadata at the end of its transcript", async () => {
    const { transcript } = await writeSession({
      title: 'Parser fixes',
      tag: 'bugfix',
      agentName: 'Scout',
      agentColor: 'blue',
      agentSetting: 'reviewer',
      pr: { number: 7, url: 'https://example.test/pull/7', repository: 'org/repo' },
    })
    const lengthBefore = transcriptEntries(transcript).length
    const loaded = await loadLatest()

    await processResumedConversation(
      loaded,
      { forkSession: false, transcriptPath: loaded.fullPath },
      context(),
    )

    const appended = transcriptEntries(transcript).slice(lengthBefore)
    expect(appended.map(entry => entry.type).sort()).toEqual([
      'agent-color',
      'agent-name',
      'agent-setting',
      'custom-title',
      'pr-link',
      'tag',
    ])
    const byType = new Map(appended.map(entry => [entry.type, entry]))
    expect(byType.get('custom-title')?.customTitle).toBe('Parser fixes')
    expect(byType.get('agent-setting')?.agentSetting).toBe('reviewer')
    expect(byType.get('pr-link')?.prNumber).toBe(7)
  })

  test('a title given on the command line outlives the one in the transcript', async () => {
    const { id, transcript } = await writeSession({ title: 'Parser fixes' })
    cacheSessionTitle('Named at launch')
    const loaded = await loadLatest()

    await processResumedConversation(
      loaded,
      { forkSession: false, transcriptPath: loaded.fullPath },
      context(),
    )

    expect(getCurrentSessionTitle(asSessionId(id))).toBe('Named at launch')
    const titles = transcriptEntries(transcript).filter(entry => entry.type === 'custom-title')
    expect(titles.at(-1)?.customTitle).toBe('Named at launch')
  })

  test('restores the title and tag the session had', async () => {
    const { id } = await writeSession({ title: 'Parser fixes', tag: 'bugfix' })
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    expect(getCurrentSessionTitle(asSessionId(id))).toBe('Parser fixes')
    expect(getCurrentSessionTag(id)).toBe('bugfix')
  })

  test('restores the running cost from the transcript', async () => {
    await writeSession({ costUSD: 1.75 })
    expect(getTotalCost()).toBe(0)
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    expect(getTotalCost()).toBe(1.75)
  })

  test('hands back the loaded conversation and the state to start the UI with', async () => {
    await writeSession({
      agentName: 'Scout',
      agentColor: 'blue',
      trackedFiles: [join(sandbox.projectDir, 'a.ts')],
    })
    const loaded = await loadLatest()
    const initialState = getDefaultAppState()
    const resumeWith = context({ initialState })

    const resumed = await processResumedConversation(
      loaded,
      { forkSession: false, includeAttribution: true },
      resumeWith,
    )

    expect(resumed.messages).toBe(loaded.messages)
    expect(resumed.fileHistorySnapshots).toBe(loaded.fileHistorySnapshots)
    expect([resumed.agentName, resumed.agentColor]).toEqual(['Scout', 'blue'])
    expect(resumed.restoredAgentDef).toBeUndefined()
    const { standaloneAgentContext, agentDefinitions, ...unchanged } = resumed.initialState
    expect(standaloneAgentContext).toEqual({ name: 'Scout', color: 'blue' })
    expect(agentDefinitions).toBe(resumeWith.agentDefinitions)
    const { standaloneAgentContext: _was, agentDefinitions: _were, ...given } = initialState
    expect(unchanged).toEqual(given)
    expect(resumed.initialState.attribution).toBe(initialState.attribution)
    expect(resumed.initialState.agent).toBeUndefined()
  })

  test("an agent color of 'default' is reported as no color", async () => {
    await writeSession({ agentName: 'Scout', agentColor: 'default' })
    const loaded = await loadLatest()

    const resumed = await processResumedConversation(loaded, { forkSession: false }, context())

    expect(resumed.agentColor).toBeUndefined()
    expect(resumed.initialState.standaloneAgentContext).toEqual({ name: 'Scout', color: undefined })
  })

  test('a session with neither agent name nor color gets no standalone agent context', async () => {
    await writeSession()
    const loaded = await loadLatest()
    const initialState = getDefaultAppState()

    const resumed = await processResumedConversation(
      loaded,
      { forkSession: false },
      context({ initialState }),
    )

    expect(resumed.initialState.standaloneAgentContext).toBe(initialState.standaloneAgentContext)
    expect(resumed.agentName).toBeUndefined()
  })

  test("brings back the session's agent, and the agent's model", async () => {
    await writeSession({ agentSetting: 'reviewer' })
    const reviewer = agent('reviewer', { model: 'codexplan' })
    const loaded = await loadLatest()

    const resumed = await processResumedConversation(
      loaded,
      { forkSession: false },
      context({ agentDefinitions: definitions([reviewer]) }),
    )

    expect(resumed.restoredAgentDef).toBe(reviewer)
    expect(resumed.initialState.agent).toBe('reviewer')
    expect(getMainThreadAgentType()).toBe('reviewer')
    expect(getMainLoopModelOverride()).toBe(parseUserSpecifiedModel('codexplan'))
    expect(getMainLoopModelOverride()).not.toBe('codexplan')
  })

  test("names this session's process record after the resumed agent", async () => {
    await writeSession({ agentName: 'Scout' })
    const record = join(sandbox.configDir, 'sessions', `${process.pid}.json`)
    mkdirSync(dirname(record), { recursive: true })
    const existing = { pid: process.pid, sessionId: 'x', cwd: sandbox.projectDir, startedAt: 1 }
    writeFileSync(record, JSON.stringify(existing))
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    const name = await eventually(
      () => (JSON.parse(readFileSync(record, 'utf8')) as { name?: string }).name,
      value => value === 'Scout',
    )
    expect(name).toBe('Scout')
  })

  test('sessionIdOverride decides which session is taken over', async () => {
    await writeSession()
    const loaded = await loadLatest()
    const chosen = randomUUID()

    await processResumedConversation(
      loaded,
      { forkSession: false, sessionIdOverride: chosen },
      context(),
    )

    expect(getSessionId()).toBe(asSessionId(chosen))
  })

  test('a transcript from another project stays where it is: the session keeps writing there', async () => {
    const otherProject = join(sandbox.root, 'other-project')
    mkdirSync(otherProject)
    enterProject(otherProject)
    const { id, transcript } = await writeSession({ title: 'Elsewhere' })
    enterProject(sandbox.projectDir)
    // What `--resume <file>.jsonl` loads.
    const loaded = await loadConversationForResume(transcript, transcript)

    await processResumedConversation(
      loaded!,
      { forkSession: false, transcriptPath: transcript },
      context(),
    )

    expect(getSessionId()).toBe(asSessionId(id))
    expect(getSessionProjectDir()).toBe(dirname(transcript))
    await recordTranscript([createUserMessage({ content: 'Still over here.' })])
    await flushSessionStorage()
    expect(lastMessageText(transcript)).toBe('Still over here.')
  })

  test('without a transcript path the session is looked for in the current project', async () => {
    const { transcript } = await writeSession()
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    expect(getSessionProjectDir()).toBeNull()
    expect(getProject().sessionFile).toBe(transcript)
  })

  test('returns to the worktree the session was in', async () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    await writeSession({ worktree: session })
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    expect(process.cwd()).toBe(worktree)
    expect(getCurrentWorktreeSession()).toEqual(session)
  })

  test('a worktree that was removed is recorded as exited, and the session stays put', async () => {
    const { repo, worktree, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    const { transcript } = await writeSession({ worktree: session })
    rmSync(worktree, { recursive: true, force: true })
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: false }, context())

    expect(process.cwd()).toBe(repo)
    expect(getCurrentWorktreeSession()).toBeNull()
    const states = transcriptEntries(transcript).filter(entry => entry.type === 'worktree-state')
    expect(states.at(-1)?.worktreeSession).toBeNull()
  })
})

describe('processResumedConversation — forking a session', () => {
  test('keeps the new session id, restores no cost and leaves the original transcript alone', async () => {
    const { id, transcript } = await writeSession({ title: 'Parser fixes', costUSD: 2 })
    const forkId = getSessionId()
    const before = readFileSync(transcript, 'utf8')
    const loaded = await loadLatest()

    await processResumedConversation(
      loaded,
      { forkSession: true, transcriptPath: loaded.fullPath },
      context(),
    )
    await flushSessionStorage()

    expect(getSessionId()).toBe(forkId)
    expect(getSessionId()).not.toBe(id)
    expect(getTotalCost()).toBe(0)
    expect(readFileSync(transcript, 'utf8')).toBe(before)
    expect(getProject().sessionFile).toBeNull()
  })

  test('a session id override is ignored when forking', async () => {
    await writeSession()
    const forkId = getSessionId()
    const loaded = await loadLatest()

    await processResumedConversation(
      loaded,
      { forkSession: true, sessionIdOverride: randomUUID() },
      context(),
    )

    expect(getSessionId()).toBe(forkId)
  })

  test('still carries the title and the agent over to the fork', async () => {
    await writeSession({ title: 'Parser fixes', agentName: 'Scout', agentSetting: 'reviewer' })
    const reviewer = agent('reviewer')
    const loaded = await loadLatest()

    const resumed = await processResumedConversation(
      loaded,
      { forkSession: true },
      context({ agentDefinitions: definitions([reviewer]) }),
    )

    expect(getCurrentSessionTitle(getSessionId())).toBe('Parser fixes')
    expect(resumed.restoredAgentDef).toBe(reviewer)
    expect(resumed.initialState.standaloneAgentContext).toEqual({ name: 'Scout', color: undefined })
  })

  test("does not take over the original session's worktree", async () => {
    const { repo, session } = repositoryWithWorktree(sandbox.root)
    enterProject(repo)
    await writeSession({ worktree: session })
    const loaded = await loadLatest()

    await processResumedConversation(loaded, { forkSession: true }, context())

    expect(process.cwd()).toBe(repo)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(getProject().currentSessionWorktree).toBeUndefined()
  })
})
