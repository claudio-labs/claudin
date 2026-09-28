// Session titles: the three title fixes the characterization suite leaves
// open. A compact summary never titles a session, a prompt made only of
// whitespace does not hide the prompts after it, and carriage returns are
// flattened like line feeds.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createUserMessage, formatCommandInputTags } from 'src/agent/messages/factories.js'
import {
  extractFirstPrompt,
  extractFirstPromptFromChunk,
  getFirstMeaningfulUserMessageTextContent,
} from 'src/sessions/pure/firstPrompt.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

const FIXTURES = join(import.meta.dir, '..', '__fixtures__', 'rewrite')

const typed = (content: string) => createUserMessage({ content })
const titleOf = (messages: unknown[]) => extractFirstPrompt(messages as TranscriptMessage[])
const userLine = (content: unknown, extra: object = {}) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, ...extra })
const chunkOf = (...lines: string[]) => lines.join('\n')

describe('meta messages', () => {
  // The suites' other meta messages open with a tag, which the skip pattern
  // drops on its own; this one reads like a prompt.
  test('a meta message never titles a session, even one that reads like a prompt', () => {
    const meta = createUserMessage({ content: 'Continue from where you left off.', isMeta: true })
    expect(getFirstMeaningfulUserMessageTextContent([meta, typed('the real prompt')])).toBe('the real prompt')
    expect(titleOf([meta])).toBe('No prompt')
  })
})

describe('compact summaries', () => {
  test('the chunk reading skips a summary line and titles the session by the prompt after it', () => {
    const chunk = chunkOf(
      userLine('Summary: the retry was added.', { isVisibleInTranscriptOnly: true, isCompactSummary: true }),
      userLine('now add the tests'),
    )
    expect(extractFirstPromptFromChunk(chunk)).toBe('now add the tests')
  })

  test('a fork of a compacted session is titled by its first prompt, not its summary', () => {
    const forkHead = readFileSync(join(FIXTURES, 'compacted.loaded.jsonl'), 'utf8')
    expect(extractFirstPromptFromChunk(forkHead)).toBe('Now add a unit test for the retry')
  })

  test('a head holding only a summary has no title', () => {
    expect(extractFirstPromptFromChunk(userLine('Summary only', { isCompactSummary: true }))).toBe('')
  })
})

describe('whitespace-only prompts', () => {
  test('the message reading looks past a blank prompt', () => {
    expect(getFirstMeaningfulUserMessageTextContent([typed('  \n\t '), typed('the real one')])).toBe('the real one')
  })

  test('a blank text block is passed over like an empty one', () => {
    const blocks = createUserMessage({
      content: [
        { type: 'text', text: ' \n ' },
        { type: 'text', text: 'after the blank block' },
      ],
    })
    expect(getFirstMeaningfulUserMessageTextContent([blocks])).toBe('after the blank block')
  })

  test('a transcript of blank prompts has no prompt', () => {
    expect(titleOf([typed('   '), typed('\n')])).toBe('No prompt')
  })

  test('the chunk reading looks past a blank prompt', () => {
    expect(extractFirstPromptFromChunk(chunkOf(userLine('   \n  '), userLine('go on')))).toBe('go on')
  })

  test('a blank prompt does not hide the command fallback', () => {
    const chunk = chunkOf(userLine(formatCommandInputTags('model', 'opus')), userLine('\t\n'))
    expect(extractFirstPromptFromChunk(chunk)).toBe('/model')
  })
})

describe('carriage returns', () => {
  const pasted = 'first\r\nsecond\rthird\nfourth'

  test('CRLF, a lone CR and LF each flatten to one space in the message reading', () => {
    expect(titleOf([typed(pasted)])).toBe('first second third fourth')
  })

  test('the chunk reading flattens them the same way', () => {
    expect(extractFirstPromptFromChunk(userLine(pasted))).toBe('first second third fourth')
  })

  test('bash input pasted with CRLF reads as one line', () => {
    expect(extractFirstPromptFromChunk(userLine('<bash-input>npm run\r\nlint</bash-input>'))).toBe('! npm run lint')
    expect(titleOf([typed('<bash-input>npm run\r\nlint</bash-input>')])).toBe('! npm run lint')
  })

  test('the message reading still returns the text verbatim', () => {
    expect(getFirstMeaningfulUserMessageTextContent([typed(pasted)])).toBe(pasted)
  })
})
