// Characterization of the pure half of session storage (unit
// `sessions/storagePure`): which entries count as transcript messages, what a
// transcript keeps when it is written, and the title the resume picker derives
// from a session. Every name is reached through the session-storage barrel, the
// way the rest of the app imports it, and the messages come from the real
// factories so their shapes are the ones the app writes.
//
// Siblings: storagePure.paths / .jsonl / .portable .characterization.test.ts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Attachment } from 'src/agent/attachments/attachments.js'
import { createAttachmentMessage } from 'src/agent/attachments/shared.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
} from 'src/agent/messages/factories.js'
import {
  cleanMessagesForLogging,
  EPHEMERAL_PROGRESS_TYPES,
  extractFirstPrompt,
  extractFirstPromptFromChunk,
  getFirstMeaningfulUserMessageTextContent,
  getUserType,
  isChainParticipant,
  isEphemeralToolProgress,
  isLegacyProgressEntry,
  isLoggableMessage,
  isTranscriptMessage,
  removeExtraFields,
  SKIP_FIRST_PROMPT_PATTERN,
} from 'src/sessions/sessionStorage.js'
import type { Entry, TranscriptMessage } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

/** On-disk entry kinds that carry session metadata instead of a message. */
const METADATA_KINDS = [
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'task-summary',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'mode',
  'worktree-state',
  'cost-state',
  'file-history-snapshot',
  'attribution-snapshot',
  'queue-operation',
  'speculation-accept',
  'marble-origami-commit',
  'marble-origami-snapshot',
]

const entryOfKind = (type: string): Entry => ({ type }) as unknown as Entry
const attachmentOf = (type: string) =>
  createAttachmentMessage({ type } as unknown as Attachment)
const typed = (content: string) => createUserMessage({ content })
const progressTick = () =>
  createProgressMessage({
    toolUseID: 'toolu_tick',
    parentToolUseID: 'toolu_parent',
    data: { type: 'bash_progress' } as never,
  })
const firstText = (messages: unknown[]) =>
  getFirstMeaningfulUserMessageTextContent(messages as Message[])
const titleOf = (messages: unknown[]) =>
  extractFirstPrompt(messages as TranscriptMessage[])
/** One JSONL line per entry, the way a transcript stores them. */
const jsonl = (...entries: object[]) =>
  entries.map(entry => JSON.stringify(entry)).join('\n')
const userLine = (content: unknown, extra: object = {}) => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content },
  ...extra,
})

describe('transcript entry guards', () => {
  test('user, assistant, system and attachment messages are transcript messages', () => {
    const made = [
      typed('hello'),
      createAssistantMessage({ content: 'hi there' }),
      createSystemMessage('heads up', 'info'),
      attachmentOf('nested_memory'),
    ] as unknown as Entry[]
    expect(made.filter(entry => !isTranscriptMessage(entry))).toEqual([])
  })

  test('progress, metadata and unknown kinds are not', () => {
    const others = ['progress', ...METADATA_KINDS, 'a-kind-from-the-future']
    expect(others.filter(kind => isTranscriptMessage(entryOfKind(kind)))).toEqual(
      [],
    )
  })

  test('every kind except progress takes part in the parentUuid chain', () => {
    const kinds = ['user', 'assistant', 'system', 'attachment', 'progress', ...METADATA_KINDS]
    const outside = kinds.filter(
      kind => !isChainParticipant({ type: kind } as Pick<Message, 'type'>),
    )
    expect(outside).toEqual(['progress'])
  })

  const legacyCases: Array<[string, unknown, boolean]> = [
    ['a progress line from an old transcript', { type: 'progress', uuid: 'u-1', parentUuid: null, data: {} }, true],
    ['a progress line without parentUuid', { type: 'progress', uuid: 'u-2' }, true],
    ['a progress message built today', progressTick(), true],
    ['a progress line with a numeric uuid', { type: 'progress', uuid: 12 }, false],
    ['a progress line with no uuid', { type: 'progress', parentUuid: null }, false],
    ['a user line', { type: 'user', uuid: 'u-3' }, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['the bare string progress', 'progress', false],
    ['an array', ['progress'], false],
  ]
  test.each(legacyCases)('isLegacyProgressEntry: %s', (_label, value, expected) => {
    expect(isLegacyProgressEntry(value)).toBe(expected)
  })
})

describe('ephemeral tool progress', () => {
  const TICK_KINDS = [
    'bash_progress',
    'build_progress',
    'check_progress',
    'mcp_progress',
    'powershell_progress',
    'test_progress',
  ]

  test('the set holds exactly the tool ticks that render only their last value', () => {
    expect(EPHEMERAL_PROGRESS_TYPES).toBeInstanceOf(Set)
    expect([...EPHEMERAL_PROGRESS_TYPES].sort()).toEqual(TICK_KINDS)
  })

  test('isEphemeralToolProgress accepts those strings and nothing else', () => {
    expect(TICK_KINDS.filter(kind => isEphemeralToolProgress(kind))).toEqual(TICK_KINDS)
    const rejected: unknown[] = [
      'agent_progress',
      'hook_progress',
      'sleep_progress',
      'BASH_PROGRESS',
      'bash_progress ',
      '',
      null,
      undefined,
      7,
      {},
      ['bash_progress'],
    ]
    expect(rejected.filter(value => isEphemeralToolProgress(value))).toEqual([])
  })
})

describe('what a written transcript keeps', () => {
  test('the user type is always external', () => {
    expect(getUserType()).toBe('external')
  })

  test('removeExtraFields drops parentUuid and isSidechain and nothing else', () => {
    const stored = {
      parentUuid: 'parent-1',
      logicalParentUuid: 'logical-1',
      isSidechain: true,
      ...typed('keep me'),
      cwd: '/work/acme',
      sessionId: 'session-1',
    }
    const [serialized] = removeExtraFields([stored] as unknown as TranscriptMessage[])
    const expected = Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== 'parentUuid' && key !== 'isSidechain'),
    )
    expect(serialized).toEqual(expected as never)
    expect(Object.keys(serialized!)).not.toContain('parentUuid')
    expect(Object.keys(serialized!)).not.toContain('isSidechain')
    // The input objects are left as they were.
    expect(stored.parentUuid).toBe('parent-1')
    expect(stored.isSidechain).toBe(true)
  })

  test('removeExtraFields keeps the order and the length', () => {
    const batch = ['one', 'two', 'three'].map(text => ({
      parentUuid: null,
      isSidechain: false,
      ...typed(text),
    }))
    const out = removeExtraFields(batch as unknown as TranscriptMessage[])
    expect(out.map(m => (m as { uuid: string }).uuid)).toEqual(batch.map(m => m.uuid))
    expect(removeExtraFields([])).toEqual([])
  })

  test('progress is never written; user, assistant and system messages always are', () => {
    const verdicts = [
      progressTick(),
      typed('a prompt'),
      createAssistantMessage({ content: 'an answer' }),
      createSystemMessage('a notice', 'warning'),
    ].map(m => isLoggableMessage(m as Message))
    expect(verdicts).toEqual([false, true, true, true])
  })

  test('an attachment is written only when the persistence policy keeps its type', () => {
    const kept = ['nested_memory', 'deferred_tools_delta', 'queued_command', 'hook_additional_context']
    const dropped = ['memory_index', 'already_read_file', 'dynamic_skill', 'a_type_this_build_does_not_know']
    expect(kept.filter(type => !isLoggableMessage(attachmentOf(type)))).toEqual([])
    expect(dropped.filter(type => isLoggableMessage(attachmentOf(type)))).toEqual([])
  })

  test('cleanMessagesForLogging keeps the loggable messages in their order', () => {
    const prompt = typed('first')
    const answer = createAssistantMessage({ content: 'second' })
    const toolReply = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] })
    const keptAttachment = attachmentOf('nested_memory')
    const notice = createSystemMessage('third', 'info')
    const input = [prompt, progressTick(), answer, toolReply, attachmentOf('memory_index'), keptAttachment, notice]
    const out = cleanMessagesForLogging(input as Message[])
    expect(out.map(m => m.uuid)).toEqual([prompt.uuid, answer.uuid, toolReply.uuid, keptAttachment.uuid, notice.uuid])
    expect(out[2]).toEqual(toolReply)
    expect(cleanMessagesForLogging([])).toEqual([])
  })

  test('a user or assistant message whose content list is empty is dropped', () => {
    const emptyAnswer = createAssistantMessage({ content: [] })
    const emptyPrompt = createUserMessage({ content: [] })
    const blankString = { ...typed('placeholder'), message: { role: 'user' as const, content: '' } }
    const out = cleanMessagesForLogging([emptyAnswer, emptyPrompt, blankString] as Message[])
    // Only list content is checked for emptiness; an empty string survives.
    expect(out.map(m => m.uuid)).toEqual([blankString.uuid])
  })

  test('a virtual message is written as a real one and the original keeps its flag', () => {
    const virtuals = [
      createAssistantMessage({ content: 'from a tool', isVirtual: true }),
      createUserMessage({ content: [{ type: 'text', text: 'list content' }], isVirtual: true }),
      createUserMessage({ content: 'string content', isVirtual: true }),
      { ...createSystemMessage('system note', 'info'), isVirtual: true },
      { ...attachmentOf('nested_memory'), isVirtual: true },
    ] as unknown as Array<Message & { isVirtual?: boolean }>
    const out = cleanMessagesForLogging(virtuals)
    expect(out).toHaveLength(virtuals.length)
    out.forEach((written, index) => {
      const original = virtuals[index]!
      expect(Object.keys(written)).not.toContain('isVirtual')
      const withoutFlag = Object.fromEntries(
        Object.entries(original).filter(([key]) => key !== 'isVirtual'),
      )
      expect(written).toEqual(withoutFlag as never)
      expect(original.isVirtual).toBe(true)
    })
  })

  test('a virtual message with an empty content list is still dropped', () => {
    const hollow = createAssistantMessage({ content: [], isVirtual: true })
    expect(cleanMessagesForLogging([hollow])).toEqual([])
  })

  test('the second argument does not change the result', () => {
    const batch = [typed('alpha'), progressTick(), createAssistantMessage({ content: 'beta' })] as Message[]
    const unrelated = [typed('gamma')] as Message[]
    expect(cleanMessagesForLogging(batch, unrelated)).toEqual(cleanMessagesForLogging(batch))
  })
})

describe('SKIP_FIRST_PROMPT_PATTERN', () => {
  const skipped = [
    '<ide_selection>lines 1-4</ide_selection> explain this',
    '   <local-command-stdout>ok</local-command-stdout>',
    '\n<task-notification>\n<task-id>7</task-id>',
    '<tick>',
    '<my-hook-output data="1">text',
    '<x\nwrapped',
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ]
  const prompts = [
    'Explain <b>this</b> markup',
    '<Div>capitalised tags are prompts</Div>',
    '<3 is a heart',
    '<br/> a self-closing tag',
    '<>',
    ' [Request interrupted by user]',
    '[Request interrupted]',
    'Request interrupted by user',
    '',
  ]

  test('matches text that opens with a lowercase tag or an interruption marker', () => {
    expect(skipped.filter(text => !SKIP_FIRST_PROMPT_PATTERN.test(text))).toEqual([])
  })

  test('does not match anything else', () => {
    expect(prompts.filter(text => SKIP_FIRST_PROMPT_PATTERN.test(text))).toEqual([])
  })

  test('is a RegExp that keeps no state between calls', () => {
    expect(SKIP_FIRST_PROMPT_PATTERN).toBeInstanceOf(RegExp)
    expect([0, 1, 2].map(() => SKIP_FIRST_PROMPT_PATTERN.test('<tick>'))).toEqual([true, true, true])
  })
})

describe('getFirstMeaningfulUserMessageTextContent', () => {
  test('finds nothing in an empty list or one without user text', () => {
    expect(firstText([])).toBeUndefined()
    expect(
      firstText([createAssistantMessage({ content: 'only me' }), createSystemMessage('sys', 'info')]),
    ).toBeUndefined()
  })

  test('returns the first real prompt verbatim', () => {
    const raw = '  Fix the flaky test\nin src/queue.test.ts  '
    const conversation = [createAssistantMessage({ content: 'welcome' }), typed(raw), typed('later')]
    expect(firstText(conversation)).toBe(raw)
  })

  test('skips meta messages, compact summaries and messages without text', () => {
    const conversation = [
      createSyntheticUserCaveatMessage(),
      createUserMessage({ content: 'Summary of the earlier part', isCompactSummary: true }),
      createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] }),
      createUserMessage({ content: [{ type: 'text', text: '' }] }),
      { ...typed('placeholder'), message: { role: 'user', content: '' } },
      { ...typed('placeholder'), message: undefined },
      typed('the prompt'),
    ]
    expect(firstText(conversation)).toBe('the prompt')
  })

  test('looks past IDE context blocks to the prompt in the same message', () => {
    const withContext = createUserMessage({
      content: [
        { type: 'text', text: '<ide_selection>The user selected lines 3-9</ide_selection>' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'Why is this slow?' },
      ],
    })
    expect(firstText([withContext])).toBe('Why is this slow?')
  })

  test('built-in slash commands never become the prompt', () => {
    const conversation = [
      typed(formatCommandInputTags('model', 'opus')),
      typed(formatCommandInputTags('clear', '')),
      typed('what changed?'),
    ]
    expect(firstText(conversation)).toBe('what changed?')
  })

  test('a custom command counts only with arguments, and reads as its command line', () => {
    const conversation = [
      typed(formatCommandInputTags('deploy-docs', '   ')),
      typed(formatCommandInputTags('deploy-docs', '  staging --force ')),
    ]
    expect(firstText(conversation)).toBe('/deploy-docs staging --force')
  })

  test('bash-mode input reads as a bang command, even though it opens with a tag', () => {
    expect(firstText([typed('<bash-input>git status</bash-input>')])).toBe('! git status')
    expect(firstText([typed('<bash-input></bash-input>'), typed('next')])).toBe('next')
  })

  test('tagged output and interruption markers are skipped', () => {
    const conversation = [
      typed('<local-command-stdout>Set model to Opus</local-command-stdout>'),
      createUserInterruptionMessage({ toolUse: false }),
      createUserInterruptionMessage({ toolUse: true }),
      typed('<task-notification><task-id>b1</task-id></task-notification>'),
      typed('resume the refactor'),
    ]
    expect(firstText(conversation)).toBe('resume the refactor')
  })
})

describe('extractFirstPrompt', () => {
  test('says "No prompt" when there is none', () => {
    expect(titleOf([])).toBe('No prompt')
    expect(titleOf([typed(formatCommandInputTags('clear', ''))])).toBe('No prompt')
  })

  test('flattens newlines and trims', () => {
    expect(titleOf([typed('\n  Why does\nthe build\nfail?  \n')])).toBe('Why does the build fail?')
  })

  test('keeps 200 characters and marks a cut with an ellipsis', () => {
    const exact = 'x'.repeat(200)
    expect(titleOf([typed(exact)])).toBe(exact)
    expect(titleOf([typed('w'.repeat(201))])).toBe(`${'w'.repeat(200)}\u2026`)
    // The cut is trimmed before the ellipsis goes on.
    expect(titleOf([typed(`${'y'.repeat(199)} ${'z'.repeat(40)}`)])).toBe(`${'y'.repeat(199)}\u2026`)
  })

  test('uses the same rules for commands and bash input', () => {
    expect(titleOf([typed(formatCommandInputTags('deploy-docs', 'staging'))])).toBe('/deploy-docs staging')
    expect(titleOf([typed('<bash-input>npm test</bash-input>')])).toBe('! npm test')
  })
})

describe('extractFirstPromptFromChunk', () => {
  const head = readFileSync(join(FIXTURES, 'session-head.jsonl'), 'utf8')

  test('reads the title from the head of a real session file', () => {
    expect(extractFirstPromptFromChunk(head)).toBe('Why does this loop never end when the queue is empty?')
  })

  test('agrees with the message-based reading of the same head', () => {
    const parsed = head.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
    expect(firstText(parsed)).toBe('Why does this loop\nnever end when the queue is empty?')
    expect(titleOf(parsed)).toBe('Why does this loop never end when the queue is empty?')
  })

  test('an empty chunk, or one without user lines, gives an empty string', () => {
    expect(extractFirstPromptFromChunk('')).toBe('')
    const noUser = jsonl(
      { type: 'summary', summary: 'x', leafUuid: 'l-1' },
      { parentUuid: null, isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    )
    expect(extractFirstPromptFromChunk(noUser)).toBe('')
  })

  test('drops lines by their raw text before parsing them', () => {
    const chunk = jsonl(
      userLine([{ type: 'tool_result', tool_use_id: 't', content: 'x' }, { type: 'text', text: 'beside a tool result' }]),
      userLine('marked meta', { isMeta: true }),
      { type: 'queue-operation', operation: 'enqueue', content: { type: 'user', text: 'queued' } },
      userLine('the prompt'),
    )
    expect(extractFirstPromptFromChunk(chunk)).toBe('the prompt')
  })

  test('accepts JSON written with a space after the colon', () => {
    const spaced = [
      '{"type": "user", "isMeta": true, "message": {"content": "meta, spaced"}}',
      '{"type": "user", "message": {"role": "user", "content": "spaced json"}}',
    ].join('\n')
    expect(extractFirstPromptFromChunk(spaced)).toBe('spaced json')
  })

  test('skips lines that do not parse, such as a line cut at the end of the chunk', () => {
    const chunk = [
      '{"parentUuid":null,"type":"user","message":{"role":"user","content":"cut in the mid',
      JSON.stringify(userLine('after the cut')),
    ].join('\n')
    expect(extractFirstPromptFromChunk(chunk)).toBe('after the cut')
    expect(extractFirstPromptFromChunk(JSON.stringify({ type: 'user' }))).toBe('')
  })

  test('reads string content and the string text blocks of list content', () => {
    const chunk = jsonl(
      userLine([{ type: 'text', text: 42 }, { type: 'image' }, { type: 'text', text: '' }, { type: 'text', text: 'from a block' }]),
    )
    expect(extractFirstPromptFromChunk(chunk)).toBe('from a block')
  })

  test('falls back to the first command name when only commands were typed', () => {
    const onlyCommands = jsonl(
      userLine(formatCommandInputTags('model', 'opus')),
      userLine(formatCommandInputTags('clear', '')),
      userLine(formatCommandInputTags('deploy-docs', ' ')),
    )
    expect(extractFirstPromptFromChunk(onlyCommands)).toBe('/model')
    const argless = jsonl(userLine(formatCommandInputTags('deploy-docs', '')))
    expect(extractFirstPromptFromChunk(argless)).toBe('/deploy-docs')
  })

  test('a later real prompt wins over the command fallback', () => {
    const chunk = jsonl(userLine(formatCommandInputTags('model', 'opus')), userLine('now review the diff'))
    expect(extractFirstPromptFromChunk(chunk)).toBe('now review the diff')
  })

  test('a custom command with arguments reads as its command line', () => {
    const chunk = jsonl(userLine(formatCommandInputTags('deploy-docs', '  staging  ')))
    expect(extractFirstPromptFromChunk(chunk)).toBe('/deploy-docs staging')
  })

  test('bash input is flattened and prefixed with a bang', () => {
    const chunk = jsonl(userLine('<bash-input>npm run\nlint</bash-input>'))
    expect(extractFirstPromptFromChunk(chunk)).toBe('! npm run lint')
  })

  test('tagged output is skipped, and markers are recognised after trimming', () => {
    const chunk = jsonl(
      userLine('<local-command-stdout>done</local-command-stdout>'),
      userLine('   [Request interrupted by user]'),
      userLine('\n\nThe real   question\n'),
    )
    expect(extractFirstPromptFromChunk(chunk)).toBe('The real   question')
  })

  test('a long prompt is cut at 200 characters with an ellipsis', () => {
    const chunk = jsonl(userLine('q'.repeat(260)))
    expect(extractFirstPromptFromChunk(chunk)).toBe(`${'q'.repeat(200)}\u2026`)
    const exact = jsonl(userLine('r'.repeat(200)))
    expect(extractFirstPromptFromChunk(exact)).toBe('r'.repeat(200))
  })

  test('CRLF line endings are read', () => {
    const chunk = [JSON.stringify(userLine('<tick>')), JSON.stringify(userLine('windows line'))].join('\r\n')
    expect(extractFirstPromptFromChunk(`${chunk}\r\n`)).toBe('windows line')
  })
})
