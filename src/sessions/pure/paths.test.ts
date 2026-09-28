// Transcript paths: the two fixes the characterization suite leaves open. The
// memoized project directory follows a moved config home without a manual
// clear, and a grouping subdirectory can only nest below `subagents/`.

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
  getTranscriptPath,
  setAgentTranscriptSubdir,
} from 'src/sessions/pure/paths.js'
import { asAgentId, asSessionId, type SessionId } from 'src/shared/types/ids.js'

const SESSION = asSessionId('3c9a1f40-5b2d-4e6f-8a7b-0c1d2e3f4a5b')
const AGENT = asAgentId('a7f3e2d1c0b9a8f7e')

let saved: { sessionId: SessionId; projectDir: string | null; originalCwd: string; configDir: string | undefined }
let homeA: string
let homeB: string

beforeEach(() => {
  saved = {
    sessionId: getSessionId(),
    projectDir: getSessionProjectDir(),
    originalCwd: getOriginalCwd(),
    configDir: process.env.CLAUDIN_CONFIG_DIR,
  }
  homeA = mkdtempSync(join(tmpdir(), 'paths-home-a-'))
  homeB = mkdtempSync(join(tmpdir(), 'paths-home-b-'))
  process.env.CLAUDIN_CONFIG_DIR = homeA
  setOriginalCwd('/srv/shop')
  switchSession(SESSION)
})

afterEach(() => {
  clearAgentTranscriptSubdir(AGENT)
  switchSession(saved.sessionId, saved.projectDir)
  setOriginalCwd(saved.originalCwd)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  getProjectDir.cache.clear()
  rmSync(homeA, { recursive: true, force: true })
  rmSync(homeB, { recursive: true, force: true })
})

describe('the memoized project directory', () => {
  test('follows the config home without a manual clear', () => {
    expect(getProjectDir('/srv/shop')).toBe(join(homeA, 'projects', '-srv-shop'))
    process.env.CLAUDIN_CONFIG_DIR = homeB
    expect(getProjectDir('/srv/shop')).toBe(join(homeB, 'projects', '-srv-shop'))
    process.env.CLAUDIN_CONFIG_DIR = homeA
    expect(getProjectDir('/srv/shop')).toBe(join(homeA, 'projects', '-srv-shop'))
  })

  test('so the current transcript moves with the config home too', () => {
    expect(getTranscriptPath()).toBe(join(homeA, 'projects', '-srv-shop', `${SESSION}.jsonl`))
    process.env.CLAUDIN_CONFIG_DIR = homeB
    expect(getTranscriptPath()).toBe(join(homeB, 'projects', '-srv-shop', `${SESSION}.jsonl`))
  })
})

describe('grouping subdirectories', () => {
  const subagents = () => join(homeA, 'projects', '-srv-shop', SESSION, 'subagents')
  const plainPath = () => join(subagents(), `agent-${AGENT}.jsonl`)

  // Each of these would put the transcript outside subagents/.
  const escaping = {
    'an absolute path': '/etc/cron.d',
    'a parent segment': '../../elsewhere',
    'a parent segment after a real one': 'workflows/../../../elsewhere',
    'a lone parent segment': '..',
    'a parent segment written with a backslash': '..\\elsewhere',
  }
  for (const [label, subdir] of Object.entries(escaping)) {
    test(`${label} is ignored, and the transcript stays in subagents/`, () => {
      setAgentTranscriptSubdir(AGENT, subdir)
      expect(getAgentTranscriptPath(AGENT)).toBe(plainPath())
    })
  }

  test('a relative subdirectory still nests, dots inside a name included', () => {
    setAgentTranscriptSubdir(AGENT, 'workflows/run..7')
    expect(getAgentTranscriptPath(AGENT)).toBe(join(subagents(), 'workflows', 'run..7', `agent-${AGENT}.jsonl`))
  })

  test('an ignored subdirectory replaces the one set before it', () => {
    setAgentTranscriptSubdir(AGENT, 'workflows/run-1')
    setAgentTranscriptSubdir(AGENT, '/tmp/elsewhere')
    expect(getAgentTranscriptPath(AGENT)).toBe(plainPath())
  })
})
