/**
 * Characterization of the trust checks in permissions/ui/trust/utils.ts: seven
 * questions about what a checkout's own settings files would run, each
 * answered with the list of files that bring it. Written before the
 * clean-base rewrite of permissions/sessionDialogs; the spec is
 * docs/tech/rewrite/permissions/sessionDialogs.md.
 *
 * Every case writes real settings files into a fresh project directory (and,
 * where it matters, the user's settings into a fresh config directory), then
 * asks all seven questions at once, so a case also proves what is NOT counted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isolatedWorld } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import {
  getApiKeyHelperSources,
  getAwsCommandsSources,
  getBashPermissionSources,
  getDangerousEnvVarsSources,
  getGcpCommandsSources,
  getHooksSources,
  getOtelHeadersHelperSources,
} from 'src/permissions/ui/trust/utils.js'
import { getAllowedSettingSources, setAllowedSettingSources } from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const PROJECT = '.claudin/settings.json'
const LOCAL = '.claudin/settings.local.json'

type Label = typeof PROJECT | typeof LOCAL
type Answers = {
  hooks: Label[]
  bash: Label[]
  apiKeyHelper: Label[]
  aws: Label[]
  gcp: Label[]
  otel: Label[]
  env: Label[]
}

const ask = (): Answers => ({
  hooks: getHooksSources(),
  bash: getBashPermissionSources(),
  apiKeyHelper: getApiKeyHelperSources(),
  aws: getAwsCommandsSources(),
  gcp: getGcpCommandsSources(),
  otel: getOtelHeadersHelperSources(),
  env: getDangerousEnvVarsSources(),
}) as Answers

const NOTHING: Answers = { hooks: [], bash: [], apiKeyHelper: [], aws: [], gcp: [], otel: [], env: [] }

const commandHook = { type: 'command', command: 'echo hi' }
const someHooks = { PostToolUse: [{ matcher: 'Write', hooks: [commandHook] }] }

/** Settings that trip every one of the seven questions. */
const EVERYTHING = {
  hooks: someHooks,
  permissions: { allow: ['Bash(make:*)'] },
  apiKeyHelper: 'print-key',
  awsAuthRefresh: 'aws sso login',
  gcpAuthRefresh: 'gcloud auth login',
  otelHeadersHelper: 'print-headers',
  env: { NODE_OPTIONS: '--require ./x.js' },
}

type Case = {
  name: string
  project?: unknown
  local?: unknown
  user?: unknown
  expected: Partial<Answers>
}

const CASES: Case[] = [
  { name: 'a folder with no settings files', expected: {} },
  { name: 'empty settings objects', project: {}, local: {}, expected: {} },

  // hooks, and the two other things that run a command on their own
  { name: 'a hook in the shared file', project: { hooks: someHooks }, expected: { hooks: [PROJECT] } },
  { name: 'a hook in the local file', local: { hooks: someHooks }, expected: { hooks: [LOCAL] } },
  { name: 'hooks in both files, shared first', project: { hooks: someHooks }, local: { hooks: someHooks }, expected: { hooks: [PROJECT, LOCAL] } },
  { name: 'hook events with empty lists', project: { hooks: { PreToolUse: [], Stop: [] } }, expected: {} },
  { name: 'one empty event next to a filled one', local: { hooks: { PreToolUse: [], ...someHooks } }, expected: { hooks: [LOCAL] } },
  { name: 'a status line command', project: { statusLine: commandHook }, expected: { hooks: [PROJECT] } },
  { name: 'a file suggestion command', local: { fileSuggestion: commandHook }, expected: { hooks: [LOCAL] } },
  {
    name: 'disableAllHooks silences hooks, status line and file suggestion of its own file',
    project: { disableAllHooks: true, hooks: someHooks, statusLine: commandHook, fileSuggestion: commandHook },
    expected: {},
  },
  {
    name: 'disableAllHooks in one file leaves the other file counted',
    project: { disableAllHooks: true, hooks: someHooks },
    local: { hooks: someHooks },
    expected: { hooks: [LOCAL] },
  },
  { name: 'disableAllHooks: false changes nothing', project: { disableAllHooks: false, statusLine: commandHook }, expected: { hooks: [PROJECT] } },

  // Bash allow rules
  { name: 'allow Bash outright', project: { permissions: { allow: ['Bash'] } }, expected: { bash: [PROJECT] } },
  { name: 'allow one Bash prefix', local: { permissions: { allow: ['Bash(npm test:*)'] } }, expected: { bash: [LOCAL] } },
  { name: 'allow Bash among other tools', project: { permissions: { allow: ['Read', 'Bash(ls)', 'Edit'] } }, local: { permissions: { allow: ['Bash'] } }, expected: { bash: [PROJECT, LOCAL] } },
  { name: 'deny and ask Bash are not allows', project: { permissions: { deny: ['Bash'], ask: ['Bash(rm:*)'] } }, expected: {} },
  { name: 'allow other tools only', project: { permissions: { allow: ['Read', 'WebFetch(domain:example.com)', 'mcp__srv'] } }, expected: {} },
  { name: 'a tool whose name only starts with Bash', project: { permissions: { allow: ['BashOutput'] } }, expected: {} },

  // the helpers and the cloud credential commands
  { name: 'an apiKeyHelper', project: { apiKeyHelper: 'print-key' }, expected: { apiKeyHelper: [PROJECT] } },
  { name: 'an empty apiKeyHelper', project: { apiKeyHelper: '' }, expected: {} },
  { name: 'awsAuthRefresh', local: { awsAuthRefresh: 'aws sso login' }, expected: { aws: [LOCAL] } },
  { name: 'awsCredentialExport', project: { awsCredentialExport: 'print-creds' }, expected: { aws: [PROJECT] } },
  { name: 'both AWS commands in one file count once', project: { awsAuthRefresh: 'a', awsCredentialExport: 'b' }, expected: { aws: [PROJECT] } },
  { name: 'gcpAuthRefresh', project: { gcpAuthRefresh: 'gcloud auth login' }, local: { gcpAuthRefresh: 'x' }, expected: { gcp: [PROJECT, LOCAL] } },
  { name: 'otelHeadersHelper', local: { otelHeadersHelper: 'print-headers' }, expected: { otel: [LOCAL] } },

  // environment variables
  { name: 'an unsafe variable', project: { env: { NODE_OPTIONS: '--require x' } }, expected: { env: [PROJECT] } },
  { name: 'PATH is unsafe', local: { env: { PATH: '/tmp/bin' } }, expected: { env: [LOCAL] } },
  { name: 'only variables on the safe list', project: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x', ANTHROPIC_CUSTOM_HEADERS: 'y' } }, expected: {} },
  { name: 'a safe name in lower case is still safe', project: { env: { anthropic_default_opus_model: 'x' } }, expected: {} },
  { name: 'one unsafe among safe ones', project: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x', LD_PRELOAD: '/x.so' } }, expected: { env: [PROJECT] } },
  { name: 'an empty env', project: { env: {} }, expected: {} },

  // everything, everywhere
  {
    name: 'both files bringing everything',
    project: EVERYTHING,
    local: EVERYTHING,
    expected: { hooks: [PROJECT, LOCAL], bash: [PROJECT, LOCAL], apiKeyHelper: [PROJECT, LOCAL], aws: [PROJECT, LOCAL], gcp: [PROJECT, LOCAL], otel: [PROJECT, LOCAL], env: [PROJECT, LOCAL] },
  },
  { name: "the user's own settings are never counted", user: EVERYTHING, expected: {} },
  {
    name: 'a malformed shared file counts as nothing, the local file still counts',
    project: '{ "hooks": ',
    local: EVERYTHING,
    expected: { hooks: [LOCAL], bash: [LOCAL], apiKeyHelper: [LOCAL], aws: [LOCAL], gcp: [LOCAL], otel: [LOCAL], env: [LOCAL] },
  },
]

describe('trust checks on the settings a folder brings', () => {
  const world = isolatedWorld()

  const write = (path: string, body: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  }

  for (const { name, project, local, user, expected } of CASES) {
    test(name, () => {
      if (project !== undefined) write(join(world().project, PROJECT), project)
      if (local !== undefined) write(join(world().project, LOCAL), local)
      if (user !== undefined) write(join(world().config, 'settings.json'), user)
      resetSettingsCache()
      expect(ask()).toEqual({ ...NOTHING, ...expected })
    })
  }

  describe('when the session loads only some setting sources', () => {
    let before: ReturnType<typeof getAllowedSettingSources> = []
    beforeEach(() => {
      before = [...getAllowedSettingSources()]
    })
    afterEach(() => {
      setAllowedSettingSources(before)
      resetSettingsCache()
    })

    // The files are read whatever the session loads: the answers describe the
    // folder, not the session, so they can name a file the session ignores.
    const limited: Array<Parameters<typeof setAllowedSettingSources>[0]> = [['userSettings'], ['localSettings'], []]
    for (const sources of limited) {
      test(`with only [${sources.join(', ')}] loaded, both of the folder's files are still named`, () => {
        write(join(world().project, PROJECT), EVERYTHING)
        write(join(world().project, LOCAL), EVERYTHING)
        setAllowedSettingSources(sources)
        resetSettingsCache()
        const answers = ask()
        for (const key of Object.keys(NOTHING) as Array<keyof Answers>) expect([key, answers[key]]).toEqual([key, [PROJECT, LOCAL]])
      })
    }
  })
})
