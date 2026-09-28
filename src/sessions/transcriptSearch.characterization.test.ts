/**
 * Characterization suite for src/sessions/transcriptSearch.ts, written before
 * its clean-base rewrite: the new module has to pass it unchanged.
 *
 * The transcript's `/` search looks for the query inside the text these
 * functions extract from each message, so what they return decides which
 * messages count as hits. Messages are built with the same factories the agent
 * loop uses. docs/tech/rewrite/sessions/historySearch.md is the spec.
 */
import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { createAttachmentMessage } from 'src/agent/attachments/shared.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from 'src/agent/messages/messages.js'
import { renderableSearchText, toolResultSearchText, toolUseSearchText } from 'src/sessions/transcriptSearch.js'
import type { RenderableMessage } from 'src/shared/types/message.js'

// --- building messages ---------------------------------------------------------

/** The factories return the loop's own message types; the transcript renders them as-is. */
const asShown = (message: object): RenderableMessage => message as RenderableMessage

function typed(text: string): RenderableMessage {
  return asShown(createUserMessage({ content: text }))
}

function userBlocks(...blocks: ContentBlockParam[]): RenderableMessage {
  return asShown(createUserMessage({ content: blocks }))
}

/** A tool's answer: the model-facing block, plus the tool's own output that the screen shows. */
function toolAnswer(modelFacing: string, toolOutput: unknown): RenderableMessage {
  return asShown(
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: modelFacing }],
      toolUseResult: toolOutput,
    }),
  )
}

function replied(...blocks: object[]): RenderableMessage {
  return asShown(createAssistantMessage({ content: blocks as BetaContentBlock[] }))
}

function queued(prompt: string | ContentBlockParam[], extra: { commandMode?: string; isMeta?: boolean } = {}): RenderableMessage {
  return asShown(createAttachmentMessage({ type: 'queued_command', prompt, ...extra }))
}

const REMINDER = (body: string) => `<system-reminder>${body}</system-reminder>`

// --- renderableSearchText -------------------------------------------------------

describe('renderableSearchText: what a user message contributes', () => {
  test('a typed prompt is searchable, in lower case', () => {
    expect(renderableSearchText(typed('Rename the FooBar class'))).toBe('rename the foobar class')
  })

  test('a prompt made of blocks: every text block, one per line, and nothing from images', () => {
    const message = userBlocks(
      { type: 'text', text: 'First Part' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'Second Part' },
    )
    expect(renderableSearchText(message)).toBe('first part\nsecond part')
  })

  test('the interruption notices render as a badge, so their raw text is not searchable', () => {
    expect(renderableSearchText(createUserInterruptionMessage({}) as RenderableMessage)).toBe('')
    expect(renderableSearchText(createUserInterruptionMessage({ toolUse: true }) as RenderableMessage)).toBe('')
    expect(renderableSearchText(typed(INTERRUPT_MESSAGE))).toBe('')
    expect(renderableSearchText(typed(INTERRUPT_MESSAGE_FOR_TOOL_USE))).toBe('')
  })

  test('only a block that is exactly a notice is dropped; the rest of the message stays', () => {
    const message = userBlocks({ type: 'text', text: INTERRUPT_MESSAGE }, { type: 'text', text: 'Carry On' })
    expect(renderableSearchText(message)).toBe('carry on')
    const longer = `${INTERRUPT_MESSAGE} and then more`
    expect(renderableSearchText(typed(longer))).toBe(longer.toLowerCase())
  })

  test("a tool answer is searched through the tool's own output, never the text the model got", () => {
    const answer = toolAnswer('MODEL ONLY: background id bg_42 and a safety reminder', {
      stdout: 'Compiled 12 Files',
      stderr: 'Warning: Deprecated flag',
    })
    // Exact, so nothing of the model-facing text (the bg_42 id) can be in it.
    expect(renderableSearchText(answer)).toBe('compiled 12 files\nwarning: deprecated flag')
  })

  test('a tool answer whose output has no known field contributes nothing', () => {
    const unknownShape = { rawOutputPath: '/tmp/out.txt', durationMs: 5 }
    expect(renderableSearchText(toolAnswer('the model saw this', unknownShape))).toBe('')
  })

  test('text next to a tool answer is kept on its own line', () => {
    const message = asShown(
      createUserMessage({
        content: [
          { type: 'text', text: 'Before' },
          { type: 'tool_result', tool_use_id: 'toolu_02', content: 'hidden' },
        ],
        toolUseResult: { output: 'Shown Output' },
      }),
    )
    expect(renderableSearchText(message)).toBe('before\nshown output')
  })
})

describe('renderableSearchText: what an assistant message contributes', () => {
  test('its text and the visible arguments of its tool calls, one per line; thinking stays out', () => {
    const message = replied(
      { type: 'thinking', thinking: 'Private Chain Of Thought', signature: 'sig' },
      { type: 'text', text: 'Running The Suite' },
      { type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'bun test Src/', description: 'Run Tests' } },
      { type: 'redacted_thinking', data: 'opaque' },
    )
    expect(renderableSearchText(message)).toBe('running the suite\nbun test src/\nrun tests')
  })

  test('a tool call with nothing recognisable in its input adds an empty line', () => {
    const message = replied(
      { type: 'text', text: 'one' },
      { type: 'tool_use', id: 'toolu_04', name: 'Custom', input: { old_string: 'a', new_string: 'b' } },
      { type: 'text', text: 'two' },
    )
    expect(renderableSearchText(message)).toBe('one\n\ntwo')
  })
})

describe('renderableSearchText: prompts queued while the agent was busy', () => {
  test('a queued prompt is searchable, as text or as blocks', () => {
    expect(renderableSearchText(queued('Also Check The Logs'))).toBe('also check the logs')
    const blocks = queued([
      { type: 'text', text: 'Look At' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'This Screenshot' },
    ])
    expect(renderableSearchText(blocks)).toBe('look at\nthis screenshot')
  })

  test('task notifications and system-injected (meta) prompts are not', () => {
    expect(renderableSearchText(queued('agent finished', { commandMode: 'task-notification' }))).toBe('')
    expect(renderableSearchText(queued('injected by the harness', { isMeta: true }))).toBe('')
    expect(renderableSearchText(queued('typed while busy', { commandMode: 'prompt' }))).toBe('typed while busy')
  })

  test('other attachments contribute nothing', () => {
    const style = asShown(createAttachmentMessage({ type: 'output_style', style: 'Explanatory' }))
    expect(renderableSearchText(style)).toBe('')
  })
})

describe('renderableSearchText: messages with no searchable text', () => {
  test('system lines, progress, and the grouped rows the transcript builds', () => {
    const system = asShown(createSystemMessage('Conversation Compacted', 'info'))
    const progress = asShown(
      createProgressMessage({ toolUseID: 'toolu_05', parentToolUseID: 'toolu_05', data: { type: 'bash_progress' } as never }),
    )
    const grouped = asShown({ type: 'grouped_tool_use', toolName: 'Read', messages: [], results: [], uuid: 'g1', timestamp: '', messageId: 'm1' })
    const collapsed = asShown({ type: 'collapsed_read_search', messages: [], searchArgs: ['needle'], readFilePaths: ['/a.ts'] })
    for (const message of [system, progress, grouped, collapsed]) {
      expect(renderableSearchText(message)).toBe('')
    }
  })
})

describe('renderableSearchText: system reminders are context, not transcript', () => {
  test('every closed reminder is cut out, wherever it sits and however many lines it spans', () => {
    const text = `Keep ${REMINDER('Memory Note')}this and ${REMINDER('line one\nline two')}that`
    expect(renderableSearchText(typed(text))).toBe('keep this and that')
  })

  test('reminders are cut from tool output and assistant text too', () => {
    expect(renderableSearchText(toolAnswer('x', { stdout: `ok ${REMINDER('secret')}done` }))).toBe('ok done')
    expect(renderableSearchText(replied({ type: 'text', text: `Sure.${REMINDER('policy')}` }))).toBe('sure.')
  })

  test('a reminder that never closes is left in, from its opening tag on', () => {
    const text = `Visible ${REMINDER('gone')} tail <system-reminder>Never Closed`
    expect(renderableSearchText(typed(text))).toBe('visible  tail <system-reminder>never closed')
  })
})

describe('renderableSearchText: one extraction per message', () => {
  test('the text is worked out once per message object and reused, even if the object later changes', () => {
    const message = createUserMessage({ content: 'Original Words' })
    const shown = asShown(message)
    expect(renderableSearchText(shown)).toBe('original words')
    message.message.content = 'Replaced Words'
    expect(renderableSearchText(shown)).toBe('original words')
    expect(renderableSearchText(typed('Replaced Words'))).toBe('replaced words')
  })
})

// --- toolUseSearchText -----------------------------------------------------------

describe('toolUseSearchText: the arguments a tool call shows', () => {
  test('known string fields, in a fixed order whatever the order of the input, one per line', () => {
    const input = {
      skill: 'Pdf',
      url: 'https://Example.test',
      query: 'Search Words',
      description: 'Short Summary',
      prompt: 'Do The Thing',
      path: 'Src',
      file_path: '/Repo/A.ts',
      pattern: 'Foo.*Bar',
      command: 'Git Status',
    }
    expect(toolUseSearchText(input)).toBe(
      'Git Status\nFoo.*Bar\n/Repo/A.ts\nSrc\nDo The Thing\nShort Summary\nSearch Words\nhttps://Example.test\nPdf',
    )
  })

  test('string lists (args, then files) follow, each joined with spaces', () => {
    const input = { files: ['a.png', 'b.png'], command: 'tmux', args: ['send-keys', '-t', 'main'] }
    expect(toolUseSearchText(input)).toBe('tmux\nsend-keys -t main\na.png b.png')
  })

  test('anything else is ignored: unknown fields, non-string values, lists holding non-strings', () => {
    expect(toolUseSearchText({ old_string: 'x', content: 'y', path: 42, args: ['ok', 7], files: 'not-a-list' })).toBe('')
    expect(toolUseSearchText({ pattern: 'kept', timeout: 5000 })).toBe('kept')
  })

  test('input that is not an object yields nothing', () => {
    for (const input of [undefined, null, 'command', 42, true]) {
      expect(toolUseSearchText(input)).toBe('')
    }
  })
})

// --- toolResultSearchText ----------------------------------------------------------

describe("toolResultSearchText: the text of a tool's own output", () => {
  test('shell output: stdout, then stderr on the next line when there is any', () => {
    expect(toolResultSearchText({ stdout: 'Out', stderr: 'Err' })).toBe('Out\nErr')
    expect(toolResultSearchText({ stdout: 'Out', stderr: '' })).toBe('Out')
    expect(toolResultSearchText({ stdout: 'Out' })).toBe('Out')
    expect(toolResultSearchText({ stdout: '', stderr: 'Only Err' })).toBe('\nOnly Err')
  })

  test('shell output wins over every other field', () => {
    expect(toolResultSearchText({ stdout: 'Shell', content: 'ignored', file: { content: 'ignored' } })).toBe('Shell')
  })

  test("a file read: the file's content", () => {
    expect(toolResultSearchText({ type: 'text', file: { filePath: '/r/a.ts', content: 'Line A\nLine B', numLines: 2 } })).toBe(
      'Line A\nLine B',
    )
  })

  test('otherwise the known output fields, strings first and lists after, one per line', () => {
    const output = {
      filenames: ['src/a.ts', 'src/b.ts'],
      message: 'Msg',
      results: ['r1', 'r2'],
      text: 'Txt',
      lines: ['l1'],
      result: 'Res',
      output: 'Outp',
      content: 'Cont',
    }
    expect(toolResultSearchText(output)).toBe('Cont\nOutp\nRes\nTxt\nMsg\nsrc/a.ts\nsrc/b.ts\nl1\nr1\nr2')
  })

  test('a file field without string content falls back to the known fields', () => {
    expect(toolResultSearchText({ file: { content: 12 }, content: 'Fallback' })).toBe('Fallback')
  })

  test('metadata the screen does not show is ignored', () => {
    expect(
      toolResultSearchText({ rawOutputPath: '/tmp/x', backgroundTaskId: 'bg_1', filePath: '/r/a.ts', durationMs: '12', lines: ['ok', 3] }),
    ).toBe('')
  })

  test('a bare string is its own text; other non-objects yield nothing', () => {
    expect(toolResultSearchText('Plain Result')).toBe('Plain Result')
    for (const output of [undefined, null, 0, 17, false]) {
      expect(toolResultSearchText(output)).toBe('')
    }
  })
})
