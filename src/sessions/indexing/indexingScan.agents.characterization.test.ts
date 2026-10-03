// Characterization of the local agent sidecars and the session-existence check
// (unit `sessions/indexingScan`, the agents half). Names come through the
// session-storage barrel. Every test runs on its own config home and moves the
// bootstrap session state, which is put back afterwards.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  readAgentMetadata,
  sessionIdExists,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
  type AgentMetadata,
} from 'src/sessions/sessionStorage.js'
import { sanitizePath } from 'src/sessions/sessionStoragePortable.js'
import { asAgentId, asSessionId, type SessionId } from 'src/shared/types/ids.js'

const FIXTURE = join(import.meta.dir, '__fixtures__', 'rewrite', 'agent.meta.json')

const SESSION = asSessionId('3c1d9e0f-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
const EXPLORER = asAgentId('a7e6d5c4b3a291807')
const WORKER = asAgentId('aworkflow-1f2e3d4c5b6a7980')

let saved: { sessionId: SessionId; projectDir: string | null; originalCwd: string; configDir: string | undefined }
let home: string
let cwd: string

const projectFolder = () => join(home, 'projects', sanitizePath(cwd))
const sidecarPath = (agent: string, subdir = '') =>
  join(projectFolder(), SESSION, 'subagents', subdir, `agent-${agent}.meta.json`)

beforeEach(() => {
  saved = {
    sessionId: getSessionId(),
    projectDir: getSessionProjectDir(),
    originalCwd: getOriginalCwd(),
    configDir: process.env.CLAUDIN_CONFIG_DIR,
  }
  home = mkdtempSync(join(tmpdir(), 'indexing-scan-agents-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'indexing-scan-agents-cwd-'))
  process.env.CLAUDIN_CONFIG_DIR = home
  setOriginalCwd(cwd)
  switchSession(SESSION, null)
})

afterEach(() => {
  clearAgentTranscriptSubdir(WORKER)
  switchSession(saved.sessionId, saved.projectDir)
  setOriginalCwd(saved.originalCwd)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const full: AgentMetadata = {
  agentType: 'Explore',
  worktreePath: '/home/dev/shop/.claudin/worktrees/agent-a1b2c3d4',
  description: 'Find the config loader',
  readOnly: true,
}

describe('agent metadata sidecars', () => {
  test('the sidecar is compact JSON in the order given, with no newline, beside the transcript', async () => {
    await writeAgentMetadata(EXPLORER, full)
    expect(readFileSync(sidecarPath(EXPLORER), 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'))
    expect(sidecarPath(EXPLORER)).toBe(getAgentTranscriptPath(EXPLORER).replace(/\.jsonl$/, '.meta.json'))
  })

  test('every field reads back as written', async () => {
    await writeAgentMetadata(EXPLORER, full)
    expect(await readAgentMetadata(EXPLORER)).toEqual(full)
  })

  test('a sidecar on disk is read as stored', async () => {
    mkdirSync(dirname(sidecarPath(EXPLORER)), { recursive: true })
    writeFileSync(sidecarPath(EXPLORER), readFileSync(FIXTURE))
    expect(await readAgentMetadata(EXPLORER)).toEqual(full)
  })

  test('a sidecar from an older build with the agent type only reads back as such', async () => {
    mkdirSync(dirname(sidecarPath(EXPLORER)), { recursive: true })
    writeFileSync(sidecarPath(EXPLORER), '{"agentType":"general-purpose"}')
    expect(await readAgentMetadata(EXPLORER)).toEqual({ agentType: 'general-purpose' })
  })

  test('writing replaces the whole sidecar, so a field left out is gone', async () => {
    await writeAgentMetadata(EXPLORER, full)
    await writeAgentMetadata(EXPLORER, { agentType: 'Explore', description: 'Find the config loader' })
    expect(await readAgentMetadata(EXPLORER)).toEqual({ agentType: 'Explore', description: 'Find the config loader' })
  })

  test('each agent has its own sidecar', async () => {
    await writeAgentMetadata(EXPLORER, { agentType: 'Explore' })
    expect(await readAgentMetadata(WORKER)).toBeNull()
    await writeAgentMetadata(WORKER, { agentType: 'worker' })
    expect(await readAgentMetadata(EXPLORER)).toEqual({ agentType: 'Explore' })
  })

  test('an agent grouped under a subdirectory keeps its sidecar there', async () => {
    setAgentTranscriptSubdir(WORKER, 'workflows/4be0c3a91d7f')
    await writeAgentMetadata(WORKER, { agentType: 'worker' })
    expect(JSON.parse(readFileSync(sidecarPath(WORKER, 'workflows/4be0c3a91d7f'), 'utf8'))).toEqual({ agentType: 'worker' })
    expect(await readAgentMetadata(WORKER)).toEqual({ agentType: 'worker' })
  })

  test('a session switched into another project directory keeps its sidecars there', async () => {
    const elsewhere = join(home, 'projects', 'resumed-from-elsewhere')
    switchSession(SESSION, elsewhere)
    await writeAgentMetadata(EXPLORER, { agentType: 'Explore' })
    const path = join(elsewhere, SESSION, 'subagents', `agent-${EXPLORER}.meta.json`)
    expect(readFileSync(path, 'utf8')).toBe('{"agentType":"Explore"}')
  })

  test.each([
    { name: 'never written', prepare: () => {} },
    {
      name: 'a file where the session folder should be',
      prepare: () => {
        mkdirSync(projectFolder(), { recursive: true })
        writeFileSync(join(projectFolder(), SESSION), 'not a folder')
      },
    },
  ])('a sidecar that cannot be reached reads as null: $name', async ({ prepare }) => {
    prepare()
    expect(await readAgentMetadata(EXPLORER)).toBeNull()
  })
})

describe('sessionIdExists', () => {
  const OTHER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'

  test.each([
    { name: 'a transcript in the project folder of the original cwd', where: 'here', id: SESSION, exists: true },
    { name: 'an empty transcript still counts', where: 'here-empty', id: SESSION, exists: true },
    { name: 'no transcript at all', where: 'nowhere', id: SESSION, exists: false },
    { name: 'a transcript of another session', where: 'here', id: OTHER, exists: false },
    { name: 'a transcript in another project folder', where: 'other-project', id: SESSION, exists: false },
  ])('$name: $exists', ({ where, id, exists }) => {
    if (where === 'here' || where === 'here-empty') {
      mkdirSync(projectFolder(), { recursive: true })
      writeFileSync(join(projectFolder(), `${SESSION}.jsonl`), where === 'here' ? '{"type":"tag"}\n' : '')
    } else if (where === 'other-project') {
      const other = join(home, 'projects', '-somewhere-else')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, `${SESSION}.jsonl`), '{}\n')
    }
    expect(sessionIdExists(id)).toBe(exists)
  })

  test('only the original cwd counts, not the folder a resumed session was switched into', () => {
    const elsewhere = join(home, 'projects', 'resumed-from-elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, `${SESSION}.jsonl`), '{}\n')
    switchSession(SESSION, elsewhere)
    expect(sessionIdExists(SESSION)).toBe(false)
  })

  test('the projects folder follows the config home at every call', () => {
    mkdirSync(projectFolder(), { recursive: true })
    writeFileSync(join(projectFolder(), `${SESSION}.jsonl`), '{}\n')
    expect(sessionIdExists(SESSION)).toBe(true)
    const second = mkdtempSync(join(tmpdir(), 'indexing-scan-agents-home2-'))
    try {
      process.env.CLAUDIN_CONFIG_DIR = second
      expect(sessionIdExists(SESSION)).toBe(false)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })
})
