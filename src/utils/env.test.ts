import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalEnv = {
  CLAUDIO_CONFIG_DIR: process.env.CLAUDIO_CONFIG_DIR,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
  USER_TYPE: process.env.USER_TYPE,
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claudio-env-test-'))
  process.env.CLAUDIO_CONFIG_DIR = tempDir
  delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  delete process.env.USER_TYPE
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalEnv.CLAUDIO_CONFIG_DIR === undefined) {
    delete process.env.CLAUDIO_CONFIG_DIR
  } else {
    process.env.CLAUDIO_CONFIG_DIR = originalEnv.CLAUDIO_CONFIG_DIR
  }
  if (originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
  }
  if (originalEnv.USER_TYPE === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalEnv.USER_TYPE
  }
})

async function importFreshEnvModule() {
  return import(`./env.js?ts=${Date.now()}-${Math.random()}`)
}

// getGlobalClaudeFile prefers <configDir>/config.json. Until startup
// migration runs, falls back to the pre-rebrand sibling .claudio.json
// so getGlobalConfig() reads the user's existing data instead of defaults.
// Legacy ~/.claude.json is never read or written at runtime.

test('getGlobalClaudeFile: new install returns config.json inside config dir', async () => {
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, 'config.json'))
})

test('getGlobalClaudeFile: returns config.json even when legacy .claude.json sits next to it', async () => {
  writeFileSync(join(tempDir, '.claude.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, 'config.json'))
})

test('getGlobalClaudeFile: falls back to .claudio.json when only the pre-rebrand sibling exists', async () => {
  writeFileSync(join(tempDir, '.claudio.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.claudio.json'))
})

test('getGlobalClaudeFile: prefers in-dir config.json once it exists', async () => {
  writeFileSync(join(tempDir, '.claudio.json'), '{}')
  writeFileSync(join(tempDir, 'config.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, 'config.json'))
})
