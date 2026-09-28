// Characterization of where session storage puts transcripts (unit
// `sessions/storagePure`, the paths half). Names come through the
// session-storage barrel. Each test gets its own config directory, and the
// bootstrap session state it moves is put back afterwards.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  MAX_TRANSCRIPT_READ_BYTES,
  setAgentTranscriptSubdir,
} from 'src/sessions/sessionStorage.js'
import { asAgentId, asSessionId, type SessionId } from 'src/shared/types/ids.js'

const CURRENT = asSessionId('7d3f0c1e-2b4a-4c5d-8e6f-9a0b1c2d3e4f')
const OTHER = asSessionId('0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b')
const AGENT = asAgentId('a1b2c3d4e5f60718a')
const SIBLING_AGENT = asAgentId('a0f1e2d3c4b5a6978')

type Saved = {
  sessionId: SessionId
  projectDir: string | null
  originalCwd: string
  configDir: string | undefined
}

let saved: Saved
let configHome: string

const clearProjectDirMemo = () => getProjectDir.cache.clear!()

beforeEach(() => {
  saved = {
    sessionId: getSessionId(),
    projectDir: getSessionProjectDir(),
    originalCwd: getOriginalCwd(),
    configDir: process.env.CLAUDIN_CONFIG_DIR,
  }
  configHome = mkdtempSync(join(tmpdir(), 'storage-pure-paths-'))
  process.env.CLAUDIN_CONFIG_DIR = configHome
  clearProjectDirMemo()
})

afterEach(() => {
  clearAgentTranscriptSubdir(AGENT)
  clearAgentTranscriptSubdir(SIBLING_AGENT)
  switchSession(saved.sessionId, saved.projectDir)
  setOriginalCwd(saved.originalCwd)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  clearProjectDirMemo()
  rmSync(configHome, { recursive: true, force: true })
})

describe('project directories', () => {
  test('all projects live in <config home>/projects', () => {
    expect(getProjectsDir()).toBe(join(configHome, 'projects'))
  })

  test('the projects directory follows the config home at every call', () => {
    const second = mkdtempSync(join(tmpdir(), 'storage-pure-paths-b-'))
    try {
      process.env.CLAUDIN_CONFIG_DIR = second
      expect(getProjectsDir()).toBe(join(second, 'projects'))
    } finally {
      process.env.CLAUDIN_CONFIG_DIR = configHome
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('a project directory is the cwd with every non-alphanumeric UTF-16 unit turned into a dash', () => {
    const cwds = [
      '/work/acme/api',
      'C:\\Users\\dev\\acme',
      '/home/dev/my project.v2',
      '/home/dev/caf\u00e9',
      '/tmp/\u{1F600}',
      'relative/dir_name',
    ]
    const names = cwds.map(cwd => getProjectDir(cwd).slice(join(configHome, 'projects').length + 1))
    expect(names).toEqual([
      '-work-acme-api',
      'C--Users-dev-acme',
      '-home-dev-my-project-v2',
      '-home-dev-caf-',
      '-tmp---',
      'relative-dir-name',
    ])
    expect(getProjectDir(cwds[0]!)).toBe(join(configHome, 'projects', '-work-acme-api'))
  })

  test('two cwds that differ only in punctuation share a directory', () => {
    expect(getProjectDir('/work/acme-api')).toBe(getProjectDir('/work/acme/api'))
  })

  test('a long cwd keeps a 200-character prefix and gains a hash suffix', () => {
    const deep = `/work/${'nested/'.repeat(40)}app`
    const name = getProjectDir(deep).slice(join(configHome, 'projects').length + 1)
    const prefix = deep.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)
    expect(name.startsWith(`${prefix}-`)).toBe(true)
    expect(name.slice(201)).toMatch(/^[0-9a-z]+$/)
    // The suffix hashes the original cwd, so two long cwds with the same
    // first 200 characters still get different directories.
    expect(getProjectDir(`${deep}-a`)).not.toBe(getProjectDir(`${deep}-b`))
  })

  test('the memo exposes cache.clear, after which a moved config home is honoured', () => {
    const cwd = '/work/acme/api'
    expect(getProjectDir(cwd)).toBe(join(configHome, 'projects', '-work-acme-api'))
    const moved = mkdtempSync(join(tmpdir(), 'storage-pure-paths-c-'))
    try {
      process.env.CLAUDIN_CONFIG_DIR = moved
      clearProjectDirMemo()
      expect(getProjectDir(cwd)).toBe(join(moved, 'projects', '-work-acme-api'))
    } finally {
      process.env.CLAUDIN_CONFIG_DIR = configHome
      rmSync(moved, { recursive: true, force: true })
    }
  })
})

describe('transcript paths', () => {
  test('the current transcript sits in the project directory of the original cwd', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT)
    expect(getTranscriptPath()).toBe(join(configHome, 'projects', '-work-acme-api', `${CURRENT}.jsonl`))
  })

  test('a session switched in with its own project directory is written there', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT, '/elsewhere/-work-acme-web')
    expect(getTranscriptPath()).toBe(join('/elsewhere/-work-acme-web', `${CURRENT}.jsonl`))
  })

  test('the path is worked out at call time', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT)
    const before = getTranscriptPath()
    setOriginalCwd('/work/acme/web')
    switchSession(OTHER)
    expect(getTranscriptPath()).toBe(join(configHome, 'projects', '-work-acme-web', `${OTHER}.jsonl`))
    expect(before).not.toBe(getTranscriptPath())
  })

  test('for the current session, getTranscriptPathForSession honours the session directory', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT, '/elsewhere/-work-acme-web')
    expect(getTranscriptPathForSession(CURRENT)).toBe(join('/elsewhere/-work-acme-web', `${CURRENT}.jsonl`))
  })

  test('any other session id is looked up under the original cwd', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT, '/elsewhere/-work-acme-web')
    expect(getTranscriptPathForSession(OTHER)).toBe(
      join(configHome, 'projects', '-work-acme-api', `${OTHER}.jsonl`),
    )
  })

  test('a subagent transcript sits in subagents/ under the session', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT)
    expect(getAgentTranscriptPath(AGENT)).toBe(
      join(configHome, 'projects', '-work-acme-api', CURRENT, 'subagents', `agent-${AGENT}.jsonl`),
    )
  })

  test('subagent transcripts follow the session project directory too', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT, '/elsewhere/-work-acme-web')
    expect(getAgentTranscriptPath(AGENT)).toBe(
      join('/elsewhere/-work-acme-web', CURRENT, 'subagents', `agent-${AGENT}.jsonl`),
    )
  })

  test('a grouping subdirectory nests one agent until it is cleared', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT)
    const sessionDir = join(configHome, 'projects', '-work-acme-api', CURRENT)
    const plain = getAgentTranscriptPath(AGENT)

    setAgentTranscriptSubdir(AGENT, 'workflows/run-7')
    expect(getAgentTranscriptPath(AGENT)).toBe(
      join(sessionDir, 'subagents', 'workflows', 'run-7', `agent-${AGENT}.jsonl`),
    )
    expect(getAgentTranscriptPath(SIBLING_AGENT)).toBe(
      join(sessionDir, 'subagents', `agent-${SIBLING_AGENT}.jsonl`),
    )

    setAgentTranscriptSubdir(AGENT, 'workflows/run-8')
    expect(getAgentTranscriptPath(AGENT)).toBe(
      join(sessionDir, 'subagents', 'workflows', 'run-8', `agent-${AGENT}.jsonl`),
    )

    clearAgentTranscriptSubdir(AGENT)
    expect(getAgentTranscriptPath(AGENT)).toBe(plain)
  })

  test('an empty grouping subdirectory is the same as none', () => {
    setOriginalCwd('/work/acme/api')
    switchSession(CURRENT)
    const plain = getAgentTranscriptPath(AGENT)
    setAgentTranscriptSubdir(AGENT, '')
    expect(getAgentTranscriptPath(AGENT)).toBe(plain)
  })

  test('raw transcript reads are capped at 50 MiB', () => {
    expect(MAX_TRANSCRIPT_READ_BYTES).toBe(50 * 1024 * 1024)
  })
})
