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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
// Empty stand-in config dir for the spawned bundle (see dump() below).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'claudin-snapshot-'))
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const SNAPSHOT_DIR = join(__dirname, '__snapshots__')
// Pinned to the current first-party default so the snapshot characterizes what
// actually ships; bump it with the default, not independently.
const MODEL = 'claude-opus-5-5'

// ~/.claudin/projects/<slug>: sanitizePath() turns every non-alphanumeric byte
// of the cwd into a hyphen, so the checkout path is encoded a SECOND time — in
// a form neither of the two path substitutions below can see. The memory
// section names that directory, so without this the snapshot carries whichever
// absolute path it was generated from.
const PROJECT_SLUG = REPO_ROOT.replace(/[^a-zA-Z0-9]/g, '-')

// The Scratchpad section (on by default since tengu_scratch flipped) names
// `/tmp/claude-<uid>/<slug>/<sessionId>/scratchpad` — src/platform/tmpdir.ts,
// with /tmp realpath-resolved (macOS: /private/tmp). The uid and the realpath
// are this machine's own values, substituted like the paths above; the
// session id is a fresh UUID per dump, so that one segment is matched by
// shape, anchored between the two placeholders. (Not named after the dir's
// `claude-` prefix: envNaming.test.ts treats any CLAUDE_* token as an env
// var name.)
const SESSION_TMP =
  process.platform === 'win32'
    ? join(tmpdir(), 'claude')
    : join(realpathSync('/tmp'), `claude-${process.getuid?.() ?? 0}`)

// The main prompt's Environment block prefixes every line with " - "; the
// sub-agent's <env> block does not, and words two of the keys differently.
// Both render the same machine-specific values, so both need blanking.
const ENV_VALUE_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^( - )?(Platform: ).*$/gm, '$1$2<PLATFORM>'],
  [/^( - )?(Shell: ).*$/gm, '$1$2<SHELL>'],
  [/^( - )?(OS Version: ).*$/gm, '$1$2<OS_VERSION>'],
  [/^( - )?(Is a git repository: ).*$/gm, '$1$2<IS_GIT_REPO>'],
  [/^(Is directory a git repo: ).*$/gm, '$1<IS_GIT_REPO>'],
  [
    /^(`<SESSION_TMP>\/<PROJECT_SLUG>\/)[0-9a-f-]{36}(\/scratchpad`)$/gm,
    '$1<SESSION_ID>$2',
  ],
  // The v2 prompt names the same directory inside an Environment bullet.
  [
    /(Scratchpad directory: <SESSION_TMP>\/<PROJECT_SLUG>\/)[0-9a-f-]{36}(\/scratchpad )/g,
    '$1<SESSION_ID>$2',
  ],
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
    .split(SESSION_TMP)
    .join('<SESSION_TMP>')
  for (const [re, replacement] of ENV_VALUE_RES) {
    out = out.replace(re, replacement)
  }
  return out
}

function dump(
  extraArgs: readonly string[],
  extraEnv: Record<string, string> = {},
  model = MODEL,
): string {
  const args = ['--dump-system-prompt', '--model', model, ...extraArgs]
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
      ...extraEnv,
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

  // The v2 prompt is the default since 2026-09-24; its killswitches restore
  // the text that shipped before. That text keeps its own snapshot for as long
  // as the killswitches exist, so `=0` is reviewed like the default.
  const V2_OFF_ENV = { CLAUDIN_LEAN_SYSTEM_PROMPT: '0', CLAUDIN_LEAN_MEMORY_PROMPT: '0' }

  test('the killswitched (pre-v2) main-session prompt is byte-identical to its snapshot', () => {
    compareOrWrite('systemPrompt.legacy.txt', dump([], V2_OFF_ENV))
  }, 180_000)

  test('the v2 switches do not reach a model outside the Anthropic family', () => {
    // getSystemPrompt applies the v2 text to the Anthropic family only. A
    // first-party session on a non-Claude id resolves to the default family,
    // so the killswitches must change nothing there.
    const other = 'gpt-5'
    expect(dump([], {}, other)).toBe(dump([], V2_OFF_ENV, other))
  }, 180_000)

  test('the snapshots are the flags-ON shape, not a source-side render', () => {
    // The trap this whole file is built around: if someone regenerates the
    // snapshot from source instead of from the bundle, every flag reads false
    // and the steering silently vanishes from the baseline. Each marker below
    // exists ONLY behind a flag that ships true (WORK_CONTRACT,
    // TOOL_BATCHING_NUDGE), so its presence proves the provenance.
    const main = readFileSync(join(SNAPSHOT_DIR, 'systemPrompt.main.txt'), 'utf8')
    expect(main).toContain('When you have enough information to act, act.')
    expect(main).toContain('When a change touches several files, land it as ONE apply_patch')
    const legacy = readFileSync(join(SNAPSHOT_DIR, 'systemPrompt.legacy.txt'), 'utf8')
    expect(legacy).toContain('# Delivering work')
    expect(legacy).toContain('# Corrections')
    expect(legacy).toContain('Batch independent tool calls in a single message')
  })
})
