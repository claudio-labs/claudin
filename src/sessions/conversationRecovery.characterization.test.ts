/**
 * Characterization of how a resumed transcript is made ready for the REPL and
 * the API, pinned before the clean-base rewrite of `sessions/resume`: legacy
 * shapes brought up to date, entries the API would reject left out, a turn
 * the previous process never finished detected, and the skill and attachment
 * state the transcript already carries handed back to the process.
 *
 * The messages are built with the CLI's own message factories. The provider a
 * resume talks to is chosen the real way, with a provider profile in the
 * (in-memory, test) global config. The working directory is a temp project.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { join, relative } from 'path'

import {
  _getSkillLatchSnapshotForTests,
  createAttachmentMessage,
  getBashGitInstructionsAttachment,
  resetSentBashGitInstructions,
  resetSentSkillNames,
} from 'src/agent/attachments/attachments.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createProgressMessage,
  createSystemMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/agent/messages/messages.js'
import { clearInvokedSkills, getInvokedSkills } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { textOf } from 'src/sessions/__testutils__/resumeTranscripts.js'
import {
  deserializeMessages,
  deserializeMessagesWithInterruptDetection,
  restoreSkillStateFromMessages,
} from 'src/sessions/conversationRecovery.js'
import type { Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const sandbox = useRestoreSandbox()

const SENTINEL = NO_RESPONSE_REQUESTED
/** How `outline` shows the synthetic prompt that asks the model to pick the turn up again. */
const CONTINUE = '<continue>'

const ask = (text: string) => createUserMessage({ content: text })
const answer = (text: string) => createAssistantMessage({ content: text })
const call = (callId: string, name = 'Read') =>
  createAssistantMessage({ content: [{ type: 'tool_use', id: callId, name, input: { file_path: '/work/a.ts' } }] as never })
const result = (callId: string, output = 'contents') =>
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: callId, content: output }] })
const attached = (body: Record<string, unknown>) => createAttachmentMessage(body as never)
const hook = (event: string, callId = 'hook-call') =>
  attached({ type: 'hook_success', hookName: event, hookEvent: event, toolUseID: callId, content: '' })

/** A meta prompt that asks to continue: the facts the resume prompt must carry, not its wording. */
const isContinuation = (m: Message) => m.type === 'user' && m.isMeta === true && /\bcontinue\b/i.test(textOf(m))

/** What a message says, with the continuation prompt shown as `<continue>`. */
const said = (m: Message) => (isContinuation(m) ? CONTINUE : textOf(m))

/** A one-line picture of a message list: `user:hi`, `assistant:<call Read>`, `system:…`. */
const outline = (messages: Message[]) =>
  messages.map(m => `${m.type}:${m.type === 'attachment' ? (m.attachment as { type: string }).type : said(m)}`)

// --- interrupted turns ----------------------------------------------------------

describe('deserializeMessagesWithInterruptDetection — a turn left unfinished', () => {
  type Case = {
    name: string
    messages: () => Message[]
    kind: 'none' | 'interrupted_prompt'
    /** What the reported message says, for an interrupted prompt. */
    prompt?: string
    outline: string[]
  }
  const cases: Case[] = [
    { name: 'an empty transcript', messages: () => [], kind: 'none', outline: [] },
    {
      name: 'a finished exchange',
      messages: () => [ask('hi'), answer('hello')],
      kind: 'none',
      outline: ['user:hi', 'assistant:hello'],
    },
    {
      name: 'a prompt with no reply',
      messages: () => [ask('hi'), answer('hello'), ask('and now?')],
      kind: 'interrupted_prompt',
      prompt: 'and now?',
      outline: ['user:hi', 'assistant:hello', 'user:and now?', `assistant:${SENTINEL}`],
    },
    {
      name: 'a tool result the model never answered',
      messages: () => [ask('read it'), call('c1'), result('c1')],
      kind: 'interrupted_prompt',
      prompt: CONTINUE,
      outline: ['user:read it', 'assistant:<call Read>', 'user:<result contents>', `user:${CONTINUE}`, `assistant:${SENTINEL}`],
    },
    {
      name: 'an attachment after the reply',
      messages: () => [ask('hi'), answer('hello'), attached({ type: 'todo_reminder', content: [], itemCount: 0 })],
      kind: 'interrupted_prompt',
      prompt: CONTINUE,
      outline: ['user:hi', 'assistant:hello', 'attachment:todo_reminder', `user:${CONTINUE}`, `assistant:${SENTINEL}`],
    },
    {
      name: 'Stop hook output after the reply',
      messages: () => [ask('hi'), answer('hello'), hook('Stop')],
      kind: 'none',
      outline: ['user:hi', 'assistant:hello', 'attachment:hook_success'],
    },
    {
      name: 'async hook output after the reply',
      messages: () => [ask('hi'), answer('hello'), attached({ type: 'async_hook_response', processId: 'p', hookName: 'Stop', hookEvent: 'Stop', toolUseID: 't', response: {}, stdout: '', stderr: '' })],
      kind: 'none',
      outline: ['user:hi', 'assistant:hello', 'attachment:async_hook_response'],
    },
    {
      name: 'hook output after an unanswered tool result',
      messages: () => [ask('read it'), call('c1'), result('c1'), hook('PostToolUse', 'c1')],
      kind: 'interrupted_prompt',
      prompt: CONTINUE,
      outline: ['user:read it', 'assistant:<call Read>', 'user:<result contents>', 'attachment:hook_success', `user:${CONTINUE}`, `assistant:${SENTINEL}`],
    },
    {
      name: 'an API error as the last reply',
      messages: () => [ask('hi'), createAssistantAPIErrorMessage({ content: 'API Error: overloaded' })],
      kind: 'interrupted_prompt',
      prompt: 'hi',
      outline: ['user:hi', 'assistant:API Error: overloaded'],
    },
    {
      name: 'a meta user message last',
      messages: () => [ask('hi'), answer('hello'), createUserMessage({ content: 'caveat', isMeta: true })],
      kind: 'none',
      outline: ['user:hi', 'assistant:hello', 'user:caveat', `assistant:${SENTINEL}`],
    },
    {
      name: 'a compaction summary last',
      messages: () => [createUserMessage({ content: 'summary of before', isCompactSummary: true })],
      kind: 'none',
      outline: ['user:summary of before', `assistant:${SENTINEL}`],
    },
    {
      name: 'a prompt followed by a notice and progress',
      messages: () => [
        ask('hi'),
        createSystemMessage('a notice', 'info'),
        createProgressMessage({ toolUseID: 't', parentToolUseID: 't', data: { type: 'bash_progress' } as never }),
      ],
      kind: 'interrupted_prompt',
      prompt: 'hi',
      outline: ['user:hi', `assistant:${SENTINEL}`, 'system:', 'progress:'],
    },
    {
      name: 'only a notice',
      messages: () => [createSystemMessage('a notice', 'info')],
      kind: 'none',
      outline: ['system:'],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const resumed = deserializeMessagesWithInterruptDetection(c.messages())
      expect(resumed.turnInterruptionState.kind).toBe(c.kind)
      if (c.prompt !== undefined) {
        const state = resumed.turnInterruptionState as { message: Message }
        expect(said(state.message)).toBe(c.prompt)
      }
      expect(outline(resumed.messages)).toEqual(c.outline)
    })
  }

  test('the continuation is a meta prompt, and the reported message is the one in the list', () => {
    const resumed = deserializeMessagesWithInterruptDetection([ask('read it'), call('c1'), result('c1')])
    const state = resumed.turnInterruptionState as { kind: string; message: Message }
    expect(state.message).toMatchObject({ type: 'user', isMeta: true })
    expect(isContinuation(state.message)).toBe(true)
    expect(resumed.messages).toContain(state.message)
    expect(resumed.messages.at(-1)).toMatchObject({ type: 'assistant' })
  })

  test('deserializeMessages gives the same list, without the interruption report', () => {
    const input = () => [ask('hi'), answer('hello'), ask('and now?')]
    expect(outline(deserializeMessages(input()))).toEqual(outline(deserializeMessagesWithInterruptDetection(input()).messages))
  })
})

// --- entries the API would reject ---------------------------------------------------

describe('deserializeMessages — what is left out', () => {
  test('a call that never got a result is dropped, with nothing in its place', () => {
    const messages = [ask('read'), call('lost'), ask('anything?'), answer('yes')]
    expect(outline(deserializeMessages(messages))).toEqual(['user:read', 'user:anything?', 'assistant:yes'])
  })

  test('a reply with one answered and one unanswered call is kept whole', () => {
    const both = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'done', name: 'Read', input: {} },
        { type: 'tool_use', id: 'lost', name: 'Grep', input: {} },
      ] as never,
    })
    const resumed = deserializeMessages([ask('go'), both, result('done'), answer('ok')])
    expect(outline(resumed)).toEqual(['user:go', 'assistant:<call Read><call Grep>', 'user:<result contents>', 'assistant:ok'])
  })

  test('a reply of only whitespace is dropped', () => {
    expect(outline(deserializeMessages([ask('hi'), answer('\n\n  '), answer('real')]))).toEqual(['user:hi', 'assistant:real'])
  })

  test('a thinking-only reply is dropped unless a sibling block of the same response carries text', () => {
    const thinking = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }] as never })
    const orphan = deserializeMessages([ask('hi'), thinking, answer('hello')])
    expect(outline(orphan)).toEqual(['user:hi', 'assistant:hello'])

    const sibling = answer('hello')
    sibling.message.id = thinking.message.id
    const paired = deserializeMessages([ask('hi'), thinking, sibling])
    expect(paired).toHaveLength(3)
  })
})

// --- the provider decides about thinking blocks ---------------------------------------

describe('deserializeMessages — thinking blocks and the provider resumed against', () => {
  let saved: { providerProfiles: unknown; activeProviderProfileId: unknown }
  beforeEach(() => {
    const config = getGlobalConfig() as Record<string, unknown>
    saved = { providerProfiles: config.providerProfiles, activeProviderProfileId: config.activeProviderProfileId }
  })
  afterEach(() => {
    saveGlobalConfig(c => ({ ...c, ...(saved as object) }))
    invalidateActiveProviderCache()
  })

  function useProvider(provider: string | null, baseUrl = 'https://llm.example.test/v1') {
    if (provider === null) return
    const profile = { id: `p-${provider}`, name: provider, provider, baseUrl, model: 'some-model' }
    saveGlobalConfig(c => ({ ...c, providerProfiles: [profile], activeProviderProfileId: profile.id }) as never)
    invalidateActiveProviderCache()
  }

  const mixed = () => {
    const thought = createAssistantMessage({ content: [{ type: 'redacted_thinking', data: 'x' }] as never })
    const said = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'consider', signature: 'sig' },
        { type: 'text', text: 'answer' },
      ] as never,
    })
    said.message.id = thought.message.id
    return [ask('hi'), thought, said]
  }
  const blockTypes = (messages: Message[]) =>
    messages.flatMap(m => (m.type === 'assistant' ? [(m.message.content as Array<{ type: string }>).map(b => b.type).join('+')] : []))

  const cases = [
    { provider: null, kept: true },
    { provider: 'anthropic', kept: true },
    { provider: 'bedrock', kept: true },
    { provider: 'vertex', kept: true },
    { provider: 'foundry', kept: true },
    { provider: 'openai', kept: false },
    { provider: 'gemini', kept: false },
    { provider: 'mistral', kept: false },
  ]
  for (const c of cases) {
    test(`${c.provider ?? 'no profile'}: thinking blocks ${c.kept ? 'kept' : 'removed, and a reply left empty dropped'}`, () => {
      useProvider(c.provider)
      const shapes = blockTypes(deserializeMessages(mixed()))
      expect(shapes).toEqual(c.kept ? ['redacted_thinking', 'thinking+text'] : ['text'])
    })
  }
})

// --- legacy shapes ----------------------------------------------------------------------

describe('deserializeMessages — older transcripts', () => {
  const attachmentOf = (m: Message) => (m as { attachment: Record<string, unknown> }).attachment

  test('old attachment kinds are renamed, and every file-like attachment gets a path relative to the cwd', () => {
    const p = sandbox.projectDir
    const inputs = [
      { type: 'new_file', filename: join(p, 'src', 'a.ts'), content: 'x' },
      { type: 'new_directory', path: join(p, 'docs'), content: 'y' },
      { type: 'file', filename: join(p, 'b.ts'), content: 'z' },
      { type: 'directory', path: '/elsewhere/lib', content: '' },
      { type: 'skill_dir', skillDir: join(p, '.claudin', 'skills', 'tidy') },
      { type: 'file', filename: join(p, 'c.ts'), displayPath: 'kept as written' },
      { type: 'todo_reminder', content: [], itemCount: 0 },
    ]
    const resumed = deserializeMessages([ask('hi'), answer('ok'), ...inputs.map(attached)])
    const migrated = resumed.slice(2, 2 + inputs.length).map(attachmentOf)
    expect(migrated.map(a => [a.type, a.displayPath])).toEqual([
      ['file', join('src', 'a.ts')],
      ['directory', 'docs'],
      ['file', 'b.ts'],
      ['directory', relative(p, '/elsewhere/lib')],
      ['skill_dir', join('.claudin', 'skills', 'tidy')],
      ['file', 'kept as written'],
      ['todo_reminder', undefined],
    ])
    expect(migrated[0]).toMatchObject({ filename: join(p, 'src', 'a.ts'), content: 'x' })
  })

  const renamed = [
    { old: 'apply_patch', now: 'Patch' },
    { old: 'Task', now: 'Agent' },
    { old: 'KillShell', now: 'TaskStop' },
    { old: 'AgentOutputTool', now: 'TaskOutput' },
    { old: 'BashOutputTool', now: 'TaskOutput' },
    { old: 'Read', now: 'Read' },
    { old: 'constructor', now: 'constructor' },
  ]
  for (const r of renamed) {
    test(`a call to ${r.old} is read back as ${r.now}, its input and id untouched`, () => {
      const input = { anything: [1, 2] }
      const legacy = createAssistantMessage({ content: [{ type: 'tool_use', id: 'c9', name: r.old, input }] as never })
      const [, reread] = deserializeMessages([ask('go'), legacy, result('c9'), answer('done')])
      const block = (reread as { message: { content: Array<{ name: string; input: unknown; id: string }> } }).message.content[0]!
      expect(block as unknown).toEqual({ type: 'tool_use', id: 'c9', name: r.now, input })
    })
  }

  test('a permission mode this build does not know is cleared; a known one stays', () => {
    const known = createUserMessage({ content: 'planned', permissionMode: 'plan' })
    const unknown = createUserMessage({ content: 'from a newer build', permissionMode: 'turbo' as never })
    const resumed = deserializeMessages([known, answer('a'), unknown, answer('b')])
    expect(resumed.map(m => (m as { permissionMode?: string }).permissionMode)).toEqual(['plan', undefined, undefined, undefined])
  })

  test('a message too broken to read makes the whole call throw', () => {
    const broken = { type: 'attachment', uuid: randomUUID(), timestamp: '' } as unknown as Message
    expect(() => deserializeMessages([ask('hi'), broken])).toThrow()
  })
})

// --- state handed back to the process -----------------------------------------------------

describe('restoreSkillStateFromMessages', () => {
  afterEach(() => {
    clearInvokedSkills()
    resetSentSkillNames()
    resetSentBashGitInstructions()
  })

  test('invoked skills come back for the main thread; entries missing a field are skipped', () => {
    clearInvokedSkills()
    const skills = [
      { name: 'tidy', path: '/skills/tidy/SKILL.md', content: 'Tidy the tree.' },
      { name: 'empty', path: '/skills/empty/SKILL.md', content: '' },
      { name: '', path: '/skills/nameless/SKILL.md', content: 'x' },
      { name: 'pathless', path: '', content: 'x' },
    ]
    restoreSkillStateFromMessages([ask('hi'), attached({ type: 'invoked_skills', skills })])
    const restored = [...getInvokedSkills().entries()].map(([key, info]) => [key, info.skillPath, info.content, info.agentId])
    expect(restored).toEqual([[':tidy', '/skills/tidy/SKILL.md', 'Tidy the tree.', null]])
  })

  test('a skill listing already in the transcript holds back the next one', () => {
    resetSentSkillNames()
    restoreSkillStateFromMessages([answer('no listing here')])
    expect(_getSkillLatchSnapshotForTests().suppressNext).toBe(false)
    restoreSkillStateFromMessages([attached({ type: 'skill_listing', content: '- tidy', skillCount: 1, isInitial: true })])
    expect(_getSkillLatchSnapshotForTests().suppressNext).toBe(true)
  })

  test('git instructions already in the transcript hold back the next injection, once', async () => {
    const before = { node: process.env.NODE_ENV, off: process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS }
    process.env.NODE_ENV = 'production'
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'
    const injectFor = async (agentId: string) =>
      (await getBashGitInstructionsAttachment({ agentId, options: { tools: [{ name: 'Bash' }] } } as unknown as ToolUseContext)).length
    try {
      resetSentBashGitInstructions()
      const control = await injectFor(`control-${randomUUID()}`)
      restoreSkillStateFromMessages([attached({ type: 'bash_git_instructions', content: 'protocol' })])
      const held = await injectFor(`resumed-${randomUUID()}`)
      const next = await injectFor(`later-${randomUUID()}`)
      expect([control, held, next]).toEqual([1, 0, 1])
    } finally {
      if (before.node === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before.node
      if (before.off === undefined) delete process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS
      else process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = before.off
    }
  })
})
