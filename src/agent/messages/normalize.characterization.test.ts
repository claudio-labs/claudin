/**
 * Characterization tests for src/agent/messages/normalize.ts, written before the
 * Gemini-native work changes it (feat/gemini-native). They pin today's
 * behavior, odd parts included — a comment marks each one that looks odd.
 *
 * No mock.module: the globals the module reads (tool search mode, the active
 * provider, the strict-pairing flag) are driven through the real env, config
 * and bootstrap state, and put back in afterEach.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { NO_CONTENT_MESSAGE } from 'src/agent/prompts/messages.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from 'src/agent/messages/constants.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from 'src/agent/messages/factories.js'
import {
  ensureToolResultPairing,
  filterUnresolvedToolUses,
  mergeUserMessagesAndToolResults,
  normalizeContentFromAPI,
  normalizeMessages,
  normalizeMessagesForAPI,
  reorderMessagesInUI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from 'src/agent/messages/normalize.js'
import {
  getStrictToolResultPairing,
  setStrictToolResultPairing,
} from 'src/platform/bootstrap/state.js'
import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import {
  getImageTooLargeErrorMessage,
  getPdfTooLargeErrorMessage,
} from 'src/providers/transport/errors.js'
import type { Tools } from 'src/tools/Tool.js'
import type {
  AssistantMessage,
  Message,
  NormalizedAssistantMessage,
  UserMessage,
} from 'src/shared/types/message.js'

const originalToolSearch = process.env.ENABLE_TOOL_SEARCH
const originalStrict = getStrictToolResultPairing()

function useToolSearch(on: boolean): void {
  process.env.ENABLE_TOOL_SEARCH = on ? 'true' : 'false'
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
}

beforeEach(() => {
  useToolSearch(false)
})

afterEach(() => {
  if (originalToolSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH
  else process.env.ENABLE_TOOL_SEARCH = originalToolSearch
  setStrictToolResultPairing(originalStrict)
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

// ---------- fixtures ----------

type Block = Record<string, unknown>

function assistant(content: Block[], id?: string): AssistantMessage {
  const message = createAssistantMessage({ content: content as never })
  if (id) message.message.id = id
  return message
}

function user(content: string | Block[], extra: { isMeta?: true } = {}): UserMessage {
  return createUserMessage({ content: content as never, ...extra })
}

function toolUse(id: string, name = 'Bash', input: Block = {}): Block {
  return { type: 'tool_use', id, name, input }
}

function toolResult(id: string, content: unknown = 'ok', extra: Block = {}): Block {
  return { type: 'tool_result', tool_use_id: id, content, ...extra }
}

function text(value: string): Block {
  return { type: 'text', text: value }
}

function contentOf(message: Message): unknown {
  return (message as UserMessage | AssistantMessage).message.content
}

function hook(event: 'PreToolUse' | 'PostToolUse', toolUseID: string): Message {
  return {
    type: 'attachment',
    uuid: `hook-${event}-${toolUseID}`,
    timestamp: '2026-10-28T00:00:00.000Z',
    attachment: {
      type: 'hook_success',
      hookName: `${event}:Bash`,
      toolUseID,
      hookEvent: event,
      content: '',
    },
  } as never
}

function apiError(uuid: string): Message {
  return {
    type: 'system',
    subtype: 'api_error',
    uuid,
    timestamp: '2026-10-28T00:00:00.000Z',
    level: 'error',
  } as never
}

// ---------- normalizeMessages ----------

describe('normalizeMessages passes non-chat messages through', () => {
  test('attachment, progress and system messages come back as the same objects', () => {
    const attachment = hook('PreToolUse', 't1')
    const system = apiError('sys-1')
    const progress = { type: 'progress', uuid: 'p-1' } as never as Message
    const out = normalizeMessages([attachment, progress, system])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(attachment as never)
    expect(out[1]).toBe(progress as never)
    expect(out[2]).toBe(system as never)
  })
})

// ---------- reorderMessagesInUI ----------

describe('reorderMessagesInUI', () => {
  type UIMessage = Parameters<typeof reorderMessagesInUI>[0][number]
  const ui = (messages: Message[]) => messages as UIMessage[]

  test('a tool call is followed by its pre hooks, its result and its post hooks, whatever order they arrived in', () => {
    const prompt = user('go')
    const call = assistant([toolUse('t1')])
    const post = hook('PostToolUse', 't1')
    const result = user([toolResult('t1')])
    const pre = hook('PreToolUse', 't1')
    const after = user('after')
    const out = reorderMessagesInUI(ui([prompt, call, post, result, pre, after]), [])
    expect(out).toEqual(ui([prompt, call, pre, result, post, after]))
  })

  test('a tool_result or hook with no tool call in the list is dropped', () => {
    const prompt = user('go')
    const out = reorderMessagesInUI(
      ui([prompt, user([toolResult('ghost')]), hook('PreToolUse', 'ghost'), hook('PostToolUse', 'ghost')]),
      [],
    )
    expect(out).toEqual(ui([prompt]))
  })

  test('two messages carrying the same tool_use id render once, at the first position, as the later one', () => {
    const first = assistant([toolUse('t1')])
    const second = assistant([toolUse('t1', 'Read')])
    const middle = user('between')
    const out = reorderMessagesInUI(ui([first, middle, second]), [])
    expect(out).toEqual(ui([second, middle]))
  })

  test('consecutive api errors collapse into the last one, and only a trailing one survives', () => {
    const a = user('a')
    const e1 = apiError('e1')
    const e2 = apiError('e2')
    const b = user('b')
    const e3 = apiError('e3')
    expect(reorderMessagesInUI(ui([a, e1, e2]), [])).toEqual(ui([a, e2]))
    expect(reorderMessagesInUI(ui([a, e1, b, e3]), [])).toEqual(ui([a, b, e3]))
    expect(reorderMessagesInUI(ui([a, e1, b]), [])).toEqual(ui([a, b]))
  })

  test('synthetic streaming tool uses go at the end, and then no api error survives', () => {
    const a = user('a')
    const err = apiError('e1')
    const synthetic = assistant([toolUse('stream-1')]) as never as NormalizedAssistantMessage
    // Odd but current: the trailing api error is dropped because the synthetic
    // message, not the error, is now last.
    expect(reorderMessagesInUI(ui([a, err]), [synthetic])).toEqual(ui([a, synthetic as never]))
  })
})

// ---------- stripToolReferenceBlocksFromUserMessage ----------

describe('stripToolReferenceBlocksFromUserMessage', () => {
  test('removes tool_reference blocks and leaves every other block alone', () => {
    const plain = text('note')
    const stringResult = toolResult('s', 'kept')
    const message = user([
      toolResult('a', [{ type: 'tool_reference', tool_name: 'Read' }, text('loaded')]),
      stringResult,
      plain,
    ])
    const out = stripToolReferenceBlocksFromUserMessage(message)
    expect(out.uuid).toBe(message.uuid)
    expect(contentOf(out)).toEqual([toolResult('a', [text('loaded')]), stringResult, plain])
  })

  test('a tool_result that held only references gets a placeholder', () => {
    const out = stripToolReferenceBlocksFromUserMessage(
      user([toolResult('a', [{ type: 'tool_reference', tool_name: 'Read' }], { is_error: false })]),
    )
    expect(contentOf(out)).toEqual([
      toolResult('a', [{ type: 'text', text: '[Tool references removed - tool search not enabled]' }], {
        is_error: false,
      }),
    ])
  })

  test('a message with no reference, or with string content, is returned as is', () => {
    const none = user([toolResult('a', [text('x')])])
    const str = user('hello')
    expect(stripToolReferenceBlocksFromUserMessage(none)).toBe(none)
    expect(stripToolReferenceBlocksFromUserMessage(str)).toBe(str)
  })
})

// ---------- tool references through normalizeMessagesForAPI ----------

describe('normalizeMessagesForAPI and tool_reference blocks', () => {
  const tools = [{ name: 'Read' }, { name: 'Agent' }] as never as Tools
  const ref = (name: string) => ({ type: 'tool_reference', tool_name: name })

  test('tool search on: references to tools that are gone are dropped, and the turn boundary is added', () => {
    useToolSearch(true)
    const out = normalizeMessagesForAPI(
      [user([toolResult('a', [ref('Read'), ref('Gone'), ref('Task')])])],
      tools,
    )
    expect(out).toHaveLength(1)
    // Task is the legacy name of Agent, so its reference survives.
    expect(contentOf(out[0]!)).toEqual([
      toolResult('a', [ref('Read'), ref('Task')]),
      { type: 'text', text: 'Tool loaded.' },
    ])
  })

  test('tool search on: a result whose every reference is gone gets a placeholder and no turn boundary', () => {
    useToolSearch(true)
    const out = normalizeMessagesForAPI([user([toolResult('a', [ref('Gone')])])], tools)
    expect(contentOf(out[0]!)).toEqual([
      toolResult('a', [{ type: 'text', text: '[Tool references removed - tools no longer available]' }]),
    ])
  })

  test('tool search on: a message that already carries the boundary does not get a second one', () => {
    useToolSearch(true)
    const out = normalizeMessagesForAPI(
      [user([toolResult('a', [ref('Read')]), text('Tool loaded.')])],
      tools,
    )
    expect(contentOf(out[0]!)).toEqual([toolResult('a', [ref('Read')]), text('Tool loaded.')])
  })

  test('tool search off: every reference is stripped and no boundary is added', () => {
    useToolSearch(false)
    const out = normalizeMessagesForAPI([user([toolResult('a', [ref('Read'), text('body')])])], tools)
    expect(contentOf(out[0]!)).toEqual([toolResult('a', [text('body')])])
  })
})

// ---------- tool_use rebuild in normalizeMessagesForAPI ----------

describe('normalizeMessagesForAPI rebuilds tool_use blocks', () => {
  const exitPlan = [{ name: 'ExitPlanMode', aliases: ['OldExitPlan'] }] as never as Tools
  const stored = {
    ...toolUse('t1', 'OldExitPlan', { plan: 'p', planFilePath: '/p.md', keep: 1 }),
    caller: { type: 'direct' },
    extra_content: { google: { thought_signature: 'sig' } },
    signature: 'sig-block',
  }

  test('tool search off: only the standard fields go out, under the canonical name, with the input normalized', () => {
    useToolSearch(false)
    const out = normalizeMessagesForAPI([user('q'), assistant([stored])], exitPlan)
    expect(contentOf(out[1]!)).toEqual([
      { type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { keep: 1 } },
    ])
  })

  // The Gemini fields (extra_content, signature) go out only under Gemini; a
  // session that switched from Gemini sent `signature` to the Anthropic API.
  test('tool search on: every stored field but the Gemini ones is kept', () => {
    useToolSearch(true)
    const out = normalizeMessagesForAPI([user('q'), assistant([stored])], exitPlan)
    expect(contentOf(out[1]!)).toEqual([
      {
        type: 'tool_use',
        id: 't1',
        name: 'ExitPlanMode',
        input: { keep: 1 },
        caller: { type: 'direct' },
      },
    ])
  })

  test('an unknown tool keeps its name and input untouched', () => {
    useToolSearch(false)
    const out = normalizeMessagesForAPI(
      [user('q'), assistant([toolUse('t1', 'Mystery', { plan: 'p' })])],
      exitPlan,
    )
    expect(contentOf(out[1]!)).toEqual([toolUse('t1', 'Mystery', { plan: 'p' })])
  })
})

// ---------- other normalizeMessagesForAPI passes ----------

describe('normalizeMessagesForAPI message-level passes', () => {
  test('a local_command system message becomes user text merged into the user before it', () => {
    const local = {
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>ok</local-command-stdout>',
      uuid: 'local-1',
      timestamp: '2026-10-28T00:00:00.000Z',
      level: 'info',
    } as never as Message
    const out = normalizeMessagesForAPI([user('before'), local])
    expect(out).toHaveLength(1)
    expect(contentOf(out[0]!)).toEqual([
      text('before\n'),
      text('<local-command-stdout>ok</local-command-stdout>'),
    ])
  })

  test('a local_command system message with no user before it stands as its own user message', () => {
    const local = {
      type: 'system',
      subtype: 'local_command',
      content: 'out',
      uuid: 'local-2',
      timestamp: '2026-10-28T00:00:00.000Z',
      level: 'info',
    } as never as Message
    const out = normalizeMessagesForAPI([assistant([text('hi')]), local])
    expect(out.map(m => m.type)).toEqual(['assistant', 'user'])
    expect(out[1]!.uuid as string).toBe('local-2')
    expect(contentOf(out[1]!)).toBe('out')
  })

  test('a PDF-too-large error strips documents from the meta message before it, and drops the error', () => {
    const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }
    const meta = user([pdf, text('see the pdf')], { isMeta: true })
    const error = createAssistantAPIErrorMessage({ content: getPdfTooLargeErrorMessage() })
    const out = normalizeMessagesForAPI([user('read it'), meta, error, user('ok')])
    expect(out).toHaveLength(1)
    expect(contentOf(out[0]!)).toEqual([text('read it\n'), text('see the pdf\n'), text('ok')])
  })

  test('an image-too-large error drops a meta message that held only the image', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    const meta = user([image], { isMeta: true })
    const err1 = createAssistantAPIErrorMessage({ content: 'Some other failure' })
    const err2 = createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() })
    const out = normalizeMessagesForAPI([assistant([text('a')]), meta, err1, err2, user('next')])
    expect(out.map(m => m.type)).toEqual(['assistant', 'user'])
    // Not merged with the dropped meta message, so the content is still the string.
    expect(contentOf(out[1]!)).toBe('next')
  })

  test('the strip only reaches a meta message: a plain user message before the error keeps its image', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    const plain = user([image, text('look')])
    const err = createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() })
    const out = normalizeMessagesForAPI([plain, err])
    expect(contentOf(out[0]!)).toEqual([image, text('look')])
  })

  test('the final assistant loses its trailing thinking blocks', () => {
    const out = normalizeMessagesForAPI([
      user('q'),
      assistant([text('answer'), { type: 'thinking', thinking: 't', signature: 's' }, { type: 'redacted_thinking', data: 'r' }]),
    ])
    expect(contentOf(out[1]!)).toEqual([text('answer')])
  })

  test('a final assistant made only of thinking (kept by a same-id sibling) becomes a placeholder', () => {
    const out = normalizeMessagesForAPI([
      user('q'),
      assistant([text('first part')], 'msg-shared'),
      user('interjection'),
      assistant([{ type: 'thinking', thinking: 't', signature: 's' }], 'msg-shared'),
    ])
    expect(out.map(m => m.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(contentOf(out[3]!)).toEqual([
      { type: 'text', text: '[No message content]', citations: [] },
    ])
  })

  test('thinking in the middle of the final assistant is not touched', () => {
    const thinking = { type: 'thinking', thinking: 't', signature: 's' }
    const out = normalizeMessagesForAPI([user('q'), assistant([thinking, text('end')])])
    expect(contentOf(out[1]!)).toEqual([thinking, text('end')])
  })

  test('an empty non-final assistant gets the no-content placeholder; an empty final one stays empty', () => {
    const out = normalizeMessagesForAPI([user('q'), assistant([]), user('again'), assistant([])])
    expect(contentOf(out[1]!)).toEqual([{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }])
    expect(contentOf(out[3]!)).toEqual([])
  })

  test('an is_error tool_result keeps only its text, joined by blank lines', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    const out = normalizeMessagesForAPI([
      user('q'),
      assistant([toolUse('t1'), toolUse('t2')]),
      user([
        toolResult('t1', [text('first'), image, text('second')], { is_error: true }),
        toolResult('t2', [image], { is_error: true }),
      ]),
    ])
    expect(contentOf(out[2]!)).toEqual([
      toolResult('t1', [text('first\n\nsecond')], { is_error: true }),
      toolResult('t2', [], { is_error: true }),
    ])
  })
})

// ---------- stripCallerFieldFromAssistantMessage ----------

describe('stripCallerFieldFromAssistantMessage', () => {
  const GEMINI: ProviderProfile = {
    id: 'norm-gemini',
    name: 'Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
    apiKey: 'test-key',
  }
  const ANTHROPIC: ProviderProfile = {
    id: 'norm-anthropic',
    name: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
  }
  const callerBlock = {
    ...toolUse('t1', 'Read', { file_path: '/x' }),
    caller: { type: 'direct' },
    extra_content: { google: { thought_signature: 'sig' } },
    signature: 'block-sig',
  }

  test('a tool_use with a caller is rebuilt from its standard fields; other blocks stay as they are', () => {
    useProfile(ANTHROPIC)
    const note = text('note')
    const out = stripCallerFieldFromAssistantMessage(assistant([note, callerBlock]))
    const content = contentOf(out) as Block[]
    expect(content[0]).toBe(note)
    expect(content[1]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } })
  })

  test('under Gemini the extra_content and the block signature survive the rebuild', () => {
    useProfile(GEMINI)
    expect(getAPIProvider()).toBe('gemini')
    const out = stripCallerFieldFromAssistantMessage(assistant([callerBlock]))
    expect(contentOf(out)).toEqual([
      {
        type: 'tool_use',
        id: 't1',
        name: 'Read',
        input: { file_path: '/x' },
        extra_content: { google: { thought_signature: 'sig' } },
        signature: 'block-sig',
      },
    ])
  })

  test('a message whose callers are all null or absent comes back as the same object', () => {
    const message = assistant([{ ...toolUse('t1'), caller: null }, toolUse('t2')])
    expect(stripCallerFieldFromAssistantMessage(message)).toBe(message)
  })
})

// ---------- mergeUserMessagesAndToolResults ----------

describe('mergeUserMessagesAndToolResults folds text into a string tool_result', () => {
  test('text after a string tool_result is smooshed into it, trimmed and joined by blank lines', () => {
    const merged = mergeUserMessagesAndToolResults(
      user([toolResult('t1', '  out  ')]),
      user([text(' note one '), text('note two')]),
    )
    expect(contentOf(merged)).toEqual([toolResult('t1', 'out\n\nnote one\n\nnote two')])
  })

  test('a non-text sibling stays a sibling, after the tool_result', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    const merged = mergeUserMessagesAndToolResults(user([toolResult('t1', 'out')]), user([image]))
    expect(contentOf(merged)).toEqual([toolResult('t1', 'out'), image])
  })
})

// ---------- normalizeContentFromAPI ----------

describe('normalizeContentFromAPI', () => {
  const tools = [{ name: 'Fake' }] as never as Tools
  type Content = Parameters<typeof normalizeContentFromAPI>[0]
  const blocks = (list: Block[]) => list as never as Content

  test('no content gives an empty array', () => {
    expect(normalizeContentFromAPI(null as never, tools)).toEqual([])
  })

  test('a string tool_use input is parsed; empty or invalid JSON becomes an empty object', () => {
    const out = normalizeContentFromAPI(
      blocks([
        { type: 'tool_use', id: 'a', name: 'Fake', input: '{"x":1,"nested":"{\\"y\\":2}"}' },
        { type: 'tool_use', id: 'b', name: 'Fake', input: '' },
        { type: 'tool_use', id: 'c', name: 'Other', input: '{not json' },
      ]),
      tools,
    )
    // Only the top level is parsed; a nested stringified JSON stays a string.
    expect(out).toEqual(
      blocks([
        { type: 'tool_use', id: 'a', name: 'Fake', input: { x: 1, nested: '{"y":2}' } },
        { type: 'tool_use', id: 'b', name: 'Fake', input: {} },
        { type: 'tool_use', id: 'c', name: 'Other', input: {} },
      ]),
    )
  })

  test('an object tool_use input is kept, in a new block', () => {
    const block = { type: 'tool_use', id: 'a', name: 'Fake', input: { x: 1 } }
    const out = normalizeContentFromAPI(blocks([block]), tools)
    expect(out[0]).not.toBe(block as never)
    expect(out).toEqual(blocks([block]))
  })

  test('a tool_use input that is neither string nor object throws', () => {
    expect(() =>
      normalizeContentFromAPI(blocks([{ type: 'tool_use', id: 'a', name: 'Fake', input: 42 }]), tools),
    ).toThrow('Tool use input must be a string or object')
  })

  test('a string server_tool_use input is parsed, an invalid one becomes {}; an object one is the same block', () => {
    const objectInput = { type: 'server_tool_use', id: 's3', name: 'web_search', input: { q: 'z' } }
    const out = normalizeContentFromAPI(
      blocks([
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: '{"q":"x"}' },
        { type: 'server_tool_use', id: 's2', name: 'web_search', input: 'nope' },
        objectInput,
      ]),
      tools,
    )
    expect(out.slice(0, 2)).toEqual(
      blocks([
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { q: 'x' } },
        { type: 'server_tool_use', id: 's2', name: 'web_search', input: {} },
      ]),
    )
    expect(out[2]).toBe(objectInput as never)
  })

  test('text, beta and unknown blocks come back as the same objects, empty text included', () => {
    const list = [
      text('\n\n'),
      { type: 'mcp_tool_use', id: 'm', name: 'x', server_name: 's', input: {} },
      { type: 'container_upload', file_id: 'f' },
      { type: 'thinking', thinking: 't', signature: 's' },
    ]
    const out = normalizeContentFromAPI(blocks(list), tools)
    list.forEach((block, i) => expect(out[i]).toBe(block as never))
  })
})

// ---------- filterUnresolvedToolUses ----------

describe('filterUnresolvedToolUses', () => {
  test('drops an assistant whose every tool_use lacks a result, keeps a partly resolved one', () => {
    const resolved = assistant([toolUse('a')])
    const result = user([toolResult('a')])
    const unresolved = assistant([toolUse('b'), toolUse('b2')])
    const partly = assistant([text('both'), toolUse('c'), toolUse('d')])
    const resultC = user([toolResult('c')])
    const plainText = assistant([text('done')])
    const prompt = user('string prompt')
    const attachment = hook('PreToolUse', 'b')
    const out = filterUnresolvedToolUses([prompt, resolved, result, unresolved, attachment, partly, resultC, plainText])
    expect(out).toEqual([prompt, resolved, result, attachment, partly, resultC, plainText])
  })

  test('with every tool_use resolved the same array comes back', () => {
    const messages = [assistant([toolUse('a')]), user([toolResult('a')])]
    expect(filterUnresolvedToolUses(messages)).toBe(messages)
  })
})

// ---------- ensureToolResultPairing ----------

describe('ensureToolResultPairing repairs', () => {
  test('an orphaned tool_result in the next message is removed, the rest kept', () => {
    const call = assistant([toolUse('a')])
    const out = ensureToolResultPairing([call, user([toolResult('a'), toolResult('zz'), text('tail')])])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(call)
    expect(contentOf(out[1]!)).toEqual([toolResult('a'), text('tail')])
  })

  test('a duplicated tool_result is kept once', () => {
    const out = ensureToolResultPairing([
      assistant([toolUse('a')]),
      user([toolResult('a', 'first'), toolResult('a', 'second')]),
    ])
    expect(contentOf(out[1]!)).toEqual([toolResult('a', 'first')])
  })

  test('a user message emptied by the strip becomes a meta no-content message', () => {
    const out = ensureToolResultPairing([
      user('q'),
      assistant([text('no calls here')]),
      user([toolResult('zz')]),
      assistant([text('next')]),
    ])
    expect(out.map(m => m.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(contentOf(out[2]!)).toBe(NO_CONTENT_MESSAGE)
    expect((out[2] as UserMessage).isMeta).toBe(true)
  })

  test('a missing result before a string user message is prepended to it as a synthetic error', () => {
    const out = ensureToolResultPairing([assistant([toolUse('a')]), user('typed instead')])
    expect(contentOf(out[1]!)).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error: true },
      text('typed instead'),
    ])
  })

  test('a final assistant with an unanswered call gets a synthetic meta user message', () => {
    const out = ensureToolResultPairing([user('q'), assistant([toolUse('a'), toolUse('b')])])
    expect(out).toHaveLength(3)
    expect((out[2] as UserMessage).isMeta).toBe(true)
    expect(contentOf(out[2]!)).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error: true },
      { type: 'tool_result', tool_use_id: 'b', content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error: true },
    ])
  })

  test('a tool_use id already seen in an earlier assistant is removed from the later one', () => {
    const out = ensureToolResultPairing([
      assistant([toolUse('a')]),
      user([toolResult('a')]),
      assistant([toolUse('a'), text('again')]),
    ])
    expect(out).toHaveLength(3)
    expect(contentOf(out[2]!)).toEqual([text('again')])
  })

  test('a server_tool_use without its result is removed; an emptied assistant gets a placeholder', () => {
    const answered = { type: 'server_tool_use', id: 'srv_ok', name: 'web_search', input: {} }
    const answer = { type: 'web_search_tool_result', tool_use_id: 'srv_ok', content: [] }
    const out = ensureToolResultPairing([
      user('q'),
      assistant([answered, answer, { type: 'mcp_tool_use', id: 'mcp_1', name: 'x', server_name: 's', input: {} }]),
      user('more'),
      assistant([{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }]),
    ])
    expect(contentOf(out[1]!)).toEqual([answered, answer])
    expect(contentOf(out[3]!)).toEqual([{ type: 'text', text: '[Tool use interrupted]', citations: [] }])
  })

  test('strict mode throws with the message structure instead of repairing', () => {
    setStrictToolResultPairing(true)
    const call = assistant([toolUse('a'), { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }], 'msg_1')
    expect(() =>
      ensureToolResultPairing([call, user([toolResult('zz'), toolResult('a')])]),
    ).toThrow(
      'Message structure: [0] assistant(id=msg_1, tool_uses=[a], server_tool_uses=[srv_1]); [1] user(tool_results=[zz,a]). See inc-4977.',
    )
  })

  test('a paired history comes back unchanged, element by element', () => {
    const messages = [user('q'), assistant([toolUse('a')]), user([toolResult('a')])]
    const out = ensureToolResultPairing(messages)
    expect(out).toHaveLength(3)
    out.forEach((m, i) => expect(m).toBe(messages[i]!))
  })
})

// ---------- stripAdvisorBlocks ----------

describe('stripAdvisorBlocks', () => {
  const advisorUse = { type: 'server_tool_use', id: 'adv', name: 'advisor', input: {} }
  const advisorResult = { type: 'advisor_tool_result', tool_use_id: 'adv', content: {} }

  test('removes both advisor block types and keeps real content without a placeholder', () => {
    const out = stripAdvisorBlocks([assistant([advisorUse, advisorResult, text('Hi')])])
    expect(contentOf(out[0]!)).toEqual([text('Hi')])
  })

  test('a turn left with only thinking or blank text gets the advisor placeholder appended', () => {
    const thinking = { type: 'thinking', thinking: 't', signature: 's' }
    const out = stripAdvisorBlocks([
      assistant([thinking, advisorUse]),
      assistant([text('  '), advisorResult]),
      assistant([advisorUse]),
    ])
    const placeholder = { type: 'text', text: '[Advisor response]', citations: [] }
    expect(contentOf(out[0]!)).toEqual([thinking, placeholder])
    expect(contentOf(out[1]!)).toEqual([text('  '), placeholder])
    expect(contentOf(out[2]!)).toEqual([placeholder])
  })

  test('a non-advisor server_tool_use and user messages are left alone', () => {
    const search = assistant([{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }])
    const prompt = user('q')
    const messages = [prompt, search]
    expect(stripAdvisorBlocks(messages)).toBe(messages)
  })
})
