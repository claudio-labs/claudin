import { describe, expect, test } from 'bun:test'
import {
  CONTAINER_LOG_TAIL,
  containerLogsArgs,
  hasOwnTimestamp,
  mergeLogStreams,
} from 'src/agent/ui/tasks/containerLogs.js'

const ts = (s: string, text: string) => `2026-09-06T12:00:${s}.000000000Z ${text}`

describe('containerLogsArgs', () => {
  test('asks for the tail, not the whole log', () => {
    const args = containerLogsArgs('c0ffee')
    expect(args[args.indexOf('--tail') + 1]).toBe(String(CONTAINER_LOG_TAIL))
    expect(args.at(-1)).toBe('c0ffee')
  })

  test('--timestamps is present — the merge below depends on it', () => {
    expect(containerLogsArgs('c0ffee')).toContain('--timestamps')
  })

  test('never follows: a streaming child would outlive the dialog', () => {
    expect(containerLogsArgs('c0ffee')).not.toContain('--follow')
  })
})

describe('mergeLogStreams', () => {
  test('interleaves the two streams by timestamp', () => {
    // Reading either stream alone loses half the output, and most runtimes log
    // to stderr — so concatenating them in stream order would show a container
    // that logs to both in an order it never produced.
    const out = mergeLogStreams(
      `${ts('01', 'listening on 8080')}\n${ts('03', 'GET /health')}\n`,
      `${ts('02', 'WARN slow query')}\n${ts('04', 'ERR upstream refused')}\n`,
    )
    expect(out.map(l => l.text)).toEqual([
      'listening on 8080',
      'WARN slow query',
      'GET /health',
      'ERR upstream refused',
    ])
  })

  test('strips the timestamp into its own field', () => {
    const [line] = mergeLogStreams(ts('07', 'ready'), '')
    expect(line).toEqual({ time: '12:00:07', text: 'ready' })
  })

  test('an untimestamped line stays under the line it belongs to', () => {
    // A stack trace whose frames arrive unprefixed must not be scattered to the
    // top of the tail by the sort.
    const out = mergeLogStreams(
      `${ts('05', 'Traceback (most recent call last):')}\n  File "app.py", line 3\nValueError: nope\n`,
      ts('01', 'booting'),
    )
    expect(out.map(l => l.text)).toEqual([
      'booting',
      'Traceback (most recent call last):',
      '  File "app.py", line 3',
      'ValueError: nope',
    ])
  })

  test('keeps only the last CONTAINER_LOG_TAIL lines', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      `2026-09-06T12:00:00.${String(i).padStart(9, '0')}Z line${i}`,
    ).join('\n')
    const out = mergeLogStreams(many, '')
    expect(out).toHaveLength(CONTAINER_LOG_TAIL)
    expect(out.at(-1)!.text).toBe('line119')
  })

  test('a container that logged nothing yields no lines', () => {
    expect(mergeLogStreams('', '')).toEqual([])
    expect(mergeLogStreams('\n\n', '')).toEqual([])
  })
})

describe('hasOwnTimestamp', () => {
  // Guards the display prefix only. Verified against a live postgres:16-alpine,
  // which renders `04:00:45 2026-09-06 04:00:45.415 UTC [27] LOG: …` without it.
  test('recognises the formats server images actually emit', () => {
    for (const line of [
      '2026-09-06 04:00:45.415 UTC [27] LOG:  checkpoint complete',
      '2026-09-06T04:00:45.415Z starting',
      '04:00:45 ready',
      '[04:00:45] ready',
      '(04:00:45) ready',
    ]) {
      expect(hasOwnTimestamp(line), `should have matched: ${line}`).toBe(true)
    }
  })

  test('leaves a plain line alone, so it keeps docker\u2019s clock', () => {
    for (const line of [
      'listening on 8080',
      'ERROR 500 at 12:00:00',
      '2026-09-06 is the date',
      '',
    ]) {
      expect(hasOwnTimestamp(line), `should not have matched: ${line}`).toBe(false)
    }
  })
})
