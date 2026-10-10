import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costOf, datesRe, fridaysAfter, isExtractionRequest, selfTest } from './extract-memories-ab'

describe('extract-memories-ab grader', () => {
  test('passes the good memory tree and fails each bad one on what it names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-memories-ab-'))
    try {
      const failed = selfTest(dir).filter(([, ok]) => !ok)
      expect(failed).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('"a próxima sexta" from a Saturday is the coming Friday or the one after', () => {
    const [first, second] = fridaysAfter(new Date(2026, 9, 10, 9))
    expect([first!.getDate(), second!.getDate()]).toEqual([16, 23])
    const re = datesRe([first!])
    for (const text of ['until 2026-10-16', 'até 16/10', 'até 16 de outubro', 'until October 16']) expect(re.test(text)).toBe(true)
    expect(re.test('until next Friday')).toBe(false)
  })
})

describe('extract-memories-ab wire', () => {
  test('tells the extraction requests from the rest by their prompt', () => {
    const prompt = { type: 'text', text: '\nYou are now acting as the memory extraction subagent. Analyze…' }
    expect(isExtractionRequest({ messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: [prompt] }] })).toBe(true)
    expect(isExtractionRequest({ messages: [{ role: 'user', content: 'hi' }] })).toBe(false)
  })

  test('prices Haiku 5.5 at its long-prompt rates past 100k, and Opus 5.5 cache reads at $0.20', () => {
    expect(costOf('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1_000 })).toBeCloseTo(0.0055, 6)
    expect(costOf('claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 1_000 })).toBeCloseTo(0.0775, 6)
    expect(costOf('claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(0.2, 6)
    expect(() => costOf('gpt-5', {})).toThrow('no price')
  })
})
