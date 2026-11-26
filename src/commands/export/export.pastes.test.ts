import { expect, test } from 'bun:test'
import { expandPastedTextRefs } from 'src/agent/history.js'
import { wrapPastedContents } from 'src/agent/input/pastedContent.js'
import { extractFirstPrompt } from 'src/commands/export/export.js'

test('/export names the file after the first prompt, not the paste tag', () => {
  const stored = expandPastedTextRefs(
    '[Pasted text #1] fix this error',
    wrapPastedContents({ 1: { id: 1, type: 'text', content: 'TypeError: boom' } }, () => 'ab12'),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = extractFirstPrompt([{ type: 'user', message: { role: 'user', content: stored } }] as any)
  expect(first).toBe('TypeError: boom fix this error')
})
