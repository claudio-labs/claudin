import { describe, expect, test } from 'bun:test'

import {
  buildRunArgs,
  compileMatcher,
  itemMatches,
  type WatchLoopOptions,
} from 'src/cli/workflow/watchLoop.js'
import type { TriggerItem } from 'src/cli/workflow/sources.js'

const OPTS: WatchLoopOptions = {
  label: 'claudin',
  workflow: 'dev-flow',
  intervalSec: 30,
  source: 'github',
}

describe('buildRunArgs', () => {
  test('forwards the script path when argv[1] is a .mjs entry', () => {
    const args = buildRunArgs(OPTS, 'do the thing', '/opt/claudin/dist/cli.mjs')
    expect(args).toEqual([
      '/opt/claudin/dist/cli.mjs',
      'workflow',
      'run',
      'dev-flow',
      '--task',
      'do the thing',
      '--worktree',
      '--pr',
    ])
  })

  test('omits argv[1] for a compiled binary (no script extension)', () => {
    const args = buildRunArgs(OPTS, 'task', '/usr/local/bin/claudin')
    expect(args[0]).toBe('workflow')
    expect(args).toContain('--worktree')
    expect(args).toContain('--pr')
  })

  test('always isolates and opens a PR (--worktree --pr)', () => {
    const args = buildRunArgs(OPTS, 'task', undefined)
    expect(args).toContain('--worktree')
    expect(args).toContain('--pr')
  })

  test('appends --base when provided', () => {
    const args = buildRunArgs({ ...OPTS, base: 'release' }, 'task', undefined)
    expect(args.slice(-2)).toEqual(['--base', 'release'])
  })

  test('omits --base when not provided', () => {
    expect(buildRunArgs(OPTS, 'task', undefined)).not.toContain('--base')
  })
})

const item = (title: string, body: string): TriggerItem => ({
  id: 'x',
  title,
  body,
})

describe('compileMatcher / itemMatches (--match)', () => {
  test('no pattern → matcher is null and every item passes', () => {
    const m = compileMatcher(undefined)
    expect(m).toBeNull()
    expect(itemMatches(item('anything', 'goes'), m)).toBe(true)
  })

  test('matches against title OR body (joined by newline)', () => {
    const m = compileMatcher('deploy')
    expect(itemMatches(item('deploy now', ''), m)).toBe(true)
    expect(itemMatches(item('nope', 'please deploy'), m)).toBe(true)
    expect(itemMatches(item('nope', 'nothing here'), m)).toBe(false)
  })

  test('respects regex syntax (anchors, char classes)', () => {
    const m = compileMatcher('^READY:')
    expect(itemMatches(item('READY: v2', 'body'), m)).toBe(true)
    expect(itemMatches(item('not READY:', 'body'), m)).toBe(false)
  })

  test('an invalid regex throws (surfaced as exit 2 by the loop)', () => {
    expect(() => compileMatcher('(')).toThrow()
  })
})
