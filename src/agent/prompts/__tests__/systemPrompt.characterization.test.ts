// Characterization of the SHIPPED system prompt, for the dead-code cleanup.
//
// The cleanup unwinds ~300 `feature('FLAG')` branches, 8 of them in prompts.ts
// and 3 in systemPrompt.ts. Every one of those must be a no-op on the rendered
// text: the prompt sits in front of the prompt-cache boundary, so a single
// changed byte costs every user a full cache miss on their next turn.
//
// Why a subprocess instead of importing getSystemPrompt: `feature()` cannot be
// resolved outside the build. Bun resolves `bun:bundle` natively before any
// plugin or mock, so under `bun test` all flags read false — a source-side
// render is the flag-OFF shape and would happily stay identical while the
// shipped prompt changed underneath it. Only `dist/cli.mjs` has the folded
// values. See .claudin/rules/build-system.md, "A source-side render reads every
// flag as false".
//
// The model is pinned because the prompt carries a per-family addendum
// (FAMILY_PROMPT_ADDENDUMS) and names the model in its Environment block, so an
// unpinned dump would snapshot whichever profile the developer had active.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const SNAPSHOT_DIR = join(__dirname, '__snapshots__')
const MODEL = 'claude-opus-5'

/**
 * Blank out what varies by machine, and nothing else.
 *
 * The KEYS stay in the text, so a deleted Environment line still fails the
 * comparison — only the values are replaced. Over-normalizing here would turn
 * the snapshot into a test of its own normalizer.
 */
function normalize(prompt: string): string {
  return prompt
    .split(REPO_ROOT)
    .join('<REPO_ROOT>')
    .split(homedir())
    .join('<HOME>')
    .replace(/^( - Platform: ).*$/m, '$1<PLATFORM>')
    .replace(/^( - Shell: ).*$/m, '$1<SHELL>')
    .replace(/^( - OS Version: ).*$/m, '$1<OS_VERSION>')
    .replace(/^( - Is a git repository: ).*$/m, '$1<IS_GIT_REPO>')
}

function dump(extraArgs: readonly string[]): string {
  const args = ['--dump-system-prompt', '--model', MODEL, ...extraArgs]
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  })
  if (res.error) throw res.error
  // Same guard bootSnapshot.test.ts carries: a leaked child_process module mock
  // from another file returns `{ status: 0 }` with no stdout, and
  // `undefined + ''` is the string "undefined" — which then diffs against a
  // 15 KB snapshot and reads as "the entire prompt changed".
  if (typeof res.stdout !== 'string' || res.stdout === '') {
    throw new Error(
      `${BUNDLE} ${args.join(' ')} captured no stdout (status=${res.status}, ` +
        `signal=${res.signal}). If status is 0, spawnSync is mocked — some ` +
        'other test file leaked a child_process module mock.',
    )
  }
  return normalize(res.stdout)
}

// Regenerate with `UPDATE_PROMPT_SNAPSHOT=1 bun test <this file>` after
// `bun run build`. Deliberately one function rather than a separate generator
// script: two copies of `normalize` would drift, and a snapshot normalized
// differently from the comparison is a test of its own normalizer.
const UPDATING = process.env.UPDATE_PROMPT_SNAPSHOT === '1'

function compareOrWrite(name: string, actual: string): void {
  const path = join(SNAPSHOT_DIR, name)
  if (UPDATING) {
    writeFileSync(path, actual)
    return
  }
  expect(actual).toBe(readFileSync(path, 'utf8'))
}

describe('shipped system prompt — characterization', () => {
  test('the bundle exists', () => {
    // A missing bundle must fail loudly rather than skip: a silently skipped
    // characterization test is worse than none, because the cleanup would read
    // the green run as proof the prompt did not move.
    expect(
      existsSync(BUNDLE) ? 'present' : `MISSING — run \`bun run build\` first: ${BUNDLE}`,
    ).toBe('present')
  })

  test('the main-session prompt is byte-identical to the snapshot', () => {
    compareOrWrite('systemPrompt.main.txt', dump([]))
  }, 180_000)

  test('the sub-agent prompt is byte-identical to the snapshot', () => {
    // Assembled on a different path (enhanceSystemPromptWithEnvDetails), so the
    // main dump proves nothing about it — a parity pass that read only the
    // first has already reported sub-agent steering as missing.
    compareOrWrite('systemPrompt.subagent.txt', dump(['--subagent']))
  }, 180_000)

  test('the snapshot is the flags-ON shape, not a source-side render', () => {
    // The trap this whole file is built around: if someone regenerates the
    // snapshot from source instead of from the bundle, every flag reads false
    // and ~800 tokens of steering silently vanish from the baseline. These
    // three sections exist ONLY behind flags that ship true (WORK_CONTRACT,
    // ANTI_NARRATION), so their presence proves the provenance.
    const snapshot = readFileSync(join(SNAPSHOT_DIR, 'systemPrompt.main.txt'), 'utf8')
    expect(snapshot).toContain('# Delivering work')
    expect(snapshot).toContain('# Corrections')
    expect(snapshot).toContain('Batch independent tool calls in a single message')
  })
})
