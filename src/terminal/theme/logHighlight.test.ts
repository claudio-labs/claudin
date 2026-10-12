import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { colorize } from 'src/terminal/ink/colorize.js'
import { highlightLogText } from 'src/terminal/theme/logHighlight.js'
import { darkTheme } from 'src/terminal/theme/themes/dark.js'
import { darkAnsiTheme } from 'src/terminal/theme/themes/darkAnsi.js'
import type { Theme } from 'src/terminal/theme/themes/types.js'

const savedLevel = chalk.level
const savedKillswitch = process.env.CLAUDIN_LOG_HIGHLIGHT

beforeAll(() => {
  // Under `bun test` stdout is not a TTY, so chalk would emit nothing at all.
  chalk.level = 3
})

beforeEach(() => {
  delete process.env.CLAUDIN_LOG_HIGHLIGHT
})

afterAll(() => {
  chalk.level = savedLevel
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_LOG_HIGHLIGHT
  else process.env.CLAUDIN_LOG_HIGHLIGHT = savedKillswitch
})

function painted(word: string, theme: Theme, key: keyof Theme): string {
  return colorize(word, theme[key], 'foreground')
}

describe('level words', () => {
  test('each level takes its theme color and the message stays plain', () => {
    const out = highlightLogText('INFO ok\nWARN slow\nERROR boom\nDEBUG x', darkTheme)
    expect(out.split('\n')).toEqual([
      `${painted('INFO', darkTheme, 'suggestion')} ok`,
      `${painted('WARN', darkTheme, 'warning')} slow`,
      `${painted('ERROR', darkTheme, 'error')} boom`,
      `${painted('DEBUG', darkTheme, 'inactive')} x`,
    ])
  })

  test('an ANSI theme gets its named color, not the rgb fallback', () => {
    // dark-ansi's error is ansi:redBright → SGR 91.
    expect(highlightLogText('ERROR boom', darkAnsiTheme)).toBe('\x1b[91mERROR\x1b[39m boom')
  })

  test('npm ERR! and FATAL count as errors', () => {
    const out = highlightLogText('npm ERR! code E404\nFATAL down', darkTheme)
    expect(out).toContain(painted('ERR', darkTheme, 'error'))
    expect(out).toContain(painted('FATAL', darkTheme, 'error'))
  })

  test('a bracketed uppercase level is painted once', () => {
    expect(highlightLogText('[ERROR] x', darkTheme)).toBe(`[${painted('ERROR', darkTheme, 'error')}] x`)
  })
})

describe('what stays plain', () => {
  test.each([
    'throw new Error("x")',
    'an error occurred while saving',
    'ERR_MODULE_NOT_FOUND',
    'Information about the warning',
    '[foo] not a level',
    'name | value',
  ])('%s', line => {
    expect(highlightLogText(line, darkTheme)).toBe(line)
  })

  test('a line its own program already colored is left alone', () => {
    // The level sits after a space, so the word rule WOULD match it.
    const line = '\x1b[1m[app]\x1b[0m INFO ready'
    expect(highlightLogText(`${line}\nWARN x`, darkTheme)).toBe(
      `${line}\n${painted('WARN', darkTheme, 'warning')} x`,
    )
  })

  test('the killswitch turns it off', () => {
    process.env.CLAUDIN_LOG_HIGHLIGHT = '0'
    expect(highlightLogText('ERROR boom', darkTheme)).toBe('ERROR boom')
  })
})

describe('structured levels', () => {
  test('key=value, JSON and lowercase brackets paint the value', () => {
    expect(highlightLogText('ts=1 level=warn msg=x', darkTheme)).toBe(
      `ts=1 level=${painted('warn', darkTheme, 'warning')} msg=x`,
    )
    expect(highlightLogText('{"level":"error","msg":"x"}', darkTheme)).toBe(
      `{"level":"${painted('error', darkTheme, 'error')}","msg":"x"}`,
    )
    expect(highlightLogText('[info] ready', darkTheme)).toBe(`[${painted('info', darkTheme, 'suggestion')}] ready`)
  })

  test('compiler diagnostics', () => {
    expect(highlightLogText('error: expected `;`', darkTheme)).toBe(
      `${painted('error', darkTheme, 'error')}: expected \`;\``,
    )
    expect(highlightLogText('error[E0308]: mismatched types', darkTheme)).toBe(
      `${painted('error', darkTheme, 'error')}[E0308]: mismatched types`,
    )
    expect(highlightLogText('a.ts(1,2): error TS2345: bad', darkTheme)).toBe(
      `a.ts(1,2): ${painted('error', darkTheme, 'error')} TS2345: bad`,
    )
  })
})

describe('timestamps and compose prefixes', () => {
  test('ISO, leading and bracketed clocks are dimmed', () => {
    const iso = '2026-10-11T12:00:00.123Z'
    expect(highlightLogText(`${iso} INFO ok`, darkTheme)).toBe(
      `${painted(iso, darkTheme, 'inactive')} ${painted('INFO', darkTheme, 'suggestion')} ok`,
    )
    expect(highlightLogText('12:03:41 up', darkTheme)).toBe(`${painted('12:03:41', darkTheme, 'inactive')} up`)
    expect(highlightLogText('[12:03:41] up', darkTheme)).toBe(`[${painted('12:03:41', darkTheme, 'inactive')}] up`)
  })

  test('a compose service keeps one color and the rest of the line is still read', () => {
    const out = highlightLogText('api-1  | INFO ready\napi-1  | WARN slow', darkTheme)
    const [first, second] = out.split('\n') as [string, string]
    const servicePart = first.slice(0, first.indexOf('  |'))
    expect(stripAnsi(servicePart)).toBe('api-1')
    expect(servicePart).not.toBe('api-1')
    expect(second.startsWith(servicePart)).toBe(true)
    expect(first).toContain(`  | ${painted('INFO', darkTheme, 'suggestion')} ready`)
  })

  test('two services whose names hash alike still get different colors', () => {
    // api-1 and worker-1 land on the same palette slot.
    const out = highlightLogText('api-1     | INFO a\nworker-1  | INFO b', darkTheme)
    const [api, worker] = out.split('\n').map(line => line.slice(0, line.indexOf(' ')))
    expect(stripAnsi(api!)).toBe('api-1')
    expect(stripAnsi(worker!)).toBe('worker-1')
    expect(api!.replace('api-1', '')).not.toBe(worker!.replace('worker-1', ''))
  })
})

test('only escapes are added: the visible text and the line count are unchanged', () => {
  const input = 'api-1  | 2026-10-11T12:00:00Z ERROR x\n\nlevel=info y\n12:00:01 WARN z'
  const out = highlightLogText(input, darkTheme)
  expect(out).not.toBe(input)
  expect(stripAnsi(out)).toBe(input)
})
