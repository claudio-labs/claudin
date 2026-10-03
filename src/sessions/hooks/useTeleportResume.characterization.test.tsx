/**
 * Characterization of `useTeleportResume`: the state behind the `--teleport`
 * session picker. Picking a claude.ai session fetches it and its transcript
 * from the Anthropic API, then marks this process as teleported.
 *
 * The API is a `FakeSessionsApi` on a local port; the login is a credentials
 * file in a temp CLAUDIN_CONFIG_DIR, the organization comes from the global
 * config, and an organization policy is a `policy-limits.json` cache there.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { CodeSession } from 'src/platform/teleport/api.js'
import { getTeleportedSessionInfo } from 'src/platform/bootstrap/state.js'
import { _resetPolicyLimitsForTesting } from 'src/platform/policyLimits/index.js'
import { useTeleportResume } from 'src/sessions/hooks/useTeleportResume.js'
import {
  FakeSessionsApi,
  type HookUnderTest,
  mountHook,
  openScratch,
  pointAnthropicApiAt,
  restoreAnthropicApi,
  type Scratch,
  signIn,
  unmountAll,
  waitFor,
} from 'src/sessions/__testutils__/remoteRig.js'

const ID = 'session_01teleport'
const LOGIN = { accessToken: 'teleport-token', organizationUuid: 'org-teleport' }

const picked: CodeSession = {
  id: ID,
  title: 'Port the parser',
  description: '',
  status: 'idle',
  repo: null,
  turns: [],
  created_at: '2026-09-30T10:00:00Z',
  updated_at: '2026-09-30T11:00:00Z',
}

function sessionResource(sources: unknown[] = []) {
  return {
    type: 'session',
    id: ID,
    title: 'Port the parser',
    session_status: 'idle',
    environment_id: 'env_1',
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-09-30T11:00:00Z',
    session_context: {
      sources,
      cwd: '/remote/work',
      outcomes: [{ type: 'git_repository', git_info: { type: 'github', repo: 'acme/parser', branches: ['claude/port-parser'] } }],
      custom_system_prompt: null,
      append_system_prompt: null,
      model: null,
    },
  }
}

const userEntry = {
  type: 'user',
  uuid: '11111111-1111-4111-8111-111111111111',
  parentUuid: null,
  isSidechain: false,
  sessionId: ID,
  timestamp: '2026-09-30T10:01:00Z',
  message: { role: 'user', content: 'port the parser to the new AST' },
}
const assistantEntry = {
  type: 'assistant',
  uuid: '22222222-2222-4222-8222-222222222222',
  parentUuid: userEntry.uuid,
  isSidechain: false,
  sessionId: ID,
  timestamp: '2026-09-30T10:02:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
}
const sidechainEntry = { ...assistantEntry, uuid: '33333333-3333-4333-8333-333333333333', isSidechain: true }

const event = (payload: unknown, n: number) => ({
  event_id: `ev_${n}`,
  event_type: 'transcript',
  is_compaction: false,
  payload,
  created_at: '2026-09-30T10:03:00Z',
})

let api: FakeSessionsApi
let scratch: Scratch

beforeEach(() => {
  scratch = openScratch('teleport-resume')
  api = new FakeSessionsApi()
  pointAnthropicApiAt(api.base)
  _resetPolicyLimitsForTesting()
})

afterEach(() => {
  unmountAll()
  api.stop()
  pointAnthropicApiAt(null)
  _resetPolicyLimitsForTesting()
  scratch.dispose()
})

afterAll(() => {
  restoreAnthropicApi()
})

type Hook = ReturnType<typeof useTeleportResume>

function serveTheSession(sources: unknown[] = []): void {
  api.answer('GET', `/v1/sessions/${ID}`, 200, sessionResource(sources))
  api.answer('GET', `/v1/code/sessions/${ID}/teleport-events`, 200, {
    data: [event(userEntry, 1), event(sidechainEntry, 2), event(assistantEntry, 3)],
  })
}

async function mountPicker(source: 'cliArg' | 'localCommand' = 'cliArg'): Promise<HookUnderTest<'cliArg' | 'localCommand', Hook>> {
  return mountHook(useTeleportResume, source)
}

test('before anything is picked: not resuming, no error, no session', async () => {
  const hook = await mountPicker()
  expect(hook.current()).toMatchObject({ isResuming: false, error: null, selectedSession: null })
  expect(getTeleportedSessionInfo()).toBeNull()
})

test('resuming a session returns its transcript and branch, and marks the process teleported', async () => {
  signIn(scratch, LOGIN)
  serveTheSession()
  const hook = await mountPicker()
  const result = await hook.current().resumeSession(picked)
  expect(result).not.toBeNull()
  expect(result!.branch).toBe('claude/port-parser')
  expect(result!.log.map((m: { uuid: string }) => m.uuid)).toEqual([userEntry.uuid, assistantEntry.uuid])
  await waitFor(() => hook.current().isResuming === false)
  expect(hook.returns.some(r => r.isResuming && r.selectedSession === picked)).toBe(true)
  expect(hook.current()).toMatchObject({ isResuming: false, error: null, selectedSession: picked })
  expect(getTeleportedSessionInfo()).toMatchObject({ isTeleported: true, sessionId: ID })

  const fetched = api.callsTo('GET', `/v1/sessions/${ID}`)[0]!
  expect(fetched.headers.authorization).toBe('Bearer teleport-token')
  expect(fetched.headers['x-organization-uuid']).toBe('org-teleport')
})

type Failure = {
  name: string
  arrange: () => void
  message: string
  operation: boolean
}

const failures: Failure[] = [
  {
    name: 'the session is gone',
    arrange: () => signIn(scratch, LOGIN),
    message: `Session not found: ${ID}`,
    operation: true,
  },
  {
    name: 'no claude.ai login',
    arrange: () => serveTheSession(),
    message: 'Please run /login',
    operation: true,
  },
  {
    name: 'the session needs a checkout of another repository',
    arrange: () => {
      signIn(scratch, LOGIN)
      serveTheSession([{ type: 'git_repository', url: 'https://github.com/acme/parser' }])
    },
    message: 'acme/parser',
    operation: true,
  },
  {
    name: 'the organization forbids remote sessions',
    arrange: () => {
      process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
      signIn(scratch, { ...LOGIN, subscriptionType: 'team' })
      writeFileSync(
        join(scratch.configDir, 'policy-limits.json'),
        JSON.stringify({ restrictions: { allow_remote_sessions: { allowed: false } } }),
      )
      serveTheSession()
    },
    message: 'disabled by your organization',
    operation: false,
  },
]

test.each(failures)('a failed resume gives null and an error: $name', async failure => {
  failure.arrange()
  const hook = await mountPicker()
  expect(await hook.current().resumeSession(picked)).toBeNull()
  await waitFor(() => hook.current().error !== null)
  const { error, isResuming, selectedSession } = hook.current()
  expect(isResuming).toBe(false)
  expect(selectedSession).toBe(picked)
  expect(error!.message).toContain(failure.message)
  expect(error!.isOperationError).toBe(failure.operation)
  if (failure.operation) expect(error!.formattedMessage).toContain(failure.message)
  else expect(error!.formattedMessage).toBeUndefined()
  expect(getTeleportedSessionInfo()).toBeNull()
})

test('clearError drops the error and keeps the rest', async () => {
  signIn(scratch, LOGIN)
  const hook = await mountPicker()
  await hook.current().resumeSession(picked)
  await waitFor(() => hook.current().error !== null)
  hook.current().clearError()
  await waitFor(() => hook.current().error === null)
  expect(hook.current().selectedSession).toBe(picked)
})

test('a new attempt starts by clearing the previous error', async () => {
  signIn(scratch, LOGIN)
  const hook = await mountPicker()
  await hook.current().resumeSession(picked)
  await waitFor(() => hook.current().error !== null)
  serveTheSession()
  const before = hook.returns.length
  const result = await hook.current().resumeSession({ ...picked, title: 'Second try' })
  expect(result).not.toBeNull()
  await waitFor(() => hook.current().isResuming === false)
  const during = hook.returns.slice(before).find(r => r.isResuming)
  expect(during?.error).toBeNull()
  expect(during?.selectedSession?.title).toBe('Second try')
})

test('the result keeps its identity across renders, and the resume function follows the source', async () => {
  const hook = await mountPicker('cliArg')
  const first = hook.current()
  await hook.rerender('cliArg')
  expect(hook.current()).toBe(first)
  await hook.rerender('localCommand')
  expect(hook.current().resumeSession).not.toBe(first.resumeSession)
  expect(hook.current().clearError).toBe(first.clearError)
})
