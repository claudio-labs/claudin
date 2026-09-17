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

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
// Empty stand-in config dir for the spawned bundle (see dump() below).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'claudin-snapshot-'))
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const SNAPSHOT_DIR = join(__dirname, '__snapshots__')
const MODEL = 'claude-opus-5'

// ~/.claudin/projects/<slug>: sanitizePath() turns every non-alphanumeric byte
// of the cwd into a hyphen, so the checkout path is encoded a SECOND time — in
// a form neither of the two path substitutions below can see. The memory
// section names that directory, so without this the snapshot carries whichever
// absolute path it was generated from.
const PROJECT_SLUG = REPO_ROOT.replace(/[^a-zA-Z0-9]/g, '-')

// The main prompt's Environment block prefixes every line with " - "; the
// sub-agent's <env> block does not, and words two of the keys differently.
// Both render the same machine-specific values, so both need blanking.
const ENV_VALUE_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^( - )?(Platform: ).*$/gm, '$1$2<PLATFORM>'],
  [/^( - )?(Shell: ).*$/gm, '$1$2<SHELL>'],
  [/^( - )?(OS Version: ).*$/gm, '$1$2<OS_VERSION>'],
  [/^( - )?(Is a git repository: ).*$/gm, '$1$2<IS_GIT_REPO>'],
  [/^(Is directory a git repo: ).*$/gm, '$1<IS_GIT_REPO>'],
]

/**
 * Blank out what varies by machine, and nothing else.
 *
 * The KEYS stay in the text, so a deleted Environment line still fails the
 * comparison — only the values are replaced. Over-normalizing here would turn
 * the snapshot into a test of its own normalizer.
 *
 * Every substitution is anchored on the exact string this machine produced —
 * its checkout path, its home dir, its project slug — rather than on a pattern
 * that blanks whatever sits in that position. A wildcard would also swallow the
 * prompt naming the WRONG directory, which is a thing this snapshot exists to
 * catch.
 */
function normalize(prompt: string): string {
  let out = prompt
    .split(REPO_ROOT)
    .join('<REPO_ROOT>')
    .split(DATA_DIR)
    .join('<DATA_DIR>')
    .split(homedir())
    .join('<HOME>')
    .split(PROJECT_SLUG)
    .join('<PROJECT_SLUG>')
  for (const [re, replacement] of ENV_VALUE_RES) {
    out = out.replace(re, replacement)
  }
  return out
}

function dump(extraArgs: readonly string[]): string {
  const args = ['--dump-system-prompt', '--model', MODEL, ...extraArgs]
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // The addendum family resolves from the ACTIVE PROVIDER
      // (getFamilyAddendum → getAPIProvider), not from the pinned --model.
      // Pin the config dir to an empty stand-in so a developer profile — the
      // glm preset, say — cannot decide which addendum the dump carries; the
      // profile-less default is firstParty → anthropic, which is what CI and
      // a fresh checkout produce too.
      CLAUDIN_CONFIG_DIR: join(DATA_DIR, 'claude-config'),
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
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
