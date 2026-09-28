import { describe, expect, test } from 'bun:test'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { renderableSearchText, toolResultSearchText, toolUseSearchText } from 'src/sessions/transcriptSearch.js'
import type { RenderableMessage } from 'src/shared/types/message.js'

const asShown = (message: object): RenderableMessage => message as RenderableMessage

describe('empty lists show nothing, so they add no line', () => {
  test('in a tool call', () => {
    expect(toolUseSearchText({ command: 'ls', args: [], files: [] })).toBe('ls')
    expect(toolUseSearchText({ args: [] })).toBe('')
  })

  test("in a tool's output", () => {
    expect(toolResultSearchText({ output: 'done', filenames: [], lines: [], results: [] })).toBe('done')
  })
})

describe('what a message puts in the search text', () => {
  test("a message carrying two tool results shows the tool's output once", () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' },
        { type: 'text', text: 'Between' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'second' },
      ],
      toolUseResult: { stdout: 'Shown Once' },
    })
    expect(renderableSearchText(asShown(message))).toBe('shown once\nbetween')
  })

  test('a tool call whose list is empty still takes one line in the assistant message', () => {
    const blocks = [
      { type: 'text', text: 'Before' },
      { type: 'tool_use', id: 'toolu_c', name: 'Run', input: { args: [] } },
      { type: 'text', text: 'After' },
    ]
    expect(renderableSearchText(asShown(createAssistantMessage({ content: blocks as BetaContentBlock[] })))).toBe('before\n\nafter')
  })
})

describe('system reminders', () => {
  test('one that opens in a block and closes in a later one is cut, the line between them included', () => {
    const message = createUserMessage({
      content: [
        { type: 'text', text: 'Kept <system-reminder>hidden' },
        { type: 'text', text: 'also hidden</system-reminder> Tail' },
      ],
    })
    expect(renderableSearchText(asShown(message))).toBe('kept  tail')
  })

  test('the tags are matched in lower case only', () => {
    const text = 'A <SYSTEM-REMINDER>Loud</SYSTEM-REMINDER> B'
    expect(renderableSearchText(asShown(createUserMessage({ content: text })))).toBe(text.toLowerCase())
  })
})
