import { describe, expect, test } from 'bun:test'
import { files, formatTable, parseRun, prompt, type RunResult } from './codex-websocket-ab'

describe('the task', () => {
  test('N files with a known sum, and a prompt that reads them one at a time', () => {
    const { files: repo, sum } = files(3)
    expect(Object.keys(repo)).toEqual(['f01.txt', 'f02.txt', 'f03.txt'])
    expect(sum).toBe(37 + 74 + 10)
    expect(prompt(22)).toContain('f01.txt through f22.txt one at a time')
  })
})

describe('parseRun', () => {
  const assistant = (uuid: string, blocks: Array<{ type: string }>) => JSON.stringify({ type: 'assistant', uuid, message: { content: blocks } })

  test('counts each tool call once, though stream-json prints assistant events twice', () => {
    const stdout = [
      assistant('a', [{ type: 'tool_use' }]),
      assistant('a', [{ type: 'tool_use' }]),
      assistant('b', [{ type: 'text' }, { type: 'tool_use' }]),
      'not json',
      JSON.stringify({ type: 'result', result: 'The sum is 121.', duration_ms: 9000, duration_api_ms: 7000 }),
    ].join('\n')
    expect(parseRun(stdout, 121)).toEqual({ toolCalls: 2, durationMs: 9000, apiMs: 7000, correct: true })
  })

  test('a wrong sum or no result is not correct', () => {
    expect(parseRun(JSON.stringify({ type: 'result', result: '120' }), 121).correct).toBe(false)
    expect(parseRun('', 121)).toEqual({ toolCalls: 0, durationMs: undefined, apiMs: undefined, correct: false })
  })
})

describe('formatTable', () => {
  test('one row per arm that ran: median and range of wall and api time', () => {
    const results: RunResult[] = [
      { arm: 'http', wallMs: 10_000, apiMs: 8_000, toolCalls: 22, correct: true, exit: 0 },
      { arm: 'http', wallMs: 12_000, apiMs: 9_000, toolCalls: 22, correct: true, exit: 0 },
      { arm: 'ws', wallMs: 8_000, toolCalls: 22, correct: false, exit: 0 },
    ]
    const lines = formatTable(results).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^http\s+2\s+2\/2\s+22 22\s+11\.0s \(10\.0–12\.0\)\s+8\.5s \(8\.0–9\.0\)$/)
    expect(lines[2]).toMatch(/^ws\s+1\s+0\/1\s+22\s+8\.0s \(8\.0–8\.0\)\s+—$/)
  })
})
