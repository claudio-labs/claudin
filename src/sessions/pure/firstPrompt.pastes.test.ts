// A prompt that starts with a paste is the user's prompt, not injected XML:
// the /resume picker, the cached last prompt and the head-chunk scan all
// name the session after it.
import { expect, test } from 'bun:test'
import { expandPastedTextRefs } from 'src/agent/history.js'
import { wrapPastedContents } from 'src/agent/input/pastedContent.js'
import {
  extractFirstPrompt,
  extractFirstPromptFromChunk,
  getFirstMeaningfulUserMessageTextContent,
} from 'src/sessions/pure/firstPrompt.js'

const stored = expandPastedTextRefs(
  '[Pasted text #1] fix this error',
  wrapPastedContents({ 1: { id: 1, type: 'text', content: 'TypeError: boom\n  at x.ts:1' } }, () => 'ab12'),
)

const msg = (text: string) => ({
  type: 'user',
  uuid: '00000000-0000-0000-0000-000000000001',
  message: { role: 'user', content: text },
})

test('a prompt that starts with a paste is still the session first prompt', () => {
  expect(stored.startsWith('<pasted_content id="ab12">')).toBe(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(getFirstMeaningfulUserMessageTextContent([msg(stored)] as any)).toBe('TypeError: boom\n  at x.ts:1 fix this error')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = extractFirstPrompt([msg(stored)] as any)
  expect(first).toStartWith('TypeError: boom')
  expect(first).not.toContain('pasted_content')
})

test('the head-chunk scan of the .jsonl also finds it, without the tags', () => {
  const found = extractFirstPromptFromChunk(JSON.stringify(msg(stored)) + '\n')
  expect(found).toStartWith('TypeError: boom')
  expect(found).not.toContain('pasted_content')
})
