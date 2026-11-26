import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { REPO_ROOT } from '../repoRoot.js'
import {
  BUSY_MARKER,
  isBusy,
  observe,
  parseCommand,
  seededConfig,
  startArgs,
  UsageError,
  type Watch,
} from './tui-probe.ts'

describe('parseCommand', () => {
  test('start: defaults, flags, and a command after --', () => {
    expect(parseCommand(['start', 'p'], '/repo')).toEqual({
      kind: 'start',
      name: 'p',
      cwd: '/repo',
      cols: 184,
      rows: 46,
      env: [],
      configDir: null,
      fullscreen: false,
      acceptTrust: false,
      cmd: [join(REPO_ROOT, 'bin', 'claudin')],
      timeoutS: 120,
    })
    expect(
      parseCommand(
        ['start', 'p', '--cwd', 'sub', '--size', '100x30', '--env', 'A=1', '--env', 'B=2', '--config-dir', 'cfg', '--fullscreen', '--', 'node', 'x.mjs', '--flag'],
        '/repo',
      ),
    ).toMatchObject({ cwd: '/repo/sub', cols: 100, rows: 30, env: ['A=1', 'B=2'], configDir: '/repo/cfg', fullscreen: true, cmd: ['node', 'x.mjs', '--flag'] })
  })

  test('send, keys, wait, capture and stop', () => {
    expect(parseCommand(['send', 'p', 'hello there', '--until', '^ok$', '--timeout', '30'], '/')).toEqual({
      kind: 'send',
      name: 'p',
      text: 'hello there',
      wait: true,
      until: '^ok$',
      timeoutS: 30,
    })
    expect(parseCommand(['send', 'p', '/status', '--no-wait'], '/')).toMatchObject({ wait: false })
    expect(parseCommand(['keys', 'p', 'C-o', 'Escape'], '/')).toMatchObject({ keys: ['C-o', 'Escape'] })
    expect(parseCommand(['wait', 'p'], '/')).toEqual({ kind: 'wait', name: 'p', until: null, timeoutS: 120 })
    expect(parseCommand(['capture', 'p', '--ansi', '--lines', '12'], '/')).toEqual({ kind: 'capture', name: 'p', ansi: true, lines: 12 })
    expect(parseCommand(['stop', 'p'], '/')).toEqual({ kind: 'stop', name: 'p' })
  })

  test('what it cannot read is a usage error', () => {
    for (const argv of [
      [],
      ['start'],
      ['bogus', 'p'],
      ['start', 'p', '--size', 'big'],
      ['start', 'p', '--env', 'not-an-assignment'],
      ['send', 'p'],
      ['send', 'p', 'a', 'b'],
      ['keys', 'p'],
      ['wait', 'p', '--timeout', '0'],
      ['wait', 'p', '--until'],
      ['capture', 'p', '--lines', '-3'],
    ]) {
      expect(() => parseCommand(argv, '/')).toThrow(UsageError)
    }
    expect(() => parseCommand(['wait', 'p', '--until', '('], '/')).toThrow(SyntaxError)
  })
})

describe('startArgs and seededConfig', () => {
  test('a session on the probe server, with the map sync off and the env asked for', () => {
    const start = parseCommand(['start', 'p', '--config-dir', '/cfg', '--fullscreen', '--env', 'X=1', '--', 'node', "it's.mjs"], '/repo')
    if (start.kind !== 'start') throw new Error('expected start')
    expect(startArgs(start)).toEqual([
      'new-session', '-d', '-s', 'p', '-x', '184', '-y', '46', '-c', '/repo',
      '-e', 'CLAUDIN_DISABLE_RULE_MAP_SYNC=1',
      '-e', 'CLAUDIN_NO_FLICKER=1',
      '-e', 'CLAUDIN_CONFIG_DIR=/cfg',
      '-e', 'X=1',
      `'node' 'it'\\''s.mjs'`,
    ])
  })

  test('the seeded config is onboarded and trusts the cwd', () => {
    expect(JSON.parse(seededConfig('/repo'))).toEqual({ hasCompletedOnboarding: true, projects: { '/repo': { hasTrustDialogAccepted: true } } })
  })
})

describe('observe — when a turn is over', () => {
  const fresh = (startedAt: number): Watch => ({ last: '', stableSince: startedAt, sawBusy: false, startedAt })
  const idlePane = '● done\n\n❯ \n  ? for shortcuts\n'
  const busyPane = '⣾ Tomfoolering... (3s)\n❯ \n  ⏵⏵ auto mode on · esc to interrupt\n'

  test('not while the busy hint shows, however long the pane holds', () => {
    let w = fresh(0)
    for (const now of [0, 2_000, 9_000]) w = observe(w, busyPane, now, 3_000).watch
    expect(observe(w, busyPane, 12_000, 3_000).idle).toBe(false)
  })

  test('once the hint is gone and the pane held a second', () => {
    let w = observe(fresh(0), busyPane, 0, 3_000).watch
    w = observe(w, idlePane, 500, 3_000).watch
    expect(observe(w, idlePane, 1_000, 3_000).idle).toBe(false)
    expect(observe(w, idlePane, 1_600, 3_000).idle).toBe(true)
  })

  test('the echoed prompt before the turn starts is not the answer', () => {
    const echoed = '❯ say ok\n'
    let w = observe(fresh(0), echoed, 0, 3_000).watch
    expect(observe(w, echoed, 2_000, 3_000).idle).toBe(false)
    w = observe(w, echoed, 2_500, 3_000).watch
    expect(observe(w, echoed, 3_100, 3_000).idle).toBe(true)
  })
})

// The probe reads the TUI's busy state from this one hint; if its text or the
// place that shows it while a turn runs moves, these go red instead of the
// probe waiting out every timeout.
describe('the busy hint the probe reads', () => {
  test('KeyboardShortcutHint renders "<key> to interrupt"', async () => {
    const text = await renderToString(React.createElement(KeyboardShortcutHint, { shortcut: 'esc', action: 'interrupt' }))
    expect(text).toContain(`esc ${BUSY_MARKER}`)
    expect(isBusy(text)).toBe(true)
  })

  test('the footer shows it while loading', () => {
    const footer = readFileSync(join(REPO_ROOT, 'src/terminal/prompt-input/PromptInputFooterLeftSide.tsx'), 'utf8')
    expect(footer).toContain('...(isLoading ? [<Text dimColor key="esc">')
    expect(footer).toContain('<KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />')
  })
})
