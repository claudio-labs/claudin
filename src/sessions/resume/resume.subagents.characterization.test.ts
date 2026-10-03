/**
 * Characterization of the subagent transcripts a resume reads back, and of the
 * per-session set of recorded message uuids, pinned before the clean-base
 * rewrite of `sessions/resume`.
 *
 * Subagent transcripts live under `<project dir>/<session id>/subagents/` as
 * `agent-<id>.jsonl`. The suite writes them through the session persistence
 * module where it can, and by hand where it needs a shape the CLI writes only
 * in a long run (several agents in one file, branches). Every path is under a
 * temp CLAUDIN_CONFIG_DIR and a temp project.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { switchSession } from 'src/platform/bootstrap/state.js'
import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import {
  id,
  jsonl,
  type Line,
  prompt,
  reply,
  textOf,
} from 'src/sessions/__testutils__/resumeTranscripts.js'
import { getSessionMessages } from 'src/sessions/resume/cache.js'
import { loadSessionFile } from 'src/sessions/resume/transcriptLoad.js'
import {
  clearAgentTranscriptSubdir,
  clearSessionMessagesCache,
  doesMessageExistInSession,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  flushSessionStorage,
  getAgentTranscript,
  getAgentTranscriptPath,
  getProjectDir,
  loadAllSubagentTranscriptsFromDisk,
  loadSubagentTranscripts,
  recordSidechainTranscript,
  resetProjectForTesting,
  setAgentTranscriptSubdir,
} from 'src/sessions/sessionStorage.js'
import { asAgentId, asSessionId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'

const sandbox = useRestoreSandbox()

const PARENT_SESSION = '5e55104e-0000-4000-8000-0000000000aa' as UUID

beforeEach(() => {
  switchSession(asSessionId(PARENT_SESSION))
  resetProjectForTesting()
})

const projectDir = () => getProjectDir(sandbox.projectDir)
const subagentsDir = () => join(projectDir(), PARENT_SESSION, 'subagents')

function writeAgentFile(agentId: string, lines: Array<Line | string>): string {
  const path = getAgentTranscriptPath(asAgentId(agentId))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, jsonl(lines))
  return path
}

/** A sidechain line of `agentId`. */
const sidechain = (agentId: string) => ({ sidechain: true, more: { agentId } })

// --- one agent's transcript ----------------------------------------------------------

describe('getAgentTranscript', () => {
  test('reads back what the CLI recorded for the agent, without chain fields', async () => {
    const asked = createUserMessage({ content: 'Survey the parser.' })
    const answered = createAssistantMessage({ content: 'Three entry points.' })
    await recordSidechainTranscript([asked, answered], 'surveyor')
    await flushSessionStorage()

    const transcript = await getAgentTranscript(asAgentId('surveyor'))
    expect(transcript!.messages.map(textOf)).toEqual(['Survey the parser.', 'Three entry points.'])
    expect(transcript!.messages.map(m => m.uuid)).toEqual([asked.uuid, answered.uuid])
    for (const message of transcript!.messages) {
      expect(message).not.toHaveProperty('parentUuid')
      expect(message).not.toHaveProperty('isSidechain')
      expect(message).toHaveProperty('agentId', 'surveyor')
    }
  })

  test('follows the latest branch, and keeps only the agent’s own entries of the chain', async () => {
    writeAgentFile('walker', [
      prompt(id(1), 'task', { ...sidechain('walker'), at: 1 }),
      reply(id(2), 'first try', { ...sidechain('walker'), parent: id(1), at: 2 }),
      reply(id(3), 'second try', { ...sidechain('walker'), parent: id(1), at: 5 }),
      prompt(id(4), 'someone else', { ...sidechain('other'), parent: id(3), at: 3 }),
      prompt(id(5), 'main thread line', { parent: id(3), at: 9, more: { agentId: 'walker' } }),
    ])
    const transcript = await getAgentTranscript(asAgentId('walker'))
    expect(transcript!.messages.map(textOf)).toEqual(['task', 'second try'])
  })

  test('a chain that passes through other entries keeps only the agent’s', async () => {
    writeAgentFile('relay', [
      prompt(id(1), 'from the parent', { sidechain: true, at: 1 }),
      prompt(id(2), 'relay task', { ...sidechain('relay'), parent: id(1), at: 2 }),
      reply(id(3), 'relayed', { ...sidechain('relay'), parent: id(2), at: 3 }),
    ])
    const transcript = await getAgentTranscript(asAgentId('relay'))
    expect(transcript!.messages.map(textOf)).toEqual(['relay task', 'relayed'])
  })

  const nothing = [
    { name: 'no transcript file', lines: null },
    { name: 'a file with only other agents', lines: [prompt(id(1), 'x', sidechain('other'))] },
    { name: 'a file whose entries are not sidechain', lines: [prompt(id(1), 'x', { more: { agentId: 'ghost' } })] },
    { name: 'an empty file', lines: [] },
  ]
  for (const c of nothing) {
    test(`${c.name} gives null`, async () => {
      if (c.lines) writeAgentFile('ghost', c.lines)
      expect(await getAgentTranscript(asAgentId('ghost'))).toBeNull()
    })
  }

  test('an agent grouped under a subdirectory is read from there', async () => {
    setAgentTranscriptSubdir('grouped', 'workflow-1')
    try {
      const path = writeAgentFile('grouped', [prompt(id(1), 'grouped task', sidechain('grouped'))])
      expect(path).toBe(join(subagentsDir(), 'workflow-1', 'agent-grouped.jsonl'))
      expect((await getAgentTranscript(asAgentId('grouped')))!.messages.map(textOf)).toEqual(['grouped task'])
    } finally {
      clearAgentTranscriptSubdir('grouped')
    }
  })
})

// --- several agents --------------------------------------------------------------------

describe('loadSubagentTranscripts and loadAllSubagentTranscriptsFromDisk', () => {
  beforeEach(() => {
    writeAgentFile('alpha', [prompt(id(1), 'alpha task', sidechain('alpha'))])
    writeAgentFile('beta', [prompt(id(2), 'beta task', sidechain('beta')), reply(id(3), 'beta done', { ...sidechain('beta'), parent: id(2) })])
    writeAgentFile('silent', [prompt(id(4), 'not the agent', sidechain('someone'))])
  })

  const texts = (byAgent: Record<string, Message[]>) =>
    Object.fromEntries(Object.entries(byAgent).map(([agent, messages]) => [agent, messages.map(textOf)]))

  test('loads the agents asked for, and leaves out those with nothing to show', async () => {
    expect(texts(await loadSubagentTranscripts(['beta', 'missing', 'silent', 'alpha']))).toEqual({
      beta: ['beta task', 'beta done'],
      alpha: ['alpha task'],
    })
    expect(await loadSubagentTranscripts([])).toEqual({})
  })

  test('the disk scan finds every agent file of the session, and ignores other names and grouped agents', async () => {
    mkdirSync(join(subagentsDir(), 'agent-folder.jsonl'))
    writeFileSync(join(subagentsDir(), 'agent-alpha.meta.json'), '{}')
    writeFileSync(join(subagentsDir(), 'notes.jsonl'), jsonl([prompt(id(9), 'stray', sidechain('notes'))]))
    setAgentTranscriptSubdir('nested', 'run-7')
    try {
      writeAgentFile('nested', [prompt(id(8), 'nested task', sidechain('nested'))])
    } finally {
      clearAgentTranscriptSubdir('nested')
    }
    expect(texts(await loadAllSubagentTranscriptsFromDisk())).toEqual({
      alpha: ['alpha task'],
      beta: ['beta task', 'beta done'],
    })
  })

  test('a session without a subagents directory has none', async () => {
    switchSession(asSessionId('5e55104e-0000-4000-8000-0000000000bb'))
    expect(await loadAllSubagentTranscriptsFromDisk()).toEqual({})
  })
})

// --- agent ids from what the conversation holds ---------------------------------------------

describe('extractAgentIdsFromMessages and extractTeammateTranscriptsFromTasks', () => {
  const progress = (data: unknown) => ({ type: 'progress', data, uuid: 'p', timestamp: 't' }) as unknown as Message

  test('agent ids come from agent and skill progress, once each, in first-seen order', () => {
    const messages = [
      progress({ type: 'agent_progress', agentId: 'a1' }),
      progress({ type: 'skill_progress', agentId: 's1' }),
      progress({ type: 'agent_progress', agentId: 'a1' }),
      progress({ type: 'bash_progress', agentId: 'b1' }),
      progress({ type: 'agent_progress', agentId: 42 }),
      progress({ type: 'agent_progress' }),
      progress(null),
      progress('agent_progress'),
      createUserMessage({ content: 'agent_progress a2' }),
      progress({ type: 'skill_progress', agentId: 's2' }),
    ]
    expect(extractAgentIdsFromMessages(messages)).toEqual(['a1', 's1', 's2'])
  })

  test('teammate transcripts come from in-process teammate tasks that hold messages', () => {
    const said = [createUserMessage({ content: 'teammate work' })]
    const tasks = {
      t1: { type: 'in_process_teammate', identity: { agentId: 'mate-1' }, messages: said },
      t2: { type: 'in_process_teammate', identity: { agentId: 'mate-2' }, messages: [] },
      t3: { type: 'in_process_teammate', messages: said },
      t4: { type: 'local_agent', identity: { agentId: 'not-a-mate' }, messages: said },
      t5: { type: 'in_process_teammate', identity: { agentId: 'mate-3' } },
    }
    const found = extractTeammateTranscriptsFromTasks(tasks)
    expect(Object.keys(found)).toEqual(['mate-1'])
    expect(found['mate-1']).toBe(said)
  })
})

// --- the recorded-uuid set ------------------------------------------------------------------

describe('getSessionMessages, doesMessageExistInSession and clearSessionMessagesCache', () => {
  const SESSION_B = '5e55104e-0000-4000-8000-0000000000cc' as UUID
  const OWN_C = '5e55104e-0000-4000-8000-0000000000dd' as UUID

  function writeSessionFile(dir: string, session: UUID, lines: Line[]): string {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${session}.jsonl`)
    writeFileSync(path, jsonl(lines))
    return path
  }

  beforeEach(() => clearSessionMessagesCache())

  test('the set holds the uuids of the session’s transcript, read from the original cwd’s project', async () => {
    writeSessionFile(projectDir(), SESSION_B, [prompt(id(1), 'a'), reply(id(2), 'b', { parent: id(1) })])
    expect([...(await getSessionMessages(SESSION_B))]).toEqual([id(1), id(2)])
    expect(await doesMessageExistInSession(SESSION_B, id(2))).toBe(true)
    expect(await doesMessageExistInSession(SESSION_B, id(3))).toBe(false)
  })

  test('the answer is remembered until the cache is cleared', async () => {
    const path = writeSessionFile(projectDir(), SESSION_B, [prompt(id(1), 'a')])
    expect(await doesMessageExistInSession(SESSION_B, id(2))).toBe(false)
    appendFileSync(path, jsonl([reply(id(2), 'b', { parent: id(1) })]))
    expect(await doesMessageExistInSession(SESSION_B, id(2))).toBe(false)
    clearSessionMessagesCache()
    expect(await doesMessageExistInSession(SESSION_B, id(2))).toBe(true)
  })

  test('each session has its own remembered set', async () => {
    writeSessionFile(projectDir(), SESSION_B, [prompt(id(1), 'b')])
    writeSessionFile(projectDir(), OWN_C, [prompt(id(5), 'c')])
    expect([...(await getSessionMessages(SESSION_B))]).toEqual([id(1)])
    expect([...(await getSessionMessages(OWN_C))]).toEqual([id(5)])
    expect(await doesMessageExistInSession(OWN_C, id(1))).toBe(false)
  })

  test('a session without a transcript has an empty set', async () => {
    expect((await getSessionMessages(SESSION_B)).size).toBe(0)
  })

  test('when the current session lives in another project directory, that directory is read', async () => {
    const elsewhere = join(sandbox.root, 'elsewhere')
    writeSessionFile(elsewhere, SESSION_B, [prompt(id(7), 'from elsewhere')])
    writeSessionFile(projectDir(), SESSION_B, [prompt(id(1), 'from the project')])
    switchSession(asSessionId(PARENT_SESSION), elsewhere)
    try {
      expect([...(await getSessionMessages(SESSION_B))]).toEqual([id(7)])
      expect([...(await loadSessionFile(SESSION_B)).messages.keys()]).toEqual([id(7)])
    } finally {
      switchSession(asSessionId(PARENT_SESSION))
    }
  })

  test('loadSessionFile gives the same metadata maps as reading the file directly', async () => {
    writeSessionFile(projectDir(), SESSION_B, [
      prompt(id(1), 'a', { session: SESSION_B }),
      { type: 'custom-title', sessionId: SESSION_B, customTitle: 'B' } as Line,
      { type: 'agent-setting', sessionId: SESSION_B, agentSetting: 'helper' } as Line,
    ])
    const loaded = await loadSessionFile(SESSION_B)
    expect(loaded.customTitles.get(SESSION_B)).toBe('B')
    expect(loaded.agentSettings.get(SESSION_B)).toBe('helper')
  })
})
