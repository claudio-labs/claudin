import { describe, expect, test } from 'bun:test'
import { expandPastedTextRefs, formatPastedTextRef } from 'src/agent/history.js'
import {
  newPasteId,
  shouldWrapPastes,
  wrapPastedContents,
  wrapPastedText,
} from 'src/agent/input/pastedContent.js'
import type { PastedContent } from 'src/platform/config/config.js'
import { unwrapPastedContent } from 'src/shared/text/displayTags.js'

const TEXT: PastedContent = { id: 1, type: 'text', content: 'line one\nline two' }
const IMAGE: PastedContent = { id: 2, type: 'image', content: 'aGVsbG8=', mediaType: 'image/png' }

function ids(...values: string[]): () => string {
  let i = 0
  return () => values[i++]!
}

describe('wrapPastedText', () => {
  test('both tags carry the id, in the format Claude Code sends', () => {
    expect(wrapPastedText('hi', 'ab12')).toBe(
      '<pasted_content id="ab12">\nhi\n</pasted_content id="ab12">\n',
    )
  })
})

describe('newPasteId', () => {
  test('is four hex characters, fresh each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newPasteId()))
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{4}$/)
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('wrapPastedContents', () => {
  test('wraps text pastes, each with its own id, and leaves images alone', () => {
    const second: PastedContent = { id: 3, type: 'text', content: 'other' }
    const wrapped = wrapPastedContents({ 1: TEXT, 2: IMAGE, 3: second }, ids('aaaa', 'bbbb'))
    expect(wrapped[1]!.content).toBe(wrapPastedText(TEXT.content, 'aaaa'))
    expect(wrapped[2]).toBe(IMAGE)
    expect(wrapped[3]!.content).toBe(wrapPastedText('other', 'bbbb'))
    expect(wrapped[1]!.id).toBe(1)
  })

  test('does not touch the contents it was given', () => {
    const input = { 1: TEXT }
    wrapPastedContents(input, ids('aaaa'))
    expect(input[1].content).toBe('line one\nline two')
  })

  test('the expanded prompt puts the block exactly where the ref was', () => {
    const input = `summarize ${formatPastedTextRef(1, 1)} please`
    const expanded = expandPastedTextRefs(input, wrapPastedContents({ 1: TEXT }, ids('c0de')))
    expect(expanded).toBe(
      'summarize <pasted_content id="c0de">\nline one\nline two\n</pasted_content id="c0de">\n please',
    )
  })
})

describe('shouldWrapPastes', () => {
  test('a plain prompt is wrapped', () => {
    expect(shouldWrapPastes({ input: 'look at this', mode: 'prompt' })).toBe(true)
  })

  test('a slash command and a bash command take the paste as their own input', () => {
    expect(shouldWrapPastes({ input: '  /goal tests pass', mode: 'prompt' })).toBe(false)
    expect(shouldWrapPastes({ input: 'ls', mode: 'bash' })).toBe(false)
  })

  test('with slash commands off, a leading slash is plain text', () => {
    expect(shouldWrapPastes({ input: '/tmp is full', mode: 'prompt', skipSlashCommands: true })).toBe(true)
  })
})

describe('unwrapPastedContent', () => {
  test('round trip: unwrapping the wrapped expansion gives the plain expansion', () => {
    const second: PastedContent = { id: 3, type: 'text', content: 'tail\n' }
    const input = `a ${formatPastedTextRef(1, 1)} b ${formatPastedTextRef(3, 1)} c`
    const pasted = { 1: TEXT, 3: second }
    const wrapped = expandPastedTextRefs(input, wrapPastedContents(pasted, ids('0001', '0002')))
    expect(unwrapPastedContent(wrapped)).toBe(expandPastedTextRefs(input, pasted))
  })

  test('text with no block comes back unchanged', () => {
    expect(unwrapPastedContent('plain <b>text</b>')).toBe('plain <b>text</b>')
  })

  test('a block whose closing id differs is left as written', () => {
    const forged = '<pasted_content id="aaaa">\nx\n</pasted_content id="bbbb">\n'
    expect(unwrapPastedContent(forged)).toBe(forged)
  })

  test('a pasted closing tag without the id does not end the block early', () => {
    const body = 'before\n</pasted_content>\nafter'
    expect(unwrapPastedContent(wrapPastedText(body, 'abcd'))).toBe(body)
  })
})
