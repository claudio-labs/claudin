/**
 * `/rename [name]`: the command's whole effect is what it tells the user, the
 * two lines it appends to the session transcript, and the name it puts in the
 * prompt bar's app state. Without a name it asks the small model for one;
 * that request is the only thing faked here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'

import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { runWithTeammateContext } from 'src/agent/coordinator/teammateContext.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getTranscriptPath } from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'

type NamingReply = { kind: 'text'; text: string } | { kind: 'throw'; why: string }
const namingRequests: Array<{ userPrompt: string; querySource: string }> = []
let namingReply: NamingReply = { kind: 'text', text: '{}' }

const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: async (request: { userPrompt: string; options: { querySource: string } }) => {
    namingRequests.push({ userPrompt: request.userPrompt, querySource: request.options.querySource })
    if (namingReply.kind === 'throw') throw new Error(namingReply.why)
    return { message: { content: [{ type: 'text', text: namingReply.text }] } }
  },
}))

const { call } = await import('src/commands/rename/rename.js')

let lab: WorktreeLab
beforeAll(() => {
  lab = openWorktreeLab()
})
afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  lab.close()
})
beforeEach(() => {
  namingRequests.length = 0
  namingReply = { kind: 'text', text: '{}' }
})

/** What one /rename run did, as the user and the session see it. */
type Run = {
  told: Array<{ text: string; display: unknown }>
  state: ReturnType<typeof getDefaultAppState>
  transcript: Array<Record<string, unknown>>
}

function transcriptLines(): Array<Record<string, unknown>> {
  const path = getTranscriptPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function rename(args: string, messages: Message[] = []): Promise<Run> {
  // Never append to a transcript outside the lab.
  expect(getTranscriptPath().startsWith(lab.configDir)).toBe(true)
  const before = transcriptLines().length
  let state = {
    ...getDefaultAppState(),
    standaloneAgentContext: { name: 'old-name', color: 'blue' },
  } as ReturnType<typeof getDefaultAppState>
  const told: Run['told'] = []
  const context = {
    messages,
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => {
      state = update(state)
    },
  }
  const returned = await call(
    (text?: string, options?: { display?: unknown }) => {
      told.push({ text: text ?? '', display: options?.display })
    },
    context as never,
    args,
  )
  expect(returned).toBeNull()
  return { told, state, transcript: transcriptLines().slice(before) }
}

const conversation = (): Message[] => [
  createUserMessage({ content: 'the login form rejects valid passwords' }),
  createAssistantMessage({ content: 'The hash comparison uses the wrong salt.' }),
]

describe('/rename with a name', () => {
  const names = [
    { args: 'release-checklist', expected: 'release-checklist' },
    { args: '   padded name  ', expected: 'padded name' },
  ]

  for (const { args, expected } of names) {
    test(`"${args}" becomes "${expected}" everywhere the session shows its name`, async () => {
      const run = await rename(args)

      expect(run.told).toEqual([{ text: `Session renamed to: ${expected}`, display: 'system' }])
      expect(run.transcript).toEqual([
        { type: 'custom-title', customTitle: expected, sessionId: getSessionId() },
        { type: 'agent-name', agentName: expected, sessionId: getSessionId() },
      ])
      expect(run.state.standaloneAgentContext).toEqual({ name: expected, color: 'blue' })
      expect(namingRequests).toEqual([])
    })
  }
})

describe('/rename without a name', () => {
  test('the model names the session from the conversation', async () => {
    namingReply = { kind: 'text', text: '{"name":"fix-login-salt"}' }
    const run = await rename('  ', conversation())

    expect(namingRequests).toHaveLength(1)
    expect(namingRequests[0]!.querySource).toBe('rename_generate_name')
    expect(namingRequests[0]!.userPrompt).toContain('the login form rejects valid passwords')
    expect(namingRequests[0]!.userPrompt).toContain('The hash comparison uses the wrong salt.')
    expect(run.told).toEqual([{ text: 'Session renamed to: fix-login-salt', display: 'system' }])
    expect(run.state.standaloneAgentContext?.name).toBe('fix-login-salt')
    expect(run.transcript.map(entry => entry.type)).toEqual(['custom-title', 'agent-name'])
  })

  const refusals: Array<{ name: string; messages: () => Message[]; reply: NamingReply; asksModel: boolean }> = [
    { name: 'an empty conversation', messages: () => [], reply: { kind: 'text', text: '{"name":"unused"}' }, asksModel: false },
    { name: 'a reply that is not JSON', messages: conversation, reply: { kind: 'text', text: 'fix-login-salt' }, asksModel: true },
    { name: 'a reply without a name field', messages: conversation, reply: { kind: 'text', text: '{"title":"x"}' }, asksModel: true },
    { name: 'a failed request', messages: conversation, reply: { kind: 'throw', why: 'rate limited' }, asksModel: true },
  ]

  for (const refusal of refusals) {
    test(`${refusal.name} leaves the name unchanged and says how to name it`, async () => {
      namingReply = refusal.reply
      const run = await rename('', refusal.messages())

      expect(run.told).toEqual([
        { text: 'Could not generate a name: no conversation context yet. Usage: /rename <name>', display: 'system' },
      ])
      expect(namingRequests.length).toBe(refusal.asksModel ? 1 : 0)
      expect(run.transcript).toEqual([])
      expect(run.state.standaloneAgentContext?.name).toBe('old-name')
    })
  }
})

describe('/rename inside a teammate', () => {
  test('is refused: the team leader names its teammates', async () => {
    const run = await runWithTeammateContext(
      {
        agentId: 'reviewer@crew',
        agentName: 'reviewer',
        teamName: 'crew',
        planModeRequired: false,
        parentSessionId: 'leader-session',
        isInProcess: true,
        abortController: new AbortController(),
      },
      () => rename('new-teammate-name'),
    )

    expect(run.told).toEqual([
      {
        text: 'Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.',
        display: 'system',
      },
    ])
    expect(run.transcript).toEqual([])
    expect(run.state.standaloneAgentContext?.name).toBe('old-name')
  })
})
