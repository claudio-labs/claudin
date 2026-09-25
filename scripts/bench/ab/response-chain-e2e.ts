#!/usr/bin/env bun
/**
 * Response-chain E2E — the request-count levers of perf/request-count-levers
 * (each off until promoted, `=1` turns it on), driven through the BUILT bundle
 * (bin/claudin → dist/cli.mjs) by a scripted mock model. Zero real API calls.
 * Plan: .claudin/plans/synchronous-conjuring-creek.md. Scenarios 1-10 are round
 * 1's three levers; 11-13 are round 2's one-call commit and read-only globs (its
 * third, globs in the Read, is read-credit-e2e.ts 6-10).
 *
 * The lever with behavior is CLAUDIN_RESPONSE_CHAINS=1. Its guard
 * (agent/tools/responseChain.ts, wired into runTools in
 * agent/tools/toolOrchestration.ts) follows the calls of one response in the
 * order written. Once a call that is not read-only fails, the Bash, PowerShell
 * and Git calls after it that are not read-only, and every RunTests, Typecheck
 * and Build, come back as `<tool_use_error>Skipped: <desc> failed earlier in this
 * response, so this <Tool> call did not run. Re-send it if it still
 * applies.</tool_use_error>`. Reads and edits still run. The other two levers
 * are prompt text, checked on the wire.
 *
 * The mock answers every /v1/messages POST (ANTHROPIC_BASE_URL) the way
 * read-credit-e2e.ts does, except that a step is a whole response: one reply can
 * carry several tool_use blocks. It keeps no turn counter. A main-loop request
 * whose last user message holds the tool_results of step N gets step N+1; one
 * holding the run's prompt token gets step 1; one holding the run's sub-agent
 * token (the first request of the agent scenario 9 spawns) gets "ok". Anything
 * else (title, side queries) gets "ok" too. The checks read what the CLI sent
 * back in the tool_results — text and is_error, what a model would see — the
 * request bodies, and the workspace on disk after the run.
 *
 * Each workspace is a git repo whose initial commit holds a.ts and b.ts. A run
 * that patches first Reads both files in a response of its own, so a Patch meets
 * its hunk rather than the never-read gate. A run that commits leaves a.ts
 * modified after the initial commit, so a commit that ran would land.
 *
 *   1. chains on  — [Patch a.ts with a hunk the file lacks, Bash `touch ran.txt`]:
 *      the Bash comes back Skipped, is_error, and ran.txt does not exist
 *   2. chains on  — [Patch a.ts adding NEW, Bash `grep -c NEW a.ts > seen.txt`]:
 *      both run, in order: seen.txt reads 1
 *   3. the same response with the flags unset: `then`, on by default, arms the
 *      guard, so the Bash is Skipped; 1's control, every guard off (chains
 *      unset, CLAUDIN_EDIT_THEN=0): the Bash runs and ran.txt exists
 *   4. chains on  — [Bash `exit 3`, Git add a.ts + commit]: the Git is Skipped and
 *      git log is unchanged; its control, every guard off, commits
 *   5. chains on  — [Patch a.ts (bad hunk), Patch b.ts]: the second Patch applies
 *   6. chains on  — [Bash `bun test ./fail.test.ts | tail -5`, Git add + commit].
 *      The Bash output filter strips the trailing tail and runs the base, so the
 *      verdict is the pipeline's 0 and the result is not is_error; the commit
 *      is skipped anyway, on BashTool's `reducedExitCode`. The strip needs the
 *      filter, which is on unless the global config sets
 *      `bashOutputFilterEnabled` (or, for the strip itself,
 *      `bashOutputFilterRewriteEnabled`) to false. The seeded config.json sets
 *      neither, so this runs on the default, and the marker's `exit="1"` proves
 *      the strip happened
 *   7. chains on  — [Bash `exit 3`, Read a.ts, Git `git status`]: the Read and the
 *      read-only Git still run
 *   8. wire, chains on/off — the `# Harness` bullet in the system prompt, and the
 *      git protocol's read step, which travels in messages as the
 *      bash_git_instructions attachment (a <system-reminder>), not in the
 *      system prompt
 *   9. wire, CLAUDIN_SUBAGENT_BATCHING on/off — the Notes in a fresh Code agent's
 *      first request carry the batching note; the main prompt never does
 *  10. wire, CLAUDIN_ONE_PATCH_CHANGE off/on — the Anthropic family addendum,
 *      shown in the off run to be sent on --model, names tests and docs
 *  11. one-call commit on (CLAUDIN_ONE_CALL_COMMIT=1, chains unset) — [Patch a.ts
 *      with a hunk the file lacks, Git add a.ts + commit + status]: the flag arms
 *      the same guard, so the Git comes back Skipped and git log is unchanged; its
 *      control, every guard off, commits
 *  12. wire, CLAUDIN_ONE_CALL_COMMIT on/off — the git protocol (the
 *      bash_git_instructions attachment) says "commit in ONE Git call", and the
 *      chains' # Harness bullet stays out
 *  13. CLAUDIN_READONLY_GLOBS, on by default (the flag unset) and off with `=0`,
 *      under --permission-mode default instead of --dangerously-skip-permissions.
 *      -p has no one to ask, so a call that needs approval is refused: its ask
 *      message comes back as an is_error tool_result, and its id lands in the
 *      result's permission_denials (QueryEngine's wrappedCanUseTool). Unset, Bash
 *      `cat src/*.ts` runs and `cat /etc/*.conf` is still refused by the path
 *      check; with `=0`, `cat src/*.ts` is refused
 *
 * Scenarios 14-19 are round 4's `then` on Patch and Edit (on by default since
 * 2026-09-25, CLAUDIN_EDIT_THEN=0 turns it off; src/tools/shared/editThen/;
 * plan .claudin/plans/harmonic-wobbling-clock.md). Its arms run with the
 * variable unset, as a user does:
 *  14. [Patch a.ts adding NEW, then grep -c NEW a.ts → exit 3 → touch never.txt]:
 *      one tool_result holds the patch summary, the grep's `1` (it saw the
 *      patched file), `exit 3`'s exit code, and the third command as not run
 *  15. [Patch b.ts then `exit 3`, Git add a.ts + commit]: the flag arms the
 *      guard, so the commit is skipped; its control, then `true`, commits
 *  16. --permission-mode acceptEdits: a command that would open a dialog is
 *      dropped — the patch applies and its result says why — while a read-only
 *      one runs
 *  17. a PreToolUse hook in settings.json drops `then` in bypass mode too
 *  18. Edit carries `then` the same way
 *  19. wire, the default and `=0`: `then` in the Patch and Edit schemas and
 *      the Patch description by default; with `=0`, a Patch sending it is
 *      refused by the strict schema and a.ts stays as it was
 *  20. CLAUDIN_GREP_BODIES (src/tools/GrepTool/grepBodies.ts): a symbols Grep
 *      with `bodies: true` returns add()'s body, and a Patch inside it then
 *      applies with no Read; its control, the flag off, sends the same Grep
 *      without `bodies` and the Patch is refused as never read. On the wire,
 *      `bodies` is in the Grep schema only with the flag
 *
 * Isolation, as in read-credit-e2e.ts. Each run gets a fresh workspace and a
 * fresh CLAUDIN_CONFIG_DIR under one temp dir. claudin takes the Anthropic API
 * key from the active provider profile and never from ANTHROPIC_API_KEY, so an
 * empty config dir has no credential at all: the only thing seeded is a
 * config.json with one Anthropic profile holding a fake key and the mock's URL.
 * Nothing of the user's config is read or written, a request that escaped the
 * mock would be refused for its key rather than billed, and the host's
 * CLAUDIN_* / CLAUDE_CODE_* / ANTHROPIC_* variables never reach the child — nor
 * GIT_*, since a GIT_DIR would point a scenario's commit at another repository.
 * The last checks of every scenario read the ids of the model responses the CLI
 * printed: each one is the mock's (msg_e2e_…).
 *
 * Usage:
 *   bun scripts/bench/ab/response-chain-e2e.ts
 *   bun scripts/bench/ab/response-chain-e2e.ts --only=1,6 --keep
 *   bun scripts/bench/ab/response-chain-e2e.ts --bin=/path/to/launcher --model=claude-opus-5-5
 *
 * Prints each tool_result's first 200 chars and one PASS/FAIL line per
 * expectation, and exits 1 on any FAIL. The temp dir — a captures.json of every
 * request per run — is kept on a FAIL or with --keep.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

type Json = Record<string, unknown>

const FLAGS = ['bin', 'model', 'only']
const SWITCHES = ['--keep']
const argv = process.argv.slice(2)
// A typo would otherwise run the defaults and say nothing.
const stray = argv.filter(x => !SWITCHES.includes(x) && !FLAGS.some(name => x.startsWith(`--${name}=`)))
if (stray.length) {
  console.error(`unknown argument ${stray.join(' ')} — flags are ${FLAGS.map(f => `--${f}=…`).join(' ')} ${SWITCHES.join(' ')}`)
  process.exit(2)
}
const flag = (name: string, fallback: string) => argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const DEFAULT_BIN = join(REPO_ROOT, 'bin', 'claudin')
const BIN = flag('bin', DEFAULT_BIN)
const MODEL = flag('model', 'claude-opus-5-5')
const ONLY = new Set(flag('only', '').split(',').map(s => s.trim()).filter(Boolean))
const KEEP = argv.includes('--keep')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
if (BIN === DEFAULT_BIN && !existsSync(BUNDLE)) {
  console.error(`no ${BUNDLE} — the launcher runs the bundle; build it first`)
  process.exit(2)
}

const RUN_TIMEOUT_MS = 150_000
const EXCERPT_CHARS = 200
const MOCK_KEY = 'sk-ant-api03-response-chain-e2e-mock-key'
const PROFILE_ID = 'response-chain-e2e-mock'
/** Every response the mock writes carries an id with this prefix. */
const MOCK_ID_PREFIX = 'msg_e2e_'

// ---------------------------------------------------------------------------
// Workspace and calls
// ---------------------------------------------------------------------------

const A_NAME = "export const NAME = 'alpha'"
const A_NEW = "export const NAME = 'alpha' // NEW"
const B_NAME = "export const NAME = 'beta'"
const B_AFTER = "export const NAME = 'beta-2'"

const FILES: Readonly<Record<string, string>> = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b', '}', '', A_NAME, ''].join('\n'),
  'b.ts': ['export function mul(a: number, b: number): number {', '  return a * b', '}', '', B_NAME, ''].join('\n'),
}
/** Appended to a.ts after the initial commit in a run that commits: what `git add a.ts` stages. */
const PENDING_LINE = 'export const PENDING = true\n'
/** Scenario 6's check: `bun test` exits 1 on it. */
const FAIL_TEST = ["import { expect, test } from 'bun:test'", '', "test('fails on purpose', () => {", '  expect(1).toBe(2)', '})', ''].join('\n')

type Call = { tool: string; input: Json }
/** One scripted response: its tool calls, in the order written, or the closing text. */
type Step = { calls: Call[] } | { text: string }

const patchCall = (file: string, from: string, to: string): Call => ({
  tool: 'Patch',
  input: { patchText: ['*** Begin Patch', `*** Update File: ${file}`, '@@', `-${from}`, `+${to}`, '*** End Patch'].join('\n') },
})
const bashCall = (command: string, description: string): Call => ({ tool: 'Bash', input: { command, description } })
const readCall = (ws: string, file: string): Call => ({ tool: 'Read', input: { file_path: join(ws, file) } })
const gitCall = (...commands: string[]): Call => ({ tool: 'Git', input: { commands } })
const agentCall = (subToken: string): Call => ({
  tool: 'Agent',
  // A fresh agent: naming subagent_type is what keeps it from being a fork,
  // which would inherit the main prompt instead of building its own Notes.
  input: { description: 'Say ok', subagent_type: 'Code', prompt: `Reply with the single word ok. ${subToken}` },
})

/** Its hunk is not in a.ts, so the Patch fails. */
const PATCH_A_BAD = patchCall('a.ts', "export const NAME = 'no-such-line'", "export const NAME = 'never'")
const PATCH_A_NEW = patchCall('a.ts', A_NAME, A_NEW)
const PATCH_B = patchCall('b.ts', B_NAME, B_AFTER)
const TOUCH = bashCall('touch ran.txt', 'Create ran.txt')
const GREP_NEW = bashCall('grep -c NEW a.ts > seen.txt', 'Count NEW in a.ts into seen.txt')
const EXIT_3 = bashCall('exit 3', 'Exit with status 3')
const TEST_TAIL_COMMAND = 'bun test ./fail.test.ts | tail -5'
const TEST_TAIL = bashCall(TEST_TAIL_COMMAND, 'Run the failing test, last 5 lines')
const COMMIT = gitCall('git add a.ts', 'git commit -m x')
const STATUS = gitCall('git status')
/** Stage, commit and status in one Git call: the one-call commit. */
const COMMIT_WITH_STATUS = gitCall('git add a.ts', 'git commit -m x', 'git status')
const READ_BOTH = (ws: string): Step => ({ calls: [readCall(ws, 'a.ts'), readCall(ws, 'b.ts')] })
const DONE: Step = { text: 'Done.' }
/** A Patch with `then` commands (CLAUDIN_EDIT_THEN). */
const withThen = (call: Call, then: string[]): Call => ({ ...call, input: { ...call.input, then } })
const GREP_NEW_COUNT = 'grep -c NEW a.ts'
/** Writes a file with no redirect and no read-only verdict: it asks outside bypass and auto. */
const WRITE_RAN = `bun -e "require('fs').writeFileSync('ran.txt', 'x')"`

const CHAINS_ON: Record<string, string> = { CLAUDIN_RESPONSE_CHAINS: '1' }
const ONE_CALL_COMMIT_ON: Record<string, string> = { CLAUDIN_ONE_CALL_COMMIT: '1' }
const READONLY_GLOBS_OFF: Record<string, string> = { CLAUDIN_READONLY_GLOBS: '0' }
/** `then` is on by default: its arms leave the variable unset. */
const THEN_ON: Record<string, string> = {}
/** `then` off, and with it the guard it arms: what a control needs for "nothing stops the commit". */
const THEN_OFF: Record<string, string> = { CLAUDIN_EDIT_THEN: '0' }
/** Any PreToolUse hook: its presence is what drops `then`. */
const BASH_HOOK_SETTINGS: Json = {
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
}
const THEN_RULE = 'put its test, typecheck or build command in `then`'
const THEN_SKIPPED = '`then` did not run:'
const BODIES_ON: Record<string, string> = { CLAUDIN_GREP_BODIES: '1' }
const grepSymbols = (bodies: boolean): Call => ({
  tool: 'Grep',
  input: { pattern: 'return a \\+ b', output_mode: 'symbols', ...(bodies && { bodies: true }) },
})
const PATCH_ADD_BODY = patchCall('a.ts', '  return a + b', '  return a + b + 0')

/** Scenario 13's src/, which `cat src/*.ts` prints. */
const SRC_ONE = "export const SRC_ONE = 'globbed one'"
const SRC_TWO = "export const SRC_TWO = 'globbed two'"
const SRC_FILES: Readonly<Record<string, string>> = { 'src/one.ts': `${SRC_ONE}\n`, 'src/two.ts': `${SRC_TWO}\n` }
const CAT_SRC = bashCall('cat src/*.ts', 'Print the files in src')
const CAT_ETC = bashCall('cat /etc/*.conf', 'Print the .conf files in /etc')
// What -p hands back for scenario 13's asks: each ask's own message, from the
// read-only fallthrough (bashPermissions/ruleMatching.ts) and the path check
// (BashTool/pathValidation.ts).
const NEEDS_APPROVAL = 'This command requires approval'
const ETC_BLOCKED = "cat in '/etc' was blocked."

// What each lever puts on the wire: prompts.ts (RESPONSE_CHAINS_HARNESS_BULLET,
// getSubagentBatchingNote), BashTool/prompt.ts (getLeanGitInstructionsBody) and
// familyAddendums/anthropic.ts.
const CHAINS_BULLET = 'Calls in one response run in the order written'
const CHAINS_GIT_STEP = 'in the same response as your last check'
const GIT_HEADING = '# Committing changes with git'
const BATCHING_NOTE = 'Independent tool calls go in ONE response'
const PATCH_ADDENDUM = 'land it as ONE Patch call with a section per file'
const ONE_PATCH_SCOPE = 'its tests and docs included'
const ONE_CALL_COMMIT_STEP = 'commit in ONE Git call'

// ---------------------------------------------------------------------------
// Scenarios and expectations
// ---------------------------------------------------------------------------

type RunSpec = {
  label: string
  env: Record<string, string>
  steps: (ctx: { ws: string; subToken: string }) => Step[]
  /** Files added to the workspace's initial commit. */
  files?: Readonly<Record<string, string>>
  /** Leave a.ts modified after the initial commit. */
  pending?: boolean
  /** Run under `--permission-mode <mode>` instead of `--dangerously-skip-permissions`. */
  permissionMode?: 'default' | 'acceptEdits'
  /** Written to the run's config dir as settings.json. */
  settings?: Json
}
type ToolResult = { step: number; index: number; tool: string; text: string; isError: boolean }
type Capture = { route: string; body: Json }
type Run = {
  spec: RunSpec
  dir: string
  ws: string
  configDir: string
  /** In the prompt: marks the main loop's first request. */
  token: string
  /** In scenario 9's Agent prompt: marks the sub-agent's first request. */
  subToken: string
  results: Map<string, ToolResult>
  captures: Capture[]
  exitCode: number | null
  result?: string
  outputTail: string
  /** The tool_use ids in the result event's permission_denials. */
  denials: string[]
  /** The ids of the model responses the CLI printed. */
  modelIds: string[]
}
type Expectation = { label: string; ok: boolean; why?: string }
type Scenario = { key: string; title: string; runs: RunSpec[]; expect: (runs: Run[]) => Expectation[] }

const SKIP_RE = /^<tool_use_error>Skipped: (.+) failed earlier in this response, so this (\S+) call did not run\. Re-send it if it still applies\.<\/tool_use_error>$/
const SKIP_PHRASE = 'failed earlier in this response'
const NOT_READ = 'has not been read yet'

/** The guard's synthetic result, naming `failure` as the call that failed and `tool` as the one skipped. */
function isSkipOf(r: ToolResult, failure: string, tool: string): boolean {
  const m = SKIP_RE.exec(r.text.trim())
  return r.isError && m?.[1] === failure && m[2] === tool
}
/** The call ran and succeeded: no error, and not the guard's skip. */
const ranClean = (r: ToolResult): boolean => !r.isError && !r.text.includes(SKIP_PHRASE)
/** The call ran and failed on its own, not on the guard's skip. */
const failedItself = (r: ToolResult): boolean => r.isError && !r.text.includes(SKIP_PHRASE)
const isPatchSuccess = (r: ToolResult): boolean => !r.isError && r.text.startsWith('Success.')

function resultAt(run: Run, step: number, index: number): ToolResult | undefined {
  return [...run.results.values()].find(r => r.step === step && r.index === index)
}

function onResult(run: Run, step: number, index: number, label: string, test: (r: ToolResult) => boolean): Expectation {
  const full = `${run.spec.label}: ${label}`
  const r = resultAt(run, step, index)
  if (!r) return { label: full, ok: false, why: `no tool_result for response ${step + 1} call ${index + 1} reached the mock` }
  return { label: full, ok: test(r) }
}

/** A check on the workspace; a git that fails is a FAIL naming it, not a crash. */
function onDisk(run: Run, label: string, test: () => { ok: boolean; why?: string }): Expectation {
  const full = `${run.spec.label}: ${label}`
  try {
    return { label: full, ...test() }
  } catch (e) {
    return { label: full, ok: false, why: String(e) }
  }
}

type Which = 'main' | 'subagent'

function onWire(run: Run, which: Which, label: string, test: (body: Json) => boolean): Expectation {
  const full = `${run.spec.label}: ${label}`
  const capture = run.captures.find(c => (which === 'main' ? c.route.startsWith('step 1:') : c.route === 'subagent'))
  if (!capture) return { label: full, ok: false, why: `no ${which === 'main' ? 'main-loop' : 'sub-agent'} first request reached the mock` }
  return { label: full, ok: test(capture.body) }
}

const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

function commitsExpected(run: Run, expected: number, label: string): Expectation {
  return onDisk(run, label, () => {
    const n = commitCount(run.ws)
    return { ok: n === expected, why: `git log holds ${n} commit(s)` }
  })
}

/** Whether the result event's permission_denials names (`named`) the call at response `step`, call `index`. */
function onDenials(run: Run, step: number, index: number, named: boolean, label: string): Expectation {
  const full = `${run.spec.label}: ${label}`
  const id = [...run.results.entries()].find(([, r]) => r.step === step && r.index === index)?.[0]
  if (id === undefined) return { label: full, ok: false, why: `no tool_result for response ${step + 1} call ${index + 1} reached the mock` }
  return { label: full, ok: run.denials.includes(id) === named, why: `permission_denials ${JSON.stringify(run.denials)}` }
}

/** No paid call: every model response the CLI printed is one the mock wrote. */
function servedByMock(run: Run): Expectation {
  const foreign = run.modelIds.filter(id => !id.startsWith(MOCK_ID_PREFIX))
  return {
    label: `${run.spec.label}: every model response the CLI printed came from the mock (ids ${MOCK_ID_PREFIX}…)`,
    ok: run.modelIds.length > 0 && foreign.length === 0,
    why: foreign.length > 0 ? `not the mock's: ${JSON.stringify(foreign)}` : `${run.modelIds.length} response(s)`,
  }
}

const SCENARIOS: Scenario[] = [
  {
    key: '1',
    title: 'a failed Patch skips the Bash behind it',
    runs: [{ label: 'chains on', env: CHAINS_ON, steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, TOUCH] }, DONE] }],
    expect: ([run]) => [
      onResult(run, 1, 0, 'the Patch fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(run, 1, 1, 'the Bash comes back "Skipped: Patch failed earlier in this response, so this Bash call did not run…", is_error', r =>
        isSkipOf(r, 'Patch', 'Bash'),
      ),
      onDisk(run, 'ran.txt does not exist', () => ({ ok: !existsSync(join(run.ws, 'ran.txt')) })),
    ],
  },
  {
    key: '2',
    title: 'a Patch that applies runs the Bash behind it, after it',
    runs: [{ label: 'chains on', env: CHAINS_ON, steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_NEW, GREP_NEW] }, DONE] }],
    expect: ([run]) => [
      onResult(run, 1, 0, 'the Patch applies', isPatchSuccess),
      onResult(run, 1, 1, 'the Bash runs (no error, not skipped)', ranClean),
      onDisk(run, 'seen.txt reads 1: the Bash saw the patched a.ts', () => {
        const seen = readIfExists(join(run.ws, 'seen.txt'))
        return { ok: seen?.trim() === '1', why: `seen.txt ${JSON.stringify(seen ?? '(missing)')}` }
      }),
      onDisk(run, 'a.ts carries NEW on disk', () => ({ ok: readFileSync(join(run.ws, 'a.ts'), 'utf8').includes(A_NEW) })),
    ],
  },
  {
    key: '3',
    title: 'the default arms the guard; the control for 1, every guard off, runs the Bash',
    runs: [
      { label: 'flags unset (then on by default)', env: {}, steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, TOUCH] }, DONE] },
      { label: 'every guard off (chains unset, then =0)', env: THEN_OFF, steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, TOUCH] }, DONE] },
    ],
    expect: ([dflt, run]) => [
      onResult(dflt, 1, 0, 'the Patch fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(dflt, 1, 1, 'the Bash comes back "Skipped: Patch failed earlier… this Bash call…", is_error', r => isSkipOf(r, 'Patch', 'Bash')),
      onDisk(dflt, 'ran.txt does not exist', () => ({ ok: !existsSync(join(dflt.ws, 'ran.txt')) })),
      onResult(run, 1, 0, 'the Patch fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(run, 1, 1, 'the Bash runs: no error, no Skipped text', ranClean),
      onDisk(run, 'ran.txt exists', () => ({ ok: existsSync(join(run.ws, 'ran.txt')) })),
    ],
  },
  {
    key: '4',
    title: 'a failed Bash skips the commit behind it',
    runs: [
      { label: 'chains on', env: CHAINS_ON, pending: true, steps: () => [{ calls: [EXIT_3, COMMIT] }, DONE] },
      // Shows this workspace commits when nothing stops it, so "no commit" above is the skip.
      { label: 'every guard off (control)', env: THEN_OFF, pending: true, steps: () => [{ calls: [EXIT_3, COMMIT] }, DONE] },
    ],
    expect: ([on, off]) => [
      onResult(on, 0, 0, 'Bash `exit 3` fails (is_error)', failedItself),
      onResult(on, 0, 1, 'the Git add + commit comes back "Skipped: Bash(exit 3) failed earlier… this Git call…", is_error', r =>
        isSkipOf(r, 'Bash(exit 3)', 'Git'),
      ),
      commitsExpected(on, 1, 'no commit landed: git log holds the initial commit only'),
      onDisk(on, 'a.ts is still modified and unstaged: not even the `git add` ran', () => {
        const changes = trackedChanges(on.ws)
        return { ok: changes === ' M a.ts', why: `git status --porcelain: ${JSON.stringify(changes)}` }
      }),
      onResult(off, 0, 1, 'the Git add + commit runs', ranClean),
      commitsExpected(off, 2, 'the commit landed'),
    ],
  },
  {
    key: '5',
    title: 'a failed Patch leaves the next Patch running',
    runs: [{ label: 'chains on', env: CHAINS_ON, steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, PATCH_B] }, DONE] }],
    expect: ([run]) => [
      onResult(run, 1, 0, 'the Patch on a.ts fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(run, 1, 1, 'the Patch on b.ts applies', isPatchSuccess),
      onDisk(run, 'b.ts is patched on disk', () => ({ ok: readFileSync(join(run.ws, 'b.ts'), 'utf8').includes(B_AFTER) })),
    ],
  },
  {
    key: '6',
    title: 'a failing `bun test | tail -5` skips the commit, though its result is no error',
    runs: [
      {
        label: 'chains on',
        env: CHAINS_ON,
        pending: true,
        files: { 'fail.test.ts': FAIL_TEST },
        steps: () => [{ calls: [TEST_TAIL, COMMIT] }, DONE],
      },
    ],
    expect: ([run]) => [
      onResult(run, 0, 0, 'the Bash result is not is_error: stripped of its tail, the verdict is the pipeline\'s 0', r => !r.isError),
      onResult(run, 0, 0, 'the tail was stripped: the marker says actual="bun test ./fail.test.ts" and exit="1"', r =>
        r.text.includes('actual="bun test ./fail.test.ts"') && r.text.includes('exit="1"'),
      ),
      onResult(run, 0, 1, `the Git add + commit comes back "Skipped: Bash(${TEST_TAIL_COMMAND}) failed earlier…", is_error`, r =>
        isSkipOf(r, `Bash(${TEST_TAIL_COMMAND})`, 'Git'),
      ),
      commitsExpected(run, 1, 'no commit landed: git log holds the initial commit only'),
    ],
  },
  {
    key: '7',
    title: 'a failed Bash leaves the Read and the read-only Git running',
    runs: [{ label: 'chains on', env: CHAINS_ON, steps: ({ ws }) => [{ calls: [EXIT_3, readCall(ws, 'a.ts'), STATUS] }, DONE] }],
    expect: ([run]) => [
      onResult(run, 0, 0, 'Bash `exit 3` fails (is_error)', failedItself),
      onResult(run, 0, 1, 'the Read of a.ts runs and returns the file', r => ranClean(r) && r.text.includes('export function add')),
      onResult(run, 0, 2, 'the Git `git status` runs', ranClean),
    ],
  },
  {
    key: '8',
    title: 'wire: the # Harness bullet and the git protocol\'s read step',
    runs: [
      { label: 'chains on', env: CHAINS_ON, steps: () => [DONE] },
      { label: 'chains off', env: {}, steps: () => [DONE] },
    ],
    expect: ([on, off]) => [
      onWire(on, 'main', `the system prompt carries "${CHAINS_BULLET}"`, b => systemText(b).includes(CHAINS_BULLET)),
      onWire(on, 'main', `the git instructions carry "${CHAINS_GIT_STEP}"`, b => gitInstructions(b)?.includes(CHAINS_GIT_STEP) === true),
      onWire(off, 'main', 'the git instructions travel in messages (bash_git_instructions), not in the system prompt', b =>
        gitInstructions(b) !== undefined && !systemText(b).includes(GIT_HEADING),
      ),
      onWire(off, 'main', `the request carries neither "${CHAINS_BULLET}" nor "${CHAINS_GIT_STEP}"`, b => {
        const all = JSON.stringify(b)
        return !all.includes(CHAINS_BULLET) && !all.includes(CHAINS_GIT_STEP)
      }),
    ],
  },
  {
    key: '9',
    title: 'wire: the batching note in a fresh sub-agent\'s Notes',
    runs: [
      { label: 'batching on', env: { CLAUDIN_SUBAGENT_BATCHING: '1' }, steps: ({ subToken }) => [{ calls: [agentCall(subToken)] }, DONE] },
      { label: 'batching off', env: {}, steps: ({ subToken }) => [{ calls: [agentCall(subToken)] }, DONE] },
    ],
    expect: ([on, off]) => [
      onResult(on, 0, 0, 'the Code agent finishes (its Agent result is no error)', r => !r.isError),
      onWire(on, 'subagent', `the sub-agent's first request carries "${BATCHING_NOTE}" in its system prompt`, b =>
        systemText(b).includes(BATCHING_NOTE),
      ),
      onWire(on, 'main', 'the main loop\'s system prompt does not', b => !systemText(b).includes(BATCHING_NOTE)),
      onResult(off, 0, 0, 'the Code agent finishes (its Agent result is no error)', r => !r.isError),
      onWire(off, 'subagent', `the sub-agent's first request has its Notes but not "${BATCHING_NOTE}"`, b =>
        systemText(b).includes('Notes:') && !JSON.stringify(b).includes(BATCHING_NOTE),
      ),
    ],
  },
  {
    key: '10',
    title: 'wire: tests and docs in the Anthropic addendum\'s ONE Patch',
    runs: [
      { label: 'one-patch off', env: {}, steps: () => [DONE] },
      { label: 'one-patch on', env: { CLAUDIN_ONE_PATCH_CHANGE: '1' }, steps: () => [DONE] },
    ],
    expect: ([off, on]) => [
      onWire(off, 'main', `the Anthropic family addendum is sent on ${MODEL} ("${PATCH_ADDENDUM}")`, b =>
        systemText(b).includes(PATCH_ADDENDUM),
      ),
      onWire(off, 'main', `the request does not carry "${ONE_PATCH_SCOPE}"`, b => !JSON.stringify(b).includes(ONE_PATCH_SCOPE)),
      onWire(on, 'main', `the system prompt carries "${ONE_PATCH_SCOPE}"`, b => systemText(b).includes(ONE_PATCH_SCOPE)),
    ],
  },
  {
    key: '11',
    title: 'one-call commit: a failed Patch skips the commit in its response',
    runs: [
      {
        label: 'one-call commit on',
        env: ONE_CALL_COMMIT_ON,
        pending: true,
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, COMMIT_WITH_STATUS] }, DONE],
      },
      // Shows this workspace commits when nothing stops it, so "no commit" above is the skip.
      {
        label: 'every guard off (control)',
        env: THEN_OFF,
        pending: true,
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [PATCH_A_BAD, COMMIT_WITH_STATUS] }, DONE],
      },
    ],
    expect: ([on, off]) => [
      onResult(on, 1, 0, 'the Patch fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(on, 1, 1, 'the Git add + commit + status comes back "Skipped: Patch failed earlier… this Git call…", is_error', r =>
        isSkipOf(r, 'Patch', 'Git'),
      ),
      commitsExpected(on, 1, 'no commit landed: git log holds the initial commit only'),
      onDisk(on, 'a.ts is still modified and unstaged: not even the `git add` ran', () => {
        const changes = trackedChanges(on.ws)
        return { ok: changes === ' M a.ts', why: `git status --porcelain: ${JSON.stringify(changes)}` }
      }),
      onResult(off, 1, 0, 'the Patch fails on its hunk (is_error)', r => failedItself(r) && !r.text.includes(NOT_READ)),
      onResult(off, 1, 1, 'the Git add + commit + status runs', ranClean),
      commitsExpected(off, 2, 'the commit landed'),
    ],
  },
  {
    key: '12',
    title: 'wire: the one-call commit in the git protocol',
    runs: [
      { label: 'one-call commit on', env: ONE_CALL_COMMIT_ON, steps: () => [DONE] },
      { label: 'one-call commit off', env: {}, steps: () => [DONE] },
    ],
    expect: ([on, off]) => [
      onWire(on, 'main', `the git instructions (bash_git_instructions, in messages) carry "${ONE_CALL_COMMIT_STEP}"`, b =>
        gitInstructions(b)?.includes(ONE_CALL_COMMIT_STEP) === true && !systemText(b).includes(ONE_CALL_COMMIT_STEP),
      ),
      onWire(on, 'main', `the chains' # Harness bullet stays out: the request does not carry "${CHAINS_BULLET}"`, b =>
        !JSON.stringify(b).includes(CHAINS_BULLET),
      ),
      onWire(off, 'main', `the git instructions are sent, and the request does not carry "${ONE_CALL_COMMIT_STEP}"`, b =>
        gitInstructions(b) !== undefined && !JSON.stringify(b).includes(ONE_CALL_COMMIT_STEP),
      ),
    ],
  },
  {
    key: '13',
    title: 'default permission mode: a path glob in a read command (CLAUDIN_READONLY_GLOBS, on by default)',
    runs: [
      {
        label: 'read-only globs, the default',
        env: {},
        permissionMode: 'default',
        files: SRC_FILES,
        steps: () => [{ calls: [CAT_SRC] }, { calls: [CAT_ETC] }, DONE],
      },
      // The same command with the killswitch: its glob costs the read-only verdict.
      { label: 'read-only globs off (=0, control)', env: READONLY_GLOBS_OFF, permissionMode: 'default', files: SRC_FILES, steps: () => [{ calls: [CAT_SRC] }, DONE] },
    ],
    expect: ([on, off]) => [
      onResult(on, 0, 0, 'Bash `cat src/*.ts` runs: its result holds both files', r =>
        !r.isError && r.text.includes(SRC_ONE) && r.text.includes(SRC_TWO),
      ),
      onDenials(on, 0, 0, false, '… and permission_denials does not name it'),
      onResult(on, 1, 0, `Bash \`cat /etc/*.conf\` is still refused by the path check: "${ETC_BLOCKED}…", is_error`, r =>
        r.isError && r.text.startsWith(ETC_BLOCKED),
      ),
      onDenials(on, 1, 0, true, '… as a permission denial: permission_denials names it'),
      onResult(off, 0, 0, `Bash \`cat src/*.ts\` is refused: "${NEEDS_APPROVAL}", is_error, nothing printed`, r =>
        r.isError && r.text.includes(NEEDS_APPROVAL) && !r.text.includes(SRC_ONE),
      ),
      onDenials(off, 0, 0, true, '… as a permission denial: permission_denials names it'),
    ],
  },
  {
    key: '14',
    title: 'then: the checks run after the patch, in order, and stop at the first that fails',
    runs: [
      {
        label: 'then on',
        env: THEN_ON,
        steps: ({ ws }) => [
          READ_BOTH(ws),
          { calls: [withThen(PATCH_A_NEW, [GREP_NEW_COUNT, 'exit 3', 'touch never.txt'])] },
          DONE,
        ],
      },
    ],
    expect: ([run]) => [
      onResult(run, 1, 0, 'the Patch applies, and its result is not is_error though a check failed', isPatchSuccess),
      onResult(run, 1, 0, `the grep ran after the write: "$ ${GREP_NEW_COUNT}" then 1`, r => r.text.includes(`$ ${GREP_NEW_COUNT}\n1`)),
      onResult(run, 1, 0, '`exit 3` ran and its exit code is reported', r => r.text.includes('$ exit 3') && r.text.includes('Exit code 3')),
      onResult(run, 1, 0, 'the third command is reported as not run', r =>
        r.text.includes('Not run, an earlier command failed: $ touch never.txt'),
      ),
      onDisk(run, 'never.txt does not exist', () => ({ ok: !existsSync(join(run.ws, 'never.txt')) })),
      onDisk(run, 'a.ts carries NEW on disk', () => ({ ok: readFileSync(join(run.ws, 'a.ts'), 'utf8').includes(A_NEW) })),
    ],
  },
  {
    key: '15',
    title: 'then: a red check skips the commit in its response; a green one lets it land',
    runs: [
      {
        label: 'then on, red check',
        env: THEN_ON,
        pending: true,
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_B, ['exit 3']), COMMIT] }, DONE],
      },
      {
        label: 'then on, green check (control)',
        env: THEN_ON,
        pending: true,
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_B, ['true']), COMMIT] }, DONE],
      },
    ],
    expect: ([red, green]) => [
      onResult(red, 1, 0, 'the Patch applies and reports Exit code 3', r => isPatchSuccess(r) && r.text.includes('Exit code 3')),
      onResult(red, 1, 1, 'the Git add + commit comes back "Skipped: Patch failed earlier… this Git call…", is_error', r =>
        isSkipOf(r, 'Patch', 'Git'),
      ),
      commitsExpected(red, 1, 'no commit landed: git log holds the initial commit only'),
      onResult(green, 1, 1, 'the Git add + commit runs', ranClean),
      commitsExpected(green, 2, 'the commit landed'),
    ],
  },
  {
    key: '16',
    title: 'then under acceptEdits: a command that would prompt is dropped, a read-only one runs',
    runs: [
      {
        label: 'then on, a command that asks',
        env: THEN_ON,
        permissionMode: 'acceptEdits',
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_A_NEW, [WRITE_RAN])] }, DONE],
      },
      {
        label: 'then on, a read-only command',
        env: THEN_ON,
        permissionMode: 'acceptEdits',
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_A_NEW, [GREP_NEW_COUNT])] }, DONE],
      },
    ],
    expect: ([asks, readOnly]) => [
      onResult(asks, 1, 0, 'the Patch applies', isPatchSuccess),
      onResult(asks, 1, 0, `its result says "${THEN_SKIPPED} … would need a permission prompt"`, r =>
        r.text.includes(THEN_SKIPPED) && r.text.includes('would need a permission prompt'),
      ),
      onDisk(asks, 'ran.txt does not exist', () => ({ ok: !existsSync(join(asks.ws, 'ran.txt')) })),
      onDisk(asks, 'a.ts carries NEW on disk', () => ({ ok: readFileSync(join(asks.ws, 'a.ts'), 'utf8').includes(A_NEW) })),
      onResult(readOnly, 1, 0, `the read-only check runs: "$ ${GREP_NEW_COUNT}" then 1`, r =>
        isPatchSuccess(r) && r.text.includes(`$ ${GREP_NEW_COUNT}\n1`),
      ),
    ],
  },
  {
    key: '17',
    title: 'then: a configured PreToolUse hook drops it, in bypass mode too',
    runs: [
      {
        label: 'then on, a Bash hook configured',
        env: THEN_ON,
        settings: BASH_HOOK_SETTINGS,
        steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_A_NEW, ['touch ran.txt'])] }, DONE],
      },
    ],
    expect: ([run]) => [
      onResult(run, 1, 0, 'the Patch applies', isPatchSuccess),
      onResult(run, 1, 0, `its result says "${THEN_SKIPPED} a PreToolUse or PostToolUse hook is configured…"`, r =>
        r.text.includes(`${THEN_SKIPPED} a PreToolUse or PostToolUse hook is configured`),
      ),
      onDisk(run, 'ran.txt does not exist', () => ({ ok: !existsSync(join(run.ws, 'ran.txt')) })),
    ],
  },
  {
    key: '18',
    title: 'then on Edit',
    runs: [
      {
        label: 'then on',
        env: THEN_ON,
        steps: ({ ws }) => [
          { calls: [readCall(ws, 'a.ts')] },
          {
            calls: [
              { tool: 'Edit', input: { file_path: join(ws, 'a.ts'), old_string: A_NAME, new_string: A_NEW, then: [GREP_NEW_COUNT] } },
            ],
          },
          DONE,
        ],
      },
    ],
    expect: ([run]) => [
      onResult(run, 1, 0, `the Edit applies and its result carries "$ ${GREP_NEW_COUNT}" then 1`, r =>
        !r.isError && r.text.includes('has been updated successfully') && r.text.includes(`$ ${GREP_NEW_COUNT}\n1`),
      ),
    ],
  },
  {
    key: '19',
    title: 'wire: `then` by default, and not with =0',
    runs: [
      { label: 'then off (=0)', env: THEN_OFF, steps: ({ ws }) => [READ_BOTH(ws), { calls: [withThen(PATCH_A_NEW, ['true'])] }, DONE] },
      { label: 'then, the default', env: THEN_ON, steps: () => [DONE] },
    ],
    expect: ([off, on]) => [
      onWire(off, 'main', 'Patch and Edit have no `then` in their schemas, and the Patch description does not name it', b =>
        !hasThenField(b, 'Patch') && !hasThenField(b, 'Edit') && !toolDescription(b, 'Patch').includes(THEN_RULE),
      ),
      onResult(off, 1, 0, 'a Patch sending `then` is refused by the strict schema (is_error)', r => r.isError && r.text.includes('then')),
      onDisk(off, 'a.ts is as committed', () => ({ ok: readFileSync(join(off.ws, 'a.ts'), 'utf8') === FILES['a.ts'] })),
      onWire(on, 'main', 'Patch and Edit carry `then` in their schemas', b => hasThenField(b, 'Patch') && hasThenField(b, 'Edit')),
      onWire(on, 'main', `the Patch description says "${THEN_RULE}"`, b => toolDescription(b, 'Patch').includes(THEN_RULE)),
    ],
  },
  {
    key: '20',
    title: 'Grep bodies: the body a symbols search shows counts as read',
    runs: [
      { label: 'bodies on', env: BODIES_ON, steps: () => [{ calls: [grepSymbols(true)] }, { calls: [PATCH_ADD_BODY] }, DONE] },
      { label: 'bodies off (control)', env: {}, steps: () => [{ calls: [grepSymbols(false)] }, { calls: [PATCH_ADD_BODY] }, DONE] },
    ],
    expect: ([on, off]) => [
      onResult(on, 0, 0, 'the Grep returns add() with its body, under the bodies header', r =>
        !r.isError && r.text.includes(', with their bodies') && r.text.includes('return a + b'),
      ),
      onResult(on, 1, 0, 'the Patch inside add() applies with no Read', isPatchSuccess),
      onDisk(on, 'a.ts carries the change', () => ({ ok: readFileSync(join(on.ws, 'a.ts'), 'utf8').includes('return a + b + 0') })),
      onWire(on, 'main', 'the Grep schema carries `bodies`', b => grepHasBodies(b)),
      onResult(off, 0, 0, 'the Grep returns the signature only', r => !r.isError && !r.text.includes('with their bodies')),
      onResult(off, 1, 0, `the Patch is refused: "${NOT_READ}"`, r => r.isError && r.text.includes(NOT_READ)),
      onWire(off, 'main', 'the Grep schema has no `bodies`', b => !grepHasBodies(b)),
    ],
  },
]

// ---------------------------------------------------------------------------
// Mock model
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function blocksOf(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function toolResultText(block: Json): string {
  return blocksOf(block.content)
    .filter(b => b.type === 'text')
    .map(b => String(b.text ?? ''))
    .join('\n')
}

function systemText(body: Json): string {
  return blocksOf(body.system)
    .filter(b => b.type === 'text')
    .map(b => String(b.text ?? ''))
    .join('\n')
}

/** The bash_git_instructions attachment: the text block in messages that opens the git protocol. */
function gitInstructions(body: Json): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
  return messages
    .flatMap(m => blocksOf(m.content))
    .map(b => (b.type === 'text' ? String(b.text ?? '') : ''))
    .find(text => text.includes(GIT_HEADING))
}

/** The main loop and a sub-agent send the tool pool; titles and other side queries send none. */
const isMainLoop = (body: Json): boolean => Array.isArray(body.tools) && body.tools.length > 5

function toolOf(body: Json, name: string): Json | undefined {
  return (Array.isArray(body.tools) ? body.tools.filter(isRecord) : []).find(t => t.name === name)
}

function hasThenField(body: Json, name: string): boolean {
  const schema = toolOf(body, name)?.input_schema
  return isRecord(schema) && isRecord(schema.properties) && 'then' in schema.properties
}

const toolDescription = (body: Json, name: string): string => String(toolOf(body, name)?.description ?? '')

function grepHasBodies(body: Json): boolean {
  const schema = toolOf(body, 'Grep')?.input_schema
  return isRecord(schema) && isRecord(schema.properties) && 'bodies' in schema.properties
}

let counter = 0

function frame(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: `${MOCK_ID_PREFIX}${++counter}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return (
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }) +
    frame('message_stop', { type: 'message_stop' })
  )
}

function textReply(text: string): string {
  return (
    messageStart() +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    messageEnd('end_turn')
  )
}

type ToolUse = { id: string; name: string; input: Json }

/** One response carrying every call of the step, one content block each, in order. */
function toolUsesReply(uses: ToolUse[]): string {
  const blocks = uses.map(
    (use, index) =>
      frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: use.id, name: use.name, input: {} } }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(use.input) },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index }),
  )
  return messageStart() + blocks.join('') + messageEnd('tool_use')
}

type Active = { run: Run; steps: Step[] }
type Issued = { run: Run; step: number; index: number; tool: string }

let active: Active | null = null
const issued = new Map<string, Issued>()

/**
 * The reply to one request, and how it was routed. A main-loop request whose last
 * user message answers tool_uses this run issued gets the step after theirs, and
 * each tool_result is recorded; one carrying the sub-agent token is the spawned
 * agent's, and gets "ok"; one carrying the prompt token gets the first step.
 * Anything else is a side request.
 */
function route(body: Json): { sse: string; route: string } {
  const side = { sse: textReply('ok'), route: 'side' }
  if (!active || !isMainLoop(body)) return side
  const { run, steps } = active
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
  const blocks = blocksOf(messages.findLast(m => m.role === 'user')?.content)
  let next: number | undefined
  for (const block of blocks) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const from = issued.get(block.tool_use_id)
    if (!from || from.run !== run) continue
    run.results.set(block.tool_use_id, {
      step: from.step,
      index: from.index,
      tool: from.tool,
      text: toolResultText(block),
      isError: block.is_error === true,
    })
    next = Math.max(next ?? 0, from.step + 1)
  }
  if (next === undefined) {
    const said = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
    if (said.includes(run.subToken)) return { sse: textReply('ok'), route: 'subagent' }
    if (!said.includes(run.token)) return side
    next = 0
  }
  const at = next
  const where = `step ${at + 1}`
  const step = steps[at]
  if (!step) return { sse: textReply('ok'), route: `${where}: past the script` }
  if ('text' in step) return { sse: textReply(step.text), route: `${where}: text` }
  const uses = step.calls.map((call, index): ToolUse => {
    const id = `toolu_e2e_${String(issued.size + 1).padStart(3, '0')}`
    issued.set(id, { run, step: at, index, tool: call.tool })
    return { id, name: call.tool, input: call.input }
  })
  return { sse: toolUsesReply(uses), route: `${where}: ${uses.map(u => u.name).join(' + ')}` }
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = req.url ?? ''
    if (path.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 100 }))
      return
    }
    if (req.method !== 'POST' || !path.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Json = {}
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (isRecord(parsed)) body = parsed
    } catch (e) {
      console.error(`mock: unparseable request body on ${path}: ${e}`)
    }
    const reply = route(body)
    active?.run.captures.push({ route: reply.route, body })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(reply.sse)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

// ---------------------------------------------------------------------------
// Workspace, config and the CLI
// ---------------------------------------------------------------------------

/** Stripped from the host env: the session running this script leaks its own. */
const HOST_ENV_RE = /^(?:CLAUDECODE$|CLAUDE_CODE_|_?CLAUDIN_|ANTHROPIC_|GIT_)/
/** A GIT_DIR or GIT_WORK_TREE would point git at another repository. */
const GIT_ENV_RE = /^GIT_/

function hostEnv(drop: RegExp): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !drop.test(k)) env[k] = v
  }
  return env
}

function git(ws: string, args: string[]): string {
  const out = spawnSync('git', args, { cwd: ws, env: hostEnv(GIT_ENV_RE), encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} in ${ws} exited ${out.status}: ${out.stderr.trim()}`)
  return out.stdout
}

const commitCount = (ws: string): number => Number(git(ws, ['rev-list', '--count', 'HEAD']).trim())
const trackedChanges = (ws: string): string => git(ws, ['status', '--porcelain', '--untracked-files=no']).trimEnd()

function makeWorkspace(ws: string, spec: RunSpec): void {
  mkdirSync(ws, { recursive: true })
  for (const [name, content] of Object.entries({ ...FILES, ...spec.files })) {
    mkdirSync(dirname(join(ws, name)), { recursive: true })
    writeFileSync(join(ws, name), content)
  }
  git(ws, ['init', '-q', '-b', 'main'])
  // A local identity, no signing and no hooks: a commit nothing stops has to land.
  git(ws, ['config', 'user.name', 'response-chain e2e'])
  git(ws, ['config', 'user.email', 'e2e@example.invalid'])
  git(ws, ['config', 'commit.gpgsign', 'false'])
  git(ws, ['config', 'core.hooksPath', join(ws, '.git', 'no-hooks')])
  git(ws, ['add', '-A'])
  git(ws, ['commit', '-q', '-m', 'initial'])
  if (spec.pending) appendFileSync(join(ws, 'a.ts'), PENDING_LINE)
}

/** The one credential claudin needs: an Anthropic profile, pointed at the mock, with a fake key. */
function seedConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const profile = { id: PROFILE_ID, name: 'response-chain e2e mock', provider: 'anthropic', baseUrl: BASE_URL, model: MODEL, apiKey: MOCK_KEY }
  const config = { providerProfiles: [profile], activeProviderProfileId: PROFILE_ID, hasCompletedOnboarding: true }
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2))
}

function childEnv(configDir: string, flags: Record<string, string>): Record<string, string> {
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  return {
    ...hostEnv(HOST_ENV_RE),
    CLAUDIN_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: BASE_URL,
    // A localhost base URL otherwise flips the CLI into its non-first-party shape.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...flags,
  }
}

function runCli(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // Async spawn: the mock shares this process, and spawnSync would starve it.
    const child = spawn(BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += String(d)))
    child.stderr.on('data', d => (stderr += String(d)))
    const kill = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS)
    child.on('error', e => (stderr += String(e)))
    child.on('close', code => {
      clearTimeout(kill)
      resolve({ code, stdout, stderr })
    })
  })
}

function jsonLines(text: string): Json[] {
  return text.split('\n').flatMap(line => {
    try {
      const parsed: unknown = JSON.parse(line)
      return isRecord(parsed) ? [parsed] : []
    } catch {
      return [] // a progress line or a partial write, not an event
    }
  })
}

const COMMON = ['--model', MODEL, '--output-format', 'stream-json', '--verbose']

async function runOne(s: Scenario, spec: RunSpec, n: number, root: string): Promise<Run> {
  const slug = `${s.key}-${n + 1}`
  const dir = join(root, `scenario-${slug}`)
  const run: Run = {
    spec,
    dir,
    ws: join(dir, 'workspace'),
    configDir: join(dir, 'config'),
    token: `[e2e ${slug}]`,
    subToken: `[e2e-subagent ${slug}]`,
    results: new Map(),
    captures: [],
    exitCode: null,
    outputTail: '',
    denials: [],
    modelIds: [],
  }
  makeWorkspace(run.ws, spec)
  seedConfig(run.configDir)
  if (spec.settings) writeFileSync(join(run.configDir, 'settings.json'), JSON.stringify(spec.settings, null, 2))
  active = { run, steps: spec.steps({ ws: run.ws, subToken: run.subToken }) }
  const permission = spec.permissionMode ? ['--permission-mode', spec.permissionMode] : ['--dangerously-skip-permissions']
  const out = await runCli(['-p', `Run the scripted steps. ${run.token}`, ...COMMON, ...permission], run.ws, childEnv(run.configDir, spec.env))
  active = null
  const events = jsonLines(out.stdout)
  const result = events.findLast(e => e.type === 'result')
  run.exitCode = out.code
  run.result = result ? `${String(result.subtype)}, num_turns ${String(result.num_turns)}` : undefined
  run.outputTail = (out.stderr || out.stdout).slice(-400)
  const denials = result?.permission_denials
  run.denials = Array.isArray(denials) ? denials.filter(isRecord).map(d => String(d.tool_use_id)) : []
  run.modelIds = events.flatMap(e => (e.type === 'assistant' ? [isRecord(e.message) ? String(e.message.id) : '(no message)'] : []))
  writeFileSync(join(dir, 'captures.json'), JSON.stringify(run.captures, null, 1))
  return run
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(s: Scenario, runs: Run[]): Expectation[] {
  console.log(`\n== ${s.key}. ${s.title}`)
  for (const run of runs) {
    const flags = Object.entries(run.spec.env).map(([k, v]) => `${k}=${v}`)
    const mode = run.spec.permissionMode ? `, --permission-mode ${run.spec.permissionMode}` : ''
    const main = run.captures.filter(c => c.route.startsWith('step ')).length
    const sub = run.captures.filter(c => c.route === 'subagent').length
    console.log(
      `  ${run.spec.label} (${flags.length ? flags.join(' ') : 'flags unset'}${mode}): exit ${run.exitCode}, result ${run.result ?? 'none'} — ` +
        `the mock answered ${main} main-loop, ${sub} sub-agent and ${run.captures.length - main - sub} side request(s)`,
    )
    if (run.exitCode !== 0 || !run.result) console.log(`    output tail: ${JSON.stringify(run.outputTail)}`)
    const results = [...run.results.values()].sort((x, y) => x.step - y.step || x.index - y.index)
    for (const r of results) {
      const at = `${r.step + 1}.${r.index + 1}`
      console.log(`    ${at} ${r.tool.padEnd(5)} is_error=${String(r.isError).padEnd(5)} ${JSON.stringify(r.text.slice(0, EXCERPT_CHARS))}`)
    }
  }
  const checks = [...s.expect(runs), ...runs.map(servedByMock)]
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.why ? ` — ${c.why}` : ''}`)
  return checks
}

const unknownKeys = [...ONLY].filter(k => !SCENARIOS.some(s => s.key === k))
if (unknownKeys.length) {
  server.close()
  console.error(`unknown scenario ${unknownKeys.join(',')} — the keys are ${SCENARIOS.map(s => s.key).join(',')}`)
  process.exit(2)
}
const chosen = SCENARIOS.filter(s => ONLY.size === 0 || ONLY.has(s.key))
const root = mkdtempSync(join(tmpdir(), 'response-chain-e2e-'))
const built = BIN === DEFAULT_BIN ? `, bundle built ${statSync(BUNDLE).mtime.toISOString()}` : ''
console.log(`${BIN} — ${MODEL}${built}; mock ${BASE_URL}; scratch ${root}`)

const checks: Expectation[] = []
try {
  for (const s of chosen) {
    const runs: Run[] = []
    for (const [n, spec] of s.runs.entries()) runs.push(await runOne(s, spec, n, root))
    checks.push(...report(s, runs))
  }
} finally {
  server.close()
}
const failed = checks.filter(c => !c.ok).length
console.log(`\n${checks.length - failed} PASS, ${failed} FAIL`)
if (failed === 0 && !KEEP) rmSync(root, { recursive: true, force: true })
else console.log(`kept ${root} (captures.json per run)`)
process.exit(failed === 0 ? 0 : 1)
