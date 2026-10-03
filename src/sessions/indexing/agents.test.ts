// Unit tests for the sidecar fix decision of the spec: the write replaces the
// file atomically, and a sidecar that cannot be used reads as null.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { readAgentMetadata, writeAgentMetadata } from 'src/sessions/indexing/agents.js'
import { getAgentTranscriptPath } from 'src/sessions/pure/paths.js'
import { asAgentId, asSessionId, type SessionId } from 'src/shared/types/ids.js'

const SESSION = asSessionId('7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d')
const AGENT = asAgentId('a0123456789abcdef')

let saved: { sessionId: SessionId; projectDir: string | null; originalCwd: string; configDir: string | undefined }
let home: string

const sidecar = () => getAgentTranscriptPath(AGENT).replace(/\.jsonl$/, '.meta.json')

beforeEach(() => {
  saved = {
    sessionId: getSessionId(),
    projectDir: getSessionProjectDir(),
    originalCwd: getOriginalCwd(),
    configDir: process.env.CLAUDIN_CONFIG_DIR,
  }
  home = mkdtempSync(join(tmpdir(), 'agents-unit-'))
  process.env.CLAUDIN_CONFIG_DIR = home
  setOriginalCwd(join(home, 'cwd'))
  switchSession(SESSION, null)
})

afterEach(() => {
  switchSession(saved.sessionId, saved.projectDir)
  setOriginalCwd(saved.originalCwd)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  rmSync(home, { recursive: true, force: true })
})

describe('writeAgentMetadata replaces the sidecar atomically', () => {
  test('a rewrite leaves only the sidecar in the folder, with the new contents', async () => {
    await writeAgentMetadata(AGENT, { agentType: 'Explore', description: 'first' })
    await writeAgentMetadata(AGENT, { agentType: 'Explore' })
    expect(readdirSync(dirname(sidecar()))).toEqual([`agent-${AGENT}.meta.json`])
    expect(readFileSync(sidecar(), 'utf8')).toBe('{"agentType":"Explore"}')
  })

  test('the new sidecar lands as a new file, so the old one is never rewritten in place', async () => {
    await writeAgentMetadata(AGENT, { agentType: 'Explore', description: 'first' })
    const reader = join(home, 'held-by-a-reader.json')
    linkSync(sidecar(), reader)
    await writeAgentMetadata(AGENT, { agentType: 'Plan' })
    expect(readFileSync(reader, 'utf8')).toBe('{"agentType":"Explore","description":"first"}')
    expect(readFileSync(sidecar(), 'utf8')).toBe('{"agentType":"Plan"}')
  })

  test('a write that cannot land rejects and leaves no staging file behind', async () => {
    // A non-empty directory where the sidecar goes makes the final rename fail.
    mkdirSync(join(sidecar(), 'occupied'), { recursive: true })
    await expect(writeAgentMetadata(AGENT, { agentType: 'Explore' })).rejects.toBeDefined()
    expect(readdirSync(dirname(sidecar()))).toEqual([`agent-${AGENT}.meta.json`])
  })
})

describe('readAgentMetadata fails soft on a sidecar it cannot use', () => {
  test.each([
    { name: 'empty', contents: '' },
    { name: 'cut short', contents: '{"agentType":"Exp' },
    { name: 'JSON null', contents: 'null' },
    { name: 'an array', contents: '[{"agentType":"Explore"}]' },
    { name: 'a string', contents: '"Explore"' },
    { name: 'no agentType', contents: '{"description":"orphan"}' },
    { name: 'a non-string agentType', contents: '{"agentType":7}' },
  ])('$name reads as null', async ({ contents }) => {
    mkdirSync(dirname(sidecar()), { recursive: true })
    writeFileSync(sidecar(), contents)
    expect(await readAgentMetadata(AGENT)).toBeNull()
  })

  test('a directory where the sidecar should be reads as null', async () => {
    mkdirSync(sidecar(), { recursive: true })
    expect(await readAgentMetadata(AGENT)).toBeNull()
  })

  test('extra members of a valid sidecar are kept as stored', async () => {
    mkdirSync(dirname(sidecar()), { recursive: true })
    writeFileSync(sidecar(), '{"agentType":"Explore","future":1}')
    expect(JSON.stringify(await readAgentMetadata(AGENT))).toBe('{"agentType":"Explore","future":1}')
  })
})
