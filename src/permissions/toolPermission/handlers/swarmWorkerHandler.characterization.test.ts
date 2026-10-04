/**
 * The swarm-worker route: a worker in an agent team does not ask its own
 * user, it sends the request to the team leader's mailbox and waits for the
 * leader's answer.
 *
 * The team lives on disk under a temp config home: its config file, and the
 * leader's inbox the request is written to. The leader's answer arrives the
 * way the worker's inbox poller delivers it, through
 * processMailboxPermissionResponse. The Bash classifier step before the
 * forward is built only with BASH_CLASSIFIER, and is pinned in
 * toolPermission.classifiers.characterization.test.tsx.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { clearAllPendingCallbacks, processMailboxPermissionResponse } from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import { REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX } from 'src/agent/messages/constants.js'
import { standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { handleSwarmWorkerPermission } from 'src/permissions/toolPermission/handlers/swarmWorkerHandler.js'
import { createPermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
import {
  contextSink,
  joinCrew,
  openSession,
  TURN,
  until,
  type Crew,
} from 'src/permissions/toolPermission/__testutils__/routeWorld.js'

const world = useDecisionWorld()
const INPUT = { command: 'npm publish' }
const ID = 'toolu_swarm'
const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]

let crew: Crew | undefined
const savedArgv = [...process.argv]
const savedTeamsFlag = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
afterEach(() => {
  crew?.leave()
  crew = undefined
  process.argv.splice(0, process.argv.length, ...savedArgv)
  if (savedTeamsFlag === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = savedTeamsFlag
  clearAllPendingCallbacks()
})

function forward(opts: { abort?: AbortController; equivalent?: boolean } = {}) {
  const session = openSession({ abort: opts.abort })
  const sink = contextSink()
  const tool = { ...standIn({ name: 'Bash' }), ...(opts.equivalent === false ? { inputsEquivalent: () => false } : {}) }
  const ctx = createPermissionContext(tool as never, INPUT, session, TURN, ID, sink.set)
  let settled: PermissionDecision | null | 'pending' = 'pending'
  const decision = handleSwarmWorkerPermission({ ctx, description: 'publish the package', updatedInput: undefined, suggestions })
  void decision.then(d => {
    settled = d
  })
  return { decision, session, sink, settled: () => settled }
}

/** Waits for the request to land in the leader's inbox and returns it. */
async function delivered(): Promise<Record<string, unknown>> {
  await until(() => (crew?.leaderInbox().length ?? 0) > 0)
  return crew?.leaderInbox()[0] ?? {}
}

describe('who takes this route', () => {
  test('nobody, unless agent teams are on', async () => {
    crew = joinCrew(world().configDir)
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    expect(await forward().decision).toBeNull()
    expect(crew.leaderInbox()).toEqual([])
  })

  test('the --agent-teams flag turns teams on as the variable does', async () => {
    crew = joinCrew(world().configDir)
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    process.argv.push('--agent-teams')
    const run = forward()
    expect((await delivered()).type).toBe('permission_request')
    expect(run.settled()).toBe('pending')
  })

  test('not a session that has joined no team', async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect(await forward().decision).toBeNull()
  })

  test('not the team leader', async () => {
    crew = joinCrew(world().configDir, { agentId: 'team-lead' })
    expect(await forward().decision).toBeNull()
    expect(crew.leaderInbox()).toEqual([])
  })

  test('a worker with no name falls back to its own dialog', async () => {
    crew = joinCrew(world().configDir, { agentName: '' })
    expect(await forward().decision).toBeNull()
    expect(crew.leaderInbox()).toEqual([])
  })
})

describe('the request a worker sends', () => {
  test("lands in the leader's inbox with the call, its description and the suggestions", async () => {
    crew = joinCrew(world().configDir)
    forward()
    const got = await delivered()
    expect(got).toEqual({
      from: 'worker-7',
      type: 'permission_request',
      request_id: expect.stringMatching(/^perm-\d+-[a-z0-9]+$/),
      agent_id: 'worker-7',
      tool_name: 'Bash',
      tool_use_id: ID,
      description: 'publish the package',
      input: INPUT,
      permission_suggestions: suggestions,
    })
  })

  test('shows the worker as waiting on the leader until the answer comes', async () => {
    crew = joinCrew(world().configDir)
    const run = forward()
    const request = await delivered()
    expect(run.session.state().pendingWorkerRequest).toEqual({ toolName: 'Bash', toolUseId: ID, description: 'publish the package' })
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'approved' })
    await run.decision
    expect(run.session.state().pendingWorkerRequest).toBeNull()
  })
})

describe("the leader's answer", () => {
  const approvals: Array<[string, Record<string, unknown> | undefined, Record<string, unknown>]> = [
    ['with no input keeps the call as made', undefined, INPUT],
    ['with an empty input keeps the call as made', {}, INPUT],
    ['with an edited input runs that', { command: 'npm publish --dry-run' }, { command: 'npm publish --dry-run' }],
  ]
  test.each(approvals)('an approval %s', async (_name, updatedInput, expected) => {
    crew = joinCrew(world().configDir)
    const run = forward()
    const request = await delivered()
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'approved', updatedInput })
    expect(await run.decision).toEqual({ behavior: 'allow', updatedInput: expected, userModified: false })
    expect(run.session.toolDecisions?.get(ID)).toMatchObject({ decision: 'accept', source: 'user_temporary' })
  })

  test('an approval counts as an edit when the tool says the inputs differ', async () => {
    crew = joinCrew(world().configDir)
    const run = forward({ equivalent: false })
    const request = await delivered()
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'approved', updatedInput: { command: 'x' } })
    expect(((await run.decision) as { userModified?: boolean }).userModified).toBe(true)
  })

  test("an approval's rule updates are saved for the worker", async () => {
    crew = joinCrew(world().configDir)
    const run = forward()
    const request = await delivered()
    processMailboxPermissionResponse({
      requestId: String(request.request_id),
      decision: 'approved',
      permissionUpdates: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm publish' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'nonsense' },
      ],
    })
    await run.decision
    const local = JSON.parse(readFileSync(world().settingsPath('local'), 'utf8'))
    expect(local.permissions.allow).toEqual(['Bash(npm publish)'])
    expect(run.session.toolDecisions?.get(ID)?.source).toBe('user_permanent')
  })

  const rejections: Array<[string, string | undefined, string, boolean]> = [
    ['with feedback hands it to the model and keeps the turn', 'use yarn', `${REJECT_MESSAGE_WITH_REASON_PREFIX}use yarn`, false],
    ['without feedback stops the turn', undefined, REJECT_MESSAGE, true],
  ]
  test.each(rejections)('a rejection %s', async (_name, feedback, message, aborted) => {
    crew = joinCrew(world().configDir)
    const run = forward()
    const request = await delivered()
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'rejected', feedback })
    expect(await run.decision).toEqual({ behavior: 'ask', message, contentBlocks: undefined })
    expect(run.session.abortController.signal.aborted).toBe(aborted)
    expect(run.session.state().pendingWorkerRequest).toBeNull()
    expect(run.session.toolDecisions?.get(ID)).toMatchObject({ decision: 'reject', source: 'user_reject' })
  })

  test('only the first answer counts', async () => {
    crew = joinCrew(world().configDir)
    const run = forward()
    const id = String((await delivered()).request_id)
    const first = processMailboxPermissionResponse({ requestId: id, decision: 'rejected', feedback: 'no' })
    const second = processMailboxPermissionResponse({ requestId: id, decision: 'approved' })
    expect([first, second, (await run.decision)?.behavior]).toEqual([true, false, 'ask'])
  })
})

describe('while waiting', () => {
  test('an abort cancels the request and stops the turn', async () => {
    crew = joinCrew(world().configDir)
    const abort = new AbortController()
    const run = forward({ abort })
    const request = await delivered()
    abort.abort()
    expect(await run.decision).toEqual({ behavior: 'ask', message: REJECT_MESSAGE, contentBlocks: undefined })
    expect(run.session.state().pendingWorkerRequest).toBeNull()
    // A late answer from the leader changes nothing.
    processMailboxPermissionResponse({ requestId: String(request.request_id), decision: 'approved' })
    await Bun.sleep(10)
    expect((await run.decision)?.behavior).toBe('ask')
  })

  test('a team with no config file never gets the request, and the worker waits until aborted', async () => {
    crew = joinCrew(world().configDir, { teamFile: false })
    const abort = new AbortController()
    const run = forward({ abort })
    await Bun.sleep(150)
    expect([run.settled(), crew.leaderInbox()]).toEqual(['pending', []])
    abort.abort()
    expect((await run.decision)?.behavior).toBe('ask')
  })
})
