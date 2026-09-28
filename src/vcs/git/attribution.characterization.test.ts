/**
 * Characterization of src/vcs/git/attribution.ts, pinned before the
 * clean-base rewrite: the text added to a commit message and to a pull request
 * body, which settings set it, what turns it off, and where the model is told
 * to put it. docs/tech/rewrite/vcs/gitDiff.md is the spec.
 *
 * Settings come from real files in a fresh temp tree per test: the user file
 * under CLAUDIN_CONFIG_DIR, the project and local files under the session's
 * original directory, and the managed file in a directory the platform path is
 * redirected to (its memo is seeded, since /etc/claude-code is not writable).
 * Nothing reads the real ~/.claudin or this repository's .claudin.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getAllowedSettingSources, getClientType, getOriginalCwd, setAllowedSettingSources, setClientType, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getBashGitInstructionsBody } from 'src/tools/BashTool/prompt.js'
import { getAttributionTexts } from 'src/vcs/git/attribution.js'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'SESSION_INGRESS_URL', 'CLAUDE_CODE_USE_COWORK_PLUGINS', 'CLAUDE_CODE_ENTRYPOINT'] as const
const EVERY_SOURCE: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
const NONE = { commit: '', pr: '' }

type Tree = { root: string; config: string; project: string; managed: string }
let tree: Tree
const saved = {
  env: new Map<string, string | undefined>(),
  clientType: 'cli',
  originalCwd: '',
  sources: [] as SettingSource[],
}

beforeAll(() => {
  for (const key of ENV_KEYS) saved.env.set(key, process.env[key])
  saved.clientType = getClientType()
  saved.originalCwd = getOriginalCwd()
  saved.sources = [...getAllowedSettingSources()]
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'attribution-char-')))
  tree = { root, config: join(root, 'config'), project: join(root, 'project'), managed: join(root, 'managed') }
  for (const dir of [tree.config, tree.project, tree.managed]) mkdirSync(dir)
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = tree.config
  setOriginalCwd(tree.project)
  setClientType('cli')
  setAllowedSettingSources([...EVERY_SOURCE])
  getManagedFilePath.cache.set(undefined, tree.managed)
  getManagedSettingsDropInDir.cache.set(undefined, join(tree.managed, 'managed-settings.d'))
  resetSettingsCache()
})

afterEach(() => {
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  setAllowedSettingSources([...saved.sources])
  setClientType(saved.clientType)
  setOriginalCwd(saved.originalCwd)
  for (const key of ENV_KEYS) {
    const value = saved.env.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSettingsCache()
  rmSync(tree.root, { recursive: true, force: true })
})

type Layer = 'user' | 'project' | 'local' | 'managed'

function settingsPath(layer: Layer): string {
  if (layer === 'user') return join(tree.config, 'settings.json')
  if (layer === 'managed') return join(tree.managed, 'managed-settings.json')
  return join(tree.project, '.claudin', layer === 'project' ? 'settings.json' : 'settings.local.json')
}

function setAttribution(layer: Layer, attribution: { commit?: string; pr?: string }): void {
  const file = settingsPath(layer)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ attribution }, null, 2))
  resetSettingsCache()
}

function remoteSession(id: string, ingress?: string): void {
  setClientType('remote')
  process.env.CLAUDE_CODE_REMOTE_SESSION_ID = id
  if (ingress !== undefined) process.env.SESSION_INGRESS_URL = ingress
}

describe('getAttributionTexts: from settings', () => {
  test('nothing configured: nothing is added to commits or pull requests', () => {
    expect(getAttributionTexts()).toStrictEqual(NONE)
  })

  test('configured texts come back exactly as written, spaces, line breaks and emoji included', () => {
    const commit = '  Co-authored-by: Pat <pat@example.invalid>\nReviewed-by: Sam  '
    const pr = '🧪 opened with Claudin\n'
    setAttribution('user', { commit, pr })
    expect(getAttributionTexts()).toStrictEqual({ commit, pr })
  })

  test('a field left out is empty', () => {
    setAttribution('user', { pr: 'pull request only' })
    expect(getAttributionTexts()).toStrictEqual({ commit: '', pr: 'pull request only' })
  })

  test('each field comes from the highest source that sets it; an empty string there hides the text below', () => {
    setAttribution('user', { commit: 'from user', pr: 'from user' })
    setAttribution('project', { commit: 'from project' })
    expect(getAttributionTexts()).toStrictEqual({ commit: 'from project', pr: 'from user' })
    setAttribution('local', { pr: '' })
    expect(getAttributionTexts()).toStrictEqual({ commit: 'from project', pr: '' })
    setAttribution('managed', { commit: 'from policy' })
    expect(getAttributionTexts()).toStrictEqual({ commit: 'from policy', pr: '' })
  })

  test.each(['sdk-cli', 'claude-vscode', 'github-action', 'local-agent'])('client type %s reads the settings too', clientType => {
    setAttribution('user', { commit: 'Signed-off-by: Pat <pat@example.invalid>' })
    setClientType(clientType)
    expect(getAttributionTexts()).toStrictEqual({ commit: 'Signed-off-by: Pat <pat@example.invalid>', pr: '' })
  })
})

describe('getAttributionTexts: remote sessions (client type "remote")', () => {
  test('both texts are the session link, and the settings are not read', () => {
    setAttribution('user', { commit: 'ignored here', pr: 'ignored here' })
    remoteSession('session_01RemoteChar')
    const link = 'https://claude.ai/code/session_01RemoteChar'
    expect(getAttributionTexts()).toStrictEqual({ commit: link, pr: link })
  })

  test('a cse_ id is linked under its session_ name', () => {
    remoteSession('cse_01RemoteChar')
    expect(getAttributionTexts().commit).toBe('https://claude.ai/code/session_01RemoteChar')
  })

  test('a staging id, or a staging ingress URL, links to the staging site', () => {
    remoteSession('session_staging_01Char')
    expect(getAttributionTexts().pr).toBe('https://claude-ai.staging.ant.dev/code/session_staging_01Char')
    remoteSession('session_01Char', 'https://ingress.staging.example.invalid/v1')
    expect(getAttributionTexts().pr).toBe('https://claude-ai.staging.ant.dev/code/session_01Char')
  })

  test('a local-development session (a _local_ id or a localhost ingress) adds nothing', () => {
    setAttribution('user', { commit: 'still ignored' })
    remoteSession('session_local_01Char')
    expect(getAttributionTexts()).toStrictEqual(NONE)
    remoteSession('session_01Char', 'http://localhost:8080/ingress')
    expect(getAttributionTexts()).toStrictEqual(NONE)
  })

  test('no session id adds nothing, whatever the settings say', () => {
    setAttribution('user', { commit: 'still ignored', pr: 'still ignored' })
    setClientType('remote')
    expect(getAttributionTexts()).toStrictEqual(NONE)
  })
})

// The instructions render the example commands with escaped newlines and
// quotes, so `\\n` below is a backslash and an n, as the model reads it.
describe('where the texts go: the git instructions the Bash tool gives the model', () => {
  const COMMIT = 'Co-authored-by: Pat <pat@example.invalid>'
  const PR = 'Opened with Claudin'

  test('a commit text ends the commit message after a blank line; a PR text ends the PR body the same way', () => {
    setAttribution('user', { commit: COMMIT, pr: PR })
    const body = getBashGitInstructionsBody()
    expect(body).toContain(`Body line here.\\n\\n${COMMIT}\\"`)
    expect(body).toContain(`\n\n${COMMIT}\n\n<example>`)
    expect(body).toContain(`\\n\\n${PR}'"]})`)
    expect(body).not.toMatch(/AI attribution trailer|AI footer/)
  })

  test('with no texts, or empty ones, the examples stop at the body and the model is told to add no AI trailer or footer', () => {
    const plain = getBashGitInstructionsBody()
    setAttribution('user', { commit: '', pr: '' })
    expect(getBashGitInstructionsBody()).toBe(plain)
    expect(plain).toContain('Body line here.\\"')
    expect(plain).toContain(`]'"]})`)
    expect(plain).toMatch(/AI attribution trailer/)
    expect(plain).toMatch(/AI footer/)
  })

  test('only the commit text set: the PR rule still applies', () => {
    setAttribution('user', { commit: COMMIT })
    const body = getBashGitInstructionsBody()
    expect(body).toContain(`Body line here.\\n\\n${COMMIT}\\"`)
    expect(body).not.toMatch(/AI attribution trailer/)
    expect(body).toMatch(/AI footer/)
  })

  test('a remote session puts its link in both places', () => {
    remoteSession('session_01RemoteChar')
    const body = getBashGitInstructionsBody()
    expect(body).toContain('Body line here.\\n\\nhttps://claude.ai/code/session_01RemoteChar\\"')
    expect(body).toContain(`\\n\\nhttps://claude.ai/code/session_01RemoteChar'"]})`)
  })
})
