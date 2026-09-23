#!/usr/bin/env bun
/**
 * Delegation steering A/B — does a change to the text that steers delegation
 * (the Agent tool description in `src/tools/AgentTool/prompt.ts`, the system
 * prompt's delegation lane in `src/agent/prompts/prompts.ts`) move WHEN
 * claudin delegates, and HOW: fork or fresh agent, `readOnly`, which agent type?
 *
 * The other agent benches (`fork-vs-fresh-ab.ts`, `fork-gate-ab.ts`,
 * `slim-code-agent-ab.ts`) tell the model which agent to launch, so they measure
 * the mechanism. Here no prompt mentions agents: the model decides, and the
 * decision is what a steering change moves. It matters for cost because a fork
 * re-reads the parent's context on every call — measured at ~4x a fresh agent
 * (team memory `fork-vs-fresh-ab-2026-09-09`) — so a text change that shifts the
 * fork/fresh mix can cost far more than the shorter text saves.
 *
 * The workload is 7 questions about THIS repo, one headless `-p` session each,
 * so every decision starts from the same small context:
 *  - 5 multi-hop questions, each needing more than 3 dependent searches (trace
 *    a value from a flag to its effect, follow a name through three slices, find
 *    what gates a feature);
 *  - 2 directed lookups (one named function, one named file) as controls that
 *    should not be delegated.
 * Every answer key below was derived by reading the code at ANSWER_SHA and is
 * graded by required substrings (function names, file names, one computed name).
 * Each key carries the source lines it came from, and `--dry-run` re-checks them.
 *
 * Protocol:
 *  - Target: a throwaway clone of this repo at `--sha` (default ANSWER_SHA),
 *    cached under /tmp/delegation-steer-ab/, with no remote and branch `main`.
 *    Every session runs in a fresh `cp -a` of it that is deleted afterwards —
 *    never in the live checkout, where a headless session is keyed to the
 *    user's own project dir (team memory `headless-c-resumes-current-session`).
 *  - Arms: `baseline` is this checkout's `bin/claudin` (it runs dist/cli.mjs);
 *    each `--variant=<label>:<ENV>=<value>[,<ENV>=<value>]` is the same binary
 *    with those variables set — session-cache-ab's convention.
 *  - Model and effort are pinned, permissions are bypassed and background tasks
 *    are off (agent-safety.md §5), exactly as in session-cache-ab. The host
 *    session's CLAUDECODE / CLAUDE_CODE_* / CLAUDIN_* variables are stripped
 *    (CLAUDIN_CONFIG_DIR is kept), so each arm starts as from a clean terminal.
 *  - The arms of a rep run CONCURRENTLY; within an arm the questions run in
 *    order. The arms' tool blocks differ, so neither warms the other's cache.
 *  - Delegation is read from the parent transcript's Agent tool_use inputs: no
 *    `subagent_type` is a fork, a named type is a fresh agent. Cost is the
 *    parent plus every sub-agent transcript (`forkBench.loadSession` drops the
 *    history a fork inherits), priced at the model's own tier; the CLI's
 *    `total_cost_usd` is shown beside it as a cross-check.
 *  - Per arm, each rep's 7 sessions reduce to one row. The report gives the
 *    median [min–max] over reps and calls a difference SEPARATED only when the
 *    ranges do not overlap. The plan's pre-registered gates close the report.
 *
 * Usage:
 *   bun scripts/bench/ab/delegation-steer-ab.ts --dry-run       # clone + graders + plumbing, no tokens
 *   bun scripts/bench/ab/delegation-steer-ab.ts --reps=5 --variant=agentlean:CLAUDIN_LEAN_AGENT_PROMPT=1
 *   bun scripts/bench/ab/delegation-steer-ab.ts --only=agentlean --variant=agentlean:CLAUDIN_LEAN_AGENT_PROMPT=1
 *   bun scripts/bench/ab/delegation-steer-ab.ts --replay=/tmp/delegation-steer-ab/<stamp>/results.json
 *   bun scripts/bench/ab/delegation-steer-ab.ts --replay=a/results.json@before,b/results.json@after \
 *     --only=baseline@before,agentlean@after
 *
 * Other flags: --model (claude-opus-5-5), --effort (high), --sha (ANSWER_SHA),
 * --sequential, --max-turns (80, main thread), --budget (5, USD per session,
 * passed as --max-budget-usd), --timeout-min (20 per session).
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { REPO_ROOT } from '../../repoRoot'
import { cost, loadSession, priceFor, range, rangesOverlap, type Price } from './forkBench.ts'
import { runHeadless, transcriptPath, type HeadlessRun } from './headlessProbe.ts'

/** 'baseline', or the label of a --variant. */
type Arm = string
const BASELINE: Arm = 'baseline'
const BENCH_ROOT = '/tmp/delegation-steer-ab'
/** The commit every answer key below was derived at, by reading the code. */
const ANSWER_SHA = '632611d758abf9926e9aa4720892deb1f84758f5'
/** Legacy name included: a transcript from before the rename says Task. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const WEB_RESEARCHER_RE = /^WebResearcher/
/** Session prompts must not steer: none of these words may appear in one. */
const STEERING_WORD_RE = /\b(agents?|sub-?agents?|delegat\w*|fork\w*|parallel\w*|tasks?)\b/i

// ---------------------------------------------------------------------------
// Workload — every key derived by hand from the code at ANSWER_SHA
// ---------------------------------------------------------------------------

type Kind = 'multihop' | 'control'
type Needle = string | RegExp
/** One required element of an answer; any one of the alternatives satisfies it. */
type Item = { label: string; anyOf: Needle[] }
/** A line in the clone that the key rests on (`absent`: must NOT be there). */
type Evidence = { path: string; text: string; absent?: true }
type Question = {
  id: string
  kind: Kind
  prompt: string
  items: Item[]
  evidence: Evidence[]
  /** Passes the grader. */
  reference: string
  /** Plausible, wrong on exactly one item, and must fail. */
  wrong: string
}

const ASK = "Just answer, don't change any files."
const item = (label: string, ...anyOf: Needle[]): Item => ({ label, anyOf })
const at = (path: string, text: string): Evidence => ({ path, text })
const notAt = (path: string, text: string): Evidence => ({ path, text, absent: true })

const QUESTIONS: Question[] = [
  {
    id: 'm1-budget',
    kind: 'multihop',
    prompt:
      'When claudin runs headless with `--max-budget-usd`, what actually stops the run once the budget is spent? ' +
      'Trace it from the flag to the stop: the file and the condition that end the run, the result `subtype` it reports, ' +
      'the function that accumulates the spend that condition compares against (and which API calls feed it), and whether ' +
      `the model itself is ever told how much budget is left — if so, through what. ${ASK}`,
    items: [
      item('QueryEngine', 'QueryEngine'),
      item('error_max_budget_usd', 'error_max_budget_usd'),
      item('addToTotalSessionCost', 'addToTotalSessionCost', 'addToTotalCostState'),
      // `\b` so that `error_max_budget_usd` alone does not satisfy it.
      item('budget_usd attachment', /\bbudget_usd\b/, 'getMaxBudgetUsdAttachment'),
    ],
    evidence: [
      at('src/agent/QueryEngine.ts', 'getTotalCost() >= maxBudgetUsd'),
      at('src/agent/QueryEngine.ts', "subtype: 'error_max_budget_usd'"),
      at('src/agent/cost-tracker.ts', 'getTotalCostUSD as getTotalCost'),
      at('src/agent/cost-tracker.ts', 'export function addToTotalSessionCost('),
      at('src/platform/bootstrap/state/cost.ts', 'STATE.totalCostUSD += cost'),
      at('src/providers/shims/claude/streaming.ts', 'addToTotalSessionCost('),
      at('src/agent/attachments/injections.ts', 'export function getMaxBudgetUsdAttachment('),
      at('src/agent/attachments/pipeline.ts', "maybe('budget_usd'"),
      at('src/agent/messages/attachments.ts', "case 'budget_usd':"),
    ],
    reference:
      'The stop is in src/agent/QueryEngine.ts: after each message it checks `maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd` ' +
      'and yields a result with subtype `error_max_budget_usd`. getTotalCost is getTotalCostUSD (platform/bootstrap/state/cost.ts), ' +
      'incremented by addToTotalSessionCost in src/agent/cost-tracker.ts, which the Anthropic streaming shim calls for every API response. ' +
      'The model is told: getMaxBudgetUsdAttachment adds a `budget_usd` attachment on main-thread turns, rendered as a ' +
      'system-reminder "USD budget: $used/$total; $remaining remaining".',
    wrong:
      'src/agent/QueryEngine.ts checks getTotalCost() >= maxBudgetUsd after each message and yields subtype error_max_budget_usd; ' +
      'the spend is summed by addToTotalSessionCost in cost-tracker.ts. The model is never told how much budget is left.',
  },
  {
    id: 'm2-mcp',
    kind: 'multihop',
    prompt:
      'Say an MCP server is configured under the name `my.server` and exposes a tool named `do stuff`. What exact tool name ' +
      'does the model see for it, and how is that name built: which function sanitizes the server and tool names, and which ' +
      "function assigns the name when the server's tools are fetched? And if a user wants one permission rule that allows " +
      `every tool of that server, what rule string works, and which function decides that the rule covers this tool? ${ASK}`,
    items: [
      item('mcp__my_server__do_stuff', 'mcp__my_server__do_stuff'),
      item('normalizeNameForMCP', 'normalizeNameForMCP'),
      item('fetchToolsForClient', 'fetchToolsForClient', 'fetchCapabilities'),
      item('toolMatchesRule', 'toolMatchesRule'),
    ],
    evidence: [
      at('src/mcp/client/fetchCapabilities.ts', 'export const fetchToolsForClient = memoizeWithLRU('),
      at('src/mcp/client/fetchCapabilities.ts', 'const fullyQualifiedName = buildMcpToolName(client.name, tool.name)'),
      at('src/mcp/mcpStringUtils.ts', 'return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`'),
      at('src/mcp/mcpStringUtils.ts', 'return `mcp__${normalizeNameForMCP(serverName)}__`'),
      at('src/mcp/normalization.ts', "let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')"),
      at('src/permissions/permissions/ruleLookup.ts', 'function toolMatchesRule('),
      at('src/permissions/permissions/ruleLookup.ts', "(ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&"),
    ],
    reference:
      'The model sees `mcp__my_server__do_stuff`. fetchToolsForClient (src/mcp/client/fetchCapabilities.ts) names each tool with ' +
      'buildMcpToolName(client.name, tool.name) = getMcpPrefix(server) + normalizeNameForMCP(tool) (src/mcp/mcpStringUtils.ts); ' +
      "normalizeNameForMCP (src/mcp/normalization.ts) replaces every character outside [a-zA-Z0-9_-] with '_', so my.server -> my_server " +
      'and do stuff -> do_stuff. The rule `mcp__my_server` (or `mcp__my_server__*`) covers it: toolMatchesRule in ' +
      'src/permissions/permissions/ruleLookup.ts parses both with mcpInfoFromString and matches when the rule has no tool part and the servers agree.',
    wrong:
      'The model sees `mcp__my.server__do stuff`: fetchToolsForClient builds it with buildMcpToolName, and normalizeNameForMCP only ' +
      'lowercases it. A `mcp__my.server` rule is matched by toolMatchesRule.',
  },
  {
    id: 'c1-cache-price',
    kind: 'control',
    prompt:
      "In `src/providers/usage/modelCost.ts`, which field of a model's cost tier prices 1-hour cache writes, and what does " +
      `the code use when a tier leaves that field out? ${ASK}`,
    items: [
      item('promptCacheWrite1hTokens', 'promptCacheWrite1hTokens'),
      item('promptCacheWriteTokens', 'promptCacheWriteTokens'),
    ],
    evidence: [at('src/providers/usage/modelCost.ts', 'modelCosts.promptCacheWrite1hTokens ?? modelCosts.promptCacheWriteTokens')],
    reference:
      '`promptCacheWrite1hTokens`; tokensToUSDCost falls back to `promptCacheWriteTokens` (the 5-minute write price) when a tier omits it.',
    wrong: '`promptCacheWrite1hTokens`; when a tier omits it, the write is priced at inputTokens.',
  },
  {
    id: 'm3-hook',
    kind: 'multihop',
    prompt:
      'A PreToolUse hook prints JSON with `hookSpecificOutput.additionalContext`. Trace how that string ends up in front of the ' +
      "model: which function parses the hook's stdout and extracts the additionalContext, which function turns it into a message " +
      'during a tool call (and with what attachment type), and which function renders that attachment into the text sent to the ' +
      `API — how is the text wrapped? ${ASK}`,
    items: [
      item('processHookJSONOutput', 'processHookJSONOutput'),
      item('runPreToolUseHooks', 'runPreToolUseHooks'),
      item('hook_additional_context', 'hook_additional_context'),
      item('normalizeAttachmentForAPI', 'normalizeAttachmentForAPI'),
      item('system-reminder', 'system-reminder', 'wrapInSystemReminder'),
    ],
    evidence: [
      at('src/platform/lifecycleHooks/parsing.ts', 'export function processHookJSONOutput('),
      at('src/platform/lifecycleHooks/parsing.ts', 'result.additionalContext = json.hookSpecificOutput.additionalContext'),
      at('src/platform/lifecycleHooks/executeHooks.ts', 'additionalContexts: [result.additionalContext]'),
      at('src/agent/tools/toolHooks.ts', 'export async function* runPreToolUseHooks('),
      at('src/agent/tools/toolHooks.ts', "type: 'hook_additional_context',"),
      at('src/agent/messages/attachments.ts', 'export function normalizeAttachmentForAPI('),
      at('src/agent/messages/attachments.ts', 'hook additional context: ${attachment.content.join('),
    ],
    reference:
      'parseHookOutput detects the JSON and processHookJSONOutput (src/platform/lifecycleHooks/parsing.ts) copies ' +
      "hookSpecificOutput.additionalContext into the hook's result; executeHooks collects it into additionalContexts, which " +
      'executePreToolHooks yields. runPreToolUseHooks (src/agent/tools/toolHooks.ts) wraps them in a `hook_additional_context` ' +
      'attachment. normalizeAttachmentForAPI (src/agent/messages/attachments.ts) renders it as a meta user message through ' +
      'wrapInSystemReminder("PreToolUse:<tool> hook additional context: ...") — inside <system-reminder> tags.',
    wrong:
      'processHookJSONOutput extracts it, runPreToolUseHooks turns it into a hook_success attachment, and normalizeAttachmentForAPI ' +
      'renders it inside <system-reminder> tags.',
  },
  {
    id: 'm4-command',
    kind: 'multihop',
    prompt:
      'A teammate adds `.claudin/commands/deploy/staging.md` to this repo. What does a user type to run it, and how does the file ' +
      'become that command? Name the function that discovers command files on disk, the function that derives the command name ' +
      `from the nested folder, and the function that replaces \`$ARGUMENTS\` in the file's body when the command runs. ${ASK}`,
    items: [
      item('deploy:staging', 'deploy:staging'),
      item('loadSkillsFromCommandsDir', 'loadSkillsFromCommandsDir', 'loadMarkdownFilesForSubdir'),
      item('getRegularCommandName', 'getRegularCommandName', 'buildNamespace'),
      item('substituteArguments', 'substituteArguments'),
    ],
    evidence: [
      at('src/memory/instructions/markdownConfigLoader.ts', "const claudeSubdir = join(current, '.claudin', subdir)"),
      at('src/skills/loadSkillsDir.ts', "const markdownFiles = await loadMarkdownFilesForSubdir('commands', cwd)"),
      at('src/skills/loadSkillsDir.ts', 'function getRegularCommandName(filePath: string, baseDir: string): string {'),
      at('src/skills/loadSkillsDir.ts', "return relativePath ? relativePath.split(pathSep).join(':') : ''"),
      at('src/skills/loadSkillsDir.ts', 'finalContent = substituteArguments('),
      at('src/commands/argumentSubstitution.ts', 'export function substituteArguments('),
    ],
    reference:
      "It runs as `/deploy:staging`. loadSkillsFromCommandsDir (src/skills/loadSkillsDir.ts) gets the files from loadMarkdownFilesForSubdir('commands', cwd), " +
      'which walks .claudin/commands from the cwd up to the git root; getRegularCommandName strips `.md` and prefixes ' +
      "buildNamespace(dir, baseDir), which joins the sub-folders with ':'. createSkillCommand's getPromptForCommand calls " +
      'substituteArguments (src/commands/argumentSubstitution.ts) to replace $ARGUMENTS, $ARGUMENTS[n] and $n.',
    wrong:
      'It runs as `/deploy/staging`: loadSkillsFromCommandsDir finds it, getRegularCommandName keeps the folder path, and ' +
      'substituteArguments fills in $ARGUMENTS.',
  },
  {
    id: 'c2-window',
    kind: 'control',
    prompt: `Where is \`getEffectiveContextWindowSize\` defined, and which environment variable can shrink the window it returns? ${ASK}`,
    items: [item('autoCompact.ts', 'autoCompact.ts'), item('CLAUDIN_AUTO_COMPACT_WINDOW', 'CLAUDIN_AUTO_COMPACT_WINDOW')],
    evidence: [
      at('src/agent/compact/autoCompact.ts', 'export function getEffectiveContextWindowSize(model: string): number {'),
      at('src/agent/compact/autoCompact.ts', 'const autoCompactWindow = process.env.CLAUDIN_AUTO_COMPACT_WINDOW'),
    ],
    reference:
      "In src/agent/compact/autoCompact.ts. CLAUDIN_AUTO_COMPACT_WINDOW caps the model's context window before the summary reservation is subtracted.",
    wrong: 'In src/agent/compact/autoCompact.ts; CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE shrinks it.',
  },
  {
    id: 'm5-keybind',
    kind: 'multihop',
    prompt:
      'I added a custom binding to `~/.claudin/keybindings.json` and it has no effect at all. Find out why by tracing how claudin ' +
      'loads keybindings and resolves a key press: which function reads that file, what decides whether it is read at all (the ' +
      "function and the flag key it checks), where that flag's value comes from on disk, and which function resolves a key press " +
      `against the loaded bindings. ${ASK}`,
    items: [
      item('loadKeybindings', 'loadKeybindings'),
      item('isKeybindingCustomizationEnabled', 'isKeybindingCustomizationEnabled'),
      item('keybinding_customization_release', 'keybinding_customization_release'),
      item('feature-flags.json', 'feature-flags.json'),
      item('resolveKeyWithChordState', 'resolveKeyWithChordState'),
    ],
    evidence: [
      at('src/terminal/keybindings/loadUserBindings.ts', "return join(getClaudinConfigHomeDir(), 'keybindings.json')"),
      at('src/terminal/keybindings/loadUserBindings.ts', 'if (!isKeybindingCustomizationEnabled()) {'),
      at('src/terminal/keybindings/loadUserBindings.ts', "'tengu_keybinding_customization_release',"),
      at('src/platform/analytics/growthbook.ts', "join(homedir(), '.claudin', 'feature-flags.json')"),
      // Off by default: the fork's own defaults do not turn it on.
      notAt('src/platform/analytics/growthbook.ts', 'tengu_keybinding_customization_release'),
      at('src/terminal/keybindings/resolver.ts', 'export function resolveKeyWithChordState('),
      at('src/terminal/keybindings/KeybindingProviderSetup.tsx', 'resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current)'),
    ],
    reference:
      'loadKeybindings / loadKeybindingsSyncWithWarnings (src/terminal/keybindings/loadUserBindings.ts) read ~/.claudin/keybindings.json, ' +
      'but only once isKeybindingCustomizationEnabled() is true; otherwise they return the defaults. That gate reads the flag ' +
      '`tengu_keybinding_customization_release` (default false) through getFeatureValue_CACHED_MAY_BE_STALE, which ' +
      'src/platform/analytics/growthbook.ts resolves from ~/.claudin/feature-flags.json (or CLAUDE_FEATURE_FLAGS_FILE); it is not in ' +
      'OPEN_BUILD_DEFAULTS, so it is off. When on, user bindings follow the defaults and resolveKeyWithChordState (resolver.ts) ' +
      'takes the last exact match, so the user binding wins.',
    wrong:
      'loadKeybindings in loadUserBindings.ts reads the file, but isKeybindingCustomizationEnabled() gates it on the flag ' +
      'tengu_keybinding_customization_release, which comes from ~/.claudin/settings.json; key presses are matched in resolveKeyWithChordState.',
  },
]
const QUESTION_BY_ID = new Map(QUESTIONS.map(q => [q.id, q]))

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/** A model that escapes markdown writes `mcp\_\_my\_server`. */
const MD_ESCAPE_RE = /\\([_*`[\]])/g

type Grade = { correct: boolean; hit: number; of: number; missing: string[] }

function grade(q: Question | undefined, text: string): Grade {
  if (!q) return { correct: false, hit: 0, of: 0, missing: ['(question not in this answer key)'] }
  const t = text.replace(MD_ESCAPE_RE, '$1')
  const has = (n: Needle) => (typeof n === 'string' ? t.includes(n) : n.test(t))
  const missing = q.items.filter(i => !i.anyOf.some(has)).map(i => i.label)
  return { correct: missing.length === 0 && t.trim() !== '', hit: q.items.length - missing.length, of: q.items.length, missing }
}

function checkEvidence(root: string, q: Question): string[] {
  const fails: string[] = []
  for (const e of q.evidence) {
    let text: string
    try {
      text = readFileSync(join(root, e.path), 'utf8')
    } catch {
      fails.push(`${e.path} missing`)
      continue
    }
    if (text.includes(e.text) === Boolean(e.absent)) {
      fails.push(`${e.path} ${e.absent ? 'contains' : 'lacks'} "${e.text.slice(0, 60)}"`)
    }
  }
  return fails
}

// ---------------------------------------------------------------------------
// Target — a clone at the pinned SHA, and one fresh copy per session
// ---------------------------------------------------------------------------

/**
 * `headlessProbe.transcriptPath` and `forkBench.loadSession` map a cwd to its
 * project dir by replacing `/` only; claudin's `sanitizePath` replaces every
 * non-alphanumeric character. The two agree only on a path made of these.
 */
const SAFE_PATH_RE = /^[A-Za-z0-9/-]+$/

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.status === 0 ? '' : (r.stderr ?? '')}` }
}

function cloneIsPristine(dir: string, commit: string): boolean {
  return (
    git(dir, 'rev-parse', 'HEAD').out.trim() === commit &&
    git(dir, 'symbolic-ref', '--short', 'HEAD').out.trim() === 'main' &&
    git(dir, 'status', '--porcelain').out.trim() === '' &&
    git(dir, 'remote').out.trim() === ''
  )
}

/** A clone of this repo at `sha`, cached per SHA. Sessions only ever run in copies of it. */
function ensureClone(sha: string): { dir: string; sha: string } {
  const resolved = git(REPO_ROOT, 'rev-parse', '--verify', `${sha}^{commit}`)
  if (!resolved.ok) throw new Error(`--sha ${sha} is not a commit in ${REPO_ROOT}: ${resolved.out.trim()}`)
  const commit = resolved.out.trim()
  const dir = join(BENCH_ROOT, `repo-${commit.slice(0, 12)}`)
  if (existsSync(dir) && cloneIsPristine(dir, commit)) return { dir, sha: commit }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(BENCH_ROOT, { recursive: true })
  const steps: Array<[string, string[]]> = [
    [BENCH_ROOT, ['clone', '--quiet', '--no-checkout', REPO_ROOT, dir]],
    // A global core.hooksPath would otherwise run the host's hooks on checkout.
    [dir, ['config', 'core.hooksPath', '.git/no-hooks']],
    [dir, ['checkout', '--quiet', '-B', 'main', commit]],
    // No remote, so nothing in a session can lead back to the live checkout.
    [dir, ['remote', 'remove', 'origin']],
  ]
  for (const [cwd, args] of steps) {
    const r = git(cwd, ...args)
    if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.out.trim()}`)
  }
  // The clone also made a branch for the live checkout's HEAD; only `main` stays.
  for (const branch of git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').out.split('\n')) {
    if (branch.trim() && branch.trim() !== 'main') git(dir, 'branch', '-D', branch.trim())
  }
  if (!cloneIsPristine(dir, commit)) throw new Error(`${dir} is not a clean checkout of ${commit}`)
  return { dir, sha: commit }
}

/** `cp -a` keeps the clone's mtimes, so Glob's newest-first order is the same in every copy. */
function makeWorkspace(clone: string, ws: string): string {
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(dirname(ws), { recursive: true })
  const r = spawnSync('cp', ['-a', clone, ws], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cp -a ${clone} ${ws}: ${r.stderr}`)
  const real = realpathSync(ws)
  if (!SAFE_PATH_RE.test(real)) throw new Error(`workspace ${real} has characters the transcript lookup would mangle`)
  return real
}

// ---------------------------------------------------------------------------
// Arms and environment
// ---------------------------------------------------------------------------

/**
 * `runHeadless` spreads `process.env` into the child, so the host session's
 * own variables are removed from it here, once: CLAUDECODE and CLAUDE_CODE_*
 * change how a CLI classifies itself, and a CLAUDIN_* setting of the host is a
 * choice an arm launched from a terminal would not have.
 */
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

function scrubHostEnv(): string[] {
  const removed = Object.keys(process.env).filter(k => HOST_ENV_RE.test(k))
  for (const k of removed) delete process.env[k]
  return removed.sort()
}

/** session-cache-ab's `armEnv`, minus the host strip that `scrubHostEnv` already did. */
function armEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // `-p` drains auto-backgrounded work non-deterministically, and an orphaned
    // task takes its tokens with it (agent-safety.md §5).
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  }
}

/** After the prompt, where `runHeadless` puts `extraArgs`. It already passes `--permission-mode bypassPermissions`. */
function cliFlags(a: Args): string[] {
  return [
    '--effort',
    a.effort,
    '--max-turns',
    String(a.maxTurns),
    '--max-budget-usd',
    String(a.budgetUsd),
    '--dangerously-skip-permissions',
  ]
}

const slug = (arm: Arm): string => arm.replace(/[^A-Za-z0-9]/g, '-')

// ---------------------------------------------------------------------------
// Pricing — forkBench's table, corrected for Opus 5.5
// ---------------------------------------------------------------------------

/**
 * `forkBench.priceFor` matches `/opus-5/` first, which bills Opus 5.5 at Opus
 * 5's 5/25 with a 0.5 cache read. Opus 5.5 is COST_TIER_4_20
 * (src/providers/usage/modelCost.ts), the row session-cache-ab uses.
 */
const OPUS_5_5_RE = /opus-5-5/
const OPUS_5_5: Price = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }

function priceOf(model: string): Price {
  return OPUS_5_5_RE.test(model) ? OPUS_5_5 : priceFor(model).price
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const blocksOf = (content: unknown): Json[] => (Array.isArray(content) ? content.filter(isRecord) : [])

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .map(b => (typeof b.text === 'string' ? b.text : ''))
    .join('')
}

type Scan = {
  /** Distinct `message.model` values, in order of appearance. */
  models: string[]
  uses: Array<{ id: string; name: string; input: Json }>
  results: Map<string, { isError: boolean; text: string }>
}

/** The tool_use inputs `forkBench.loadSession` does not keep, plus each file's model. */
function scanTranscript(path: string): Scan {
  const scan: Scan = { models: [], uses: [], results: new Map() }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return scan
  }
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let v: Json
    try {
      v = JSON.parse(line) as Json
    } catch {
      continue
    }
    if (v.isSidechain === true || !isRecord(v.message)) continue
    const m = v.message
    if (v.type === 'assistant') {
      const model = typeof m.model === 'string' ? m.model : ''
      if (model && model !== '<synthetic>' && !scan.models.includes(model)) scan.models.push(model)
      for (const b of blocksOf(m.content)) {
        if (b.type !== 'tool_use' || typeof b.id !== 'string' || seen.has(b.id)) continue
        seen.add(b.id)
        scan.uses.push({ id: b.id, name: String(b.name ?? ''), input: isRecord(b.input) ? b.input : {} })
      }
    } else if (v.type === 'user') {
      for (const b of blocksOf(m.content)) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || scan.results.has(b.tool_use_id)) continue
        scan.results.set(b.tool_use_id, { isError: b.is_error === true, text: contentText(b.content) })
      }
    }
  }
  return scan
}

type AgentUse = {
  /** fork = no `subagent_type`; fresh = a named type; invalid = an empty type, which AgentTool rejects. */
  kind: 'fork' | 'fresh' | 'invalid'
  type: string
  readOnly: boolean
  model: string | null
  description: string
  promptChars: number
  isError: boolean
  resultHead: string
}

type Child = { agentType: string; description: string; calls: number; model: string; costUsd: number }

type SessionResult = {
  arm: Arm
  rep: number
  qid: string
  kind: Kind
  sessionId: string
  exitCode: number | null
  wallMs: number
  finalText: string
  cliCostUsd: number
  stderrTail: string
  model: string
  /** Main-thread API calls. */
  turns: number
  parentCostUsd: number
  children: Child[]
  subagentCalls: number
  subagentCostUsd: number
  /** Parent + every sub-agent, from the transcripts. */
  costUsd: number
  /** Main-thread tool calls by name. */
  tools: Record<string, number>
  agentUses: AgentUse[]
  /** `git status --porcelain` of the workspace after the session. */
  dirty: string
  transcript: string | null
}

function toAgentUse(use: Scan['uses'][number], result: { isError: boolean; text: string } | undefined): AgentUse {
  const t = use.input.subagent_type
  const kind = t === undefined || t === null ? 'fork' : typeof t === 'string' && t.trim() ? 'fresh' : 'invalid'
  return {
    kind,
    type: kind === 'fresh' ? String(t) : kind,
    readOnly: use.input.readOnly === true,
    model: typeof use.input.model === 'string' ? use.input.model : null,
    description: String(use.input.description ?? ''),
    promptChars: String(use.input.prompt ?? '').length,
    isError: result?.isError ?? false,
    resultHead: (result?.text ?? '').slice(0, 200),
  }
}

type SessionInput = {
  arm: Arm
  rep: number
  q: Question
  ws: string
  run: HeadlessRun
  wallMs: number
  dirty: string
  fallbackModel: string
}

function analyze(x: SessionInput): SessionResult {
  const sid = x.run.sessionId
  const parentPath = sid ? transcriptPath(x.ws, sid) : ''
  const scan = sid ? scanTranscript(parentPath) : scanTranscript('')
  const session = sid ? loadSession(x.ws, sid) : { parent: [], children: [] }
  const model = scan.models[0] ?? x.fallbackModel
  const subagentDir = join(dirname(parentPath), sid, 'subagents')
  const children: Child[] = session.children.map(c => {
    const childModel = scanTranscript(join(subagentDir, `agent-${c.agentId}.jsonl`)).models[0] ?? model
    return {
      agentType: c.agentType,
      description: c.description,
      calls: c.calls.length,
      model: childModel,
      costUsd: cost(c.calls, priceOf(childModel)).total,
    }
  })
  const tools: Record<string, number> = {}
  for (const u of scan.uses) tools[u.name] = (tools[u.name] ?? 0) + 1
  const parentCostUsd = cost(session.parent, priceOf(model)).total
  const subagentCostUsd = children.reduce((a, c) => a + c.costUsd, 0)
  return {
    arm: x.arm,
    rep: x.rep,
    qid: x.q.id,
    kind: x.q.kind,
    sessionId: sid,
    exitCode: x.run.exitCode,
    wallMs: x.wallMs,
    finalText: x.run.finalText,
    cliCostUsd: x.run.totalCostUsd,
    stderrTail: x.run.stderr.trim().split('\n').slice(-5).join('\n'),
    model,
    turns: session.parent.length,
    parentCostUsd,
    children,
    subagentCalls: children.reduce((a, c) => a + c.calls, 0),
    subagentCostUsd,
    costUsd: parentCostUsd + subagentCostUsd,
    tools,
    agentUses: scan.uses.filter(u => AGENT_TOOLS.has(u.name)).map(u => toAgentUse(u, scan.results.get(u.id))),
    dirty: x.dirty,
    transcript: null,
  }
}

/** The parent transcript and its sub-agents, copied into the run dir before the workspace goes. */
function archive(ws: string, sessionId: string, dest: string): string | null {
  if (!sessionId) return null
  const src = transcriptPath(ws, sessionId)
  if (!existsSync(src)) return null
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, `${dest}.jsonl`)
  const subagents = join(dirname(src), sessionId, 'subagents')
  if (existsSync(subagents)) cpSync(subagents, `${dest}.subagents`, { recursive: true })
  return `${dest}.jsonl`
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Args = {
  reps: number
  only: Arm[] | null
  sequential: boolean
  model: string
  effort: string
  sha: string
  maxTurns: number
  budgetUsd: number
  timeoutMs: number
  dryRun: boolean
  replay: string
  bin: string
  /** Extra environment per arm; `{}` for the baseline. */
  env: Record<Arm, Record<string, string>>
  variants: Arm[]
}

type Meta = {
  started: string
  runDir: string
  model: string
  effort: string
  /** The clone's commit, and the one the answer key was derived at. */
  sha: string
  answerSha: string
  maxTurns: number
  budgetUsd: number
  reps: number
  arms: Arm[]
  questions: string[]
  versions: Record<Arm, string>
  armEnv: Record<Arm, Record<string, string>>
  /** Names only: the host variables stripped before any arm ran. */
  hostEnvRemoved: string[]
}

type Saved = { meta: Meta; sessions: SessionResult[] }

type RunContext = { args: Args; runDir: string; clone: string }

function toolSummary(tools: Record<string, number>): string {
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(' ')
}

function agentSummary(uses: AgentUse[]): string {
  if (!uses.length) return '-'
  return uses.map(u => `${u.type}${u.readOnly ? '(ro)' : ''}${u.model ? `[${u.model}]` : ''}${u.isError ? '(err)' : ''}`).join(' + ')
}

async function runSession(arm: Arm, rep: number, q: Question, ctx: RunContext): Promise<SessionResult> {
  const label = `${slug(arm)}-r${rep}-${q.id}`
  const ws = makeWorkspace(ctx.clone, join(ctx.runDir, 'ws', label))
  const t0 = performance.now()
  const run = await runHeadless({
    bin: ctx.args.bin,
    model: ctx.args.model,
    cwd: ws,
    prompt: q.prompt,
    env: armEnv(ctx.args.env[arm]),
    timeoutMs: ctx.args.timeoutMs,
    extraArgs: cliFlags(ctx.args),
  })
  const wallMs = performance.now() - t0
  const dirty = git(ws, 'status', '--porcelain').out.trim()
  const result = analyze({ arm, rep, q, ws, run, wallMs, dirty, fallbackModel: ctx.args.model })
  result.transcript = archive(ws, run.sessionId, join(ctx.runDir, 'transcripts', label))
  rmSync(ws, { recursive: true, force: true })
  const g = grade(q, result.finalText)
  console.log(
    `[${arm} r${rep} ${q.id}] ${result.turns} turns, Agent: ${agentSummary(result.agentUses)}, ` +
      `sub-agent calls ${result.subagentCalls}, graded ${g.hit}/${g.of}${g.correct ? '' : ' MISS'}, ` +
      `$${result.costUsd.toFixed(3)} (CLI $${result.cliCostUsd.toFixed(3)}), ${(wallMs / 1000).toFixed(0)}s` +
      (result.exitCode === null ? ' (TIMED OUT)' : result.exitCode ? ` (exit ${result.exitCode})` : ''),
  )
  return result
}

async function runArmRep(arm: Arm, rep: number, ctx: RunContext, onSession: (s: SessionResult) => void): Promise<void> {
  for (const q of QUESTIONS) onSession(await runSession(arm, rep, q, ctx))
}

// ---------------------------------------------------------------------------
// Reduction — one row per arm and rep
// ---------------------------------------------------------------------------

type RepRow = {
  multiDelegated: number
  delegationRate: number
  multiForked: number
  agentCalls: number
  forkShare: number | null
  freshShare: number | null
  readOnlyShare: number | null
  controlsDelegated: number
  webResearcher: number
  correct: number
  correctMulti: number
  correctControl: number
  costUsd: number
  subagentCostUsd: number
  cliCostUsd: number
  turns: number
  subagentCalls: number
  parentToolCalls: number
  wallSec: number
  noAnswer: number
}

const N_MULTI = QUESTIONS.filter(q => q.kind === 'multihop').length
const N_CONTROL = QUESTIONS.length - N_MULTI

function repRow(sessions: SessionResult[]): RepRow {
  const multi = sessions.filter(s => s.kind === 'multihop')
  const controls = sessions.filter(s => s.kind === 'control')
  const uses = sessions.flatMap(s => s.agentUses)
  const share = (n: number) => (uses.length ? (100 * n) / uses.length : null)
  const correct = (ss: SessionResult[]) => ss.filter(s => grade(QUESTION_BY_ID.get(s.qid), s.finalText).correct).length
  const sum = (f: (s: SessionResult) => number) => sessions.reduce((a, s) => a + f(s), 0)
  const multiDelegated = multi.filter(s => s.agentUses.length > 0).length
  return {
    multiDelegated,
    delegationRate: multi.length ? (100 * multiDelegated) / multi.length : 0,
    multiForked: multi.filter(s => s.agentUses.some(u => u.kind === 'fork')).length,
    agentCalls: uses.length,
    forkShare: share(uses.filter(u => u.kind === 'fork').length),
    freshShare: share(uses.filter(u => u.kind === 'fresh').length),
    readOnlyShare: share(uses.filter(u => u.readOnly).length),
    controlsDelegated: controls.filter(s => s.agentUses.length > 0).length,
    webResearcher: uses.filter(u => WEB_RESEARCHER_RE.test(u.type)).length,
    correct: correct(sessions),
    correctMulti: correct(multi),
    correctControl: correct(controls),
    costUsd: sum(s => s.costUsd),
    subagentCostUsd: sum(s => s.subagentCostUsd),
    cliCostUsd: sum(s => s.cliCostUsd),
    turns: sum(s => s.turns),
    subagentCalls: sum(s => s.subagentCalls),
    parentToolCalls: sum(s => Object.values(s.tools).reduce((a, n) => a + n, 0)),
    wallSec: sum(s => s.wallMs) / 1000,
    noAnswer: sessions.filter(s => !s.finalText.trim()).length,
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(' | ')} |`
  return [line(headers), `|${widths.map(w => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)].join('\n')
}

const fmtUsd = (n: number): string => `$${n.toFixed(3)}`
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** An even rep count gives a count metric a .5 median; rounding it away would misreport it. */
const fmtNum = (n: number, digits: number): string => n.toFixed(digits === 0 && !Number.isInteger(n) ? 1 : digits)

/** [label, key, decimals, how the delta is shown] */
type MetricRow = [string, keyof RepRow, number, 'abs' | 'rel']

const METRIC_ROWS: MetricRow[] = [
  [`multi-hop delegated (of ${N_MULTI})`, 'multiDelegated', 0, 'abs'],
  ['delegation rate, multi-hop (%)', 'delegationRate', 0, 'abs'],
  [`multi-hop answered with a fork (of ${N_MULTI})`, 'multiForked', 0, 'abs'],
  ['Agent calls, all questions', 'agentCalls', 0, 'abs'],
  ['  fork share (%)', 'forkShare', 0, 'abs'],
  ['  fresh share (%)', 'freshShare', 0, 'abs'],
  ['  readOnly share (%)', 'readOnlyShare', 0, 'abs'],
  [`controls delegated (of ${N_CONTROL})`, 'controlsDelegated', 0, 'abs'],
  ['WebResearcher* on a code question', 'webResearcher', 0, 'abs'],
  [`correct answers (of ${QUESTIONS.length})`, 'correct', 0, 'abs'],
  [`  multi-hop (of ${N_MULTI})`, 'correctMulti', 0, 'abs'],
  [`  controls (of ${N_CONTROL})`, 'correctControl', 0, 'abs'],
  ['cost incl. sub-agents (USD)', 'costUsd', 3, 'rel'],
  ['  of which sub-agents (USD)', 'subagentCostUsd', 3, 'rel'],
  ['CLI total_cost_usd (USD)', 'cliCostUsd', 3, 'rel'],
  ['main-thread turns', 'turns', 0, 'rel'],
  ['sub-agent API calls', 'subagentCalls', 0, 'rel'],
  ['main-thread tool calls', 'parentToolCalls', 0, 'rel'],
  ['wall time (s)', 'wallSec', 0, 'rel'],
  ['sessions without an answer', 'noAnswer', 0, 'abs'],
]

const valuesOf = (rows: RepRow[], key: keyof RepRow): number[] =>
  rows.map(r => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

function comparisonTable(byArm: Map<Arm, RepRow[]>, arms: Arm[], multiRep: boolean): string {
  const [base, ...others] = arms
  const rows = METRIC_ROWS.map(([label, key, digits, delta]) => {
    const cells = arms.map(a => {
      const v = valuesOf(byArm.get(a)!, key)
      if (!v.length) return '-'
      const med = fmtNum(median(v), digits)
      return multiRep ? `${med} [${range(v, digits)}]` : med
    })
    const verdicts = others.map(other => {
      const a = valuesOf(byArm.get(base!)!, key)
      const b = valuesOf(byArm.get(other)!, key)
      if (!a.length || !b.length) return ''
      const ma = median(a)
      const mb = median(b)
      const d =
        delta === 'abs'
          ? `${mb - ma >= 0 ? '+' : ''}${fmtNum(mb - ma, digits)}`
          : ma === 0
            ? mb === 0
              ? '0%'
              : 'n/a'
            : `${mb >= ma ? '+' : ''}${(((mb - ma) / ma) * 100).toFixed(0)}%`
      return multiRep ? `${d} ${rangesOverlap(a, b) ? '(overlap)' : 'SEPARATED'}` : d
    })
    return [label, ...cells, ...verdicts]
  })
  const head = [`per rep, median${multiRep ? ' [min–max]' : ''}`, ...arms, ...others.map(o => `${o} vs ${base}`)]
  return table(head, rows)
}

/** The plan's pre-registered gates for a delegation-steering change, each variant against the first arm. */
function gateTable(byArm: Map<Arm, RepRow[]>, base: Arm, arm: Arm): string {
  const med = (a: Arm, k: keyof RepRow) => {
    const v = valuesOf(byArm.get(a)!, k)
    return v.length ? median(v) : Number.NaN
  }
  const total = (a: Arm, k: keyof RepRow) => valuesOf(byArm.get(a)!, k).reduce((x, y) => x + y, 0)
  const pair = (k: keyof RepRow, digits: number) => [med(base, k).toFixed(digits), med(arm, k).toFixed(digits)]
  const rows: Array<[string, string[], boolean]> = [
    ['correct answers ≥ baseline', pair('correct', 1), med(arm, 'correct') >= med(base, 'correct')],
    [
      `multi-hop answered with a fork ≤ baseline + 1 (of ${N_MULTI})`,
      pair('multiForked', 1),
      med(arm, 'multiForked') <= med(base, 'multiForked') + 1,
    ],
    [
      `delegation rate within ±20 pp of baseline (one question in ${N_MULTI})`,
      pair('delegationRate', 0),
      Math.abs(med(arm, 'delegationRate') - med(base, 'delegationRate')) <= 20,
    ],
    [
      'no WebResearcher* on a code question (sum over reps)',
      [String(total(base, 'webResearcher')), String(total(arm, 'webResearcher'))],
      total(arm, 'webResearcher') === 0,
    ],
    ['cost incl. sub-agents ≤ baseline + 5%', pair('costUsd', 3), med(arm, 'costUsd') <= med(base, 'costUsd') * 1.05],
  ]
  return table(
    ['gate (medians over reps)', base, arm, 'verdict'],
    rows.map(([gate, [b, v], ok]) => [gate, b!, v!, ok ? 'pass' : '**FAIL**']),
  )
}

function typesTable(sessions: SessionResult[], arms: Arm[]): string {
  const types = [...new Set(sessions.flatMap(s => s.agentUses.map(u => u.type)))].sort((a, b) =>
    a === 'fork' ? -1 : b === 'fork' ? 1 : a.localeCompare(b),
  )
  const rows = arms.map(a => {
    const uses = sessions.filter(s => s.arm === a).flatMap(s => s.agentUses)
    const overrides = uses.filter(u => u.model).map(u => u.model!)
    return [
      a,
      String(uses.length),
      ...types.map(t => String(uses.filter(u => u.type === t).length)),
      String(uses.filter(u => u.readOnly).length),
      overrides.length ? toolSummary(Object.fromEntries([...new Set(overrides)].map(m => [m, overrides.filter(o => o === m).length]))) : '-',
      String(uses.filter(u => u.isError).length),
    ]
  })
  return table(
    ['arm (all reps)', 'Agent calls', ...types.map(t => (WEB_RESEARCHER_RE.test(t) ? `**${t}**` : t)), 'readOnly', 'model override', 'errored'],
    rows,
  )
}

function questionTable(sessions: SessionResult[], arms: Arm[]): string {
  const ids = [...new Set([...QUESTIONS.map(q => q.id), ...sessions.map(s => s.qid)])].filter(id => sessions.some(s => s.qid === id))
  const rows = ids.map(id => [
    id,
    QUESTION_BY_ID.get(id)?.kind ?? '?',
    ...arms.map(a => {
      const ss = sessions.filter(s => s.arm === a && s.qid === id)
      if (!ss.length) return '-'
      const n = ss.length
      const delegated = ss.filter(s => s.agentUses.length).length
      const forked = ss.filter(s => s.agentUses.some(u => u.kind === 'fork')).length
      const correct = ss.filter(s => grade(QUESTION_BY_ID.get(id), s.finalText).correct).length
      return `deleg ${delegated}/${n}, fork ${forked}/${n}, correct ${correct}/${n}, ${fmtUsd(median(ss.map(s => s.costUsd)))}`
    }),
  ])
  return table(['question', 'kind', ...arms.map(a => `${a}: delegated, forked, correct, median cost`)], rows)
}

function sessionTable(sessions: SessionResult[]): string {
  const rows = sessions.map(s => {
    const g = grade(QUESTION_BY_ID.get(s.qid), s.finalText)
    const tools = Object.fromEntries(Object.entries(s.tools).filter(([n]) => !AGENT_TOOLS.has(n)))
    return [
      `${s.arm} r${s.rep} ${s.qid}`,
      String(s.turns),
      toolSummary(tools) || '-',
      agentSummary(s.agentUses),
      String(s.subagentCalls),
      `${g.hit}/${g.of}${g.correct ? '' : ' MISS'}`,
      fmtUsd(s.costUsd),
      fmtUsd(s.cliCostUsd),
      `${(s.wallMs / 1000).toFixed(0)}s${s.exitCode === null ? ' timeout' : s.exitCode ? ` exit ${s.exitCode}` : ''}`,
      s.dirty ? `${s.dirty.split('\n').length} dirty` : 'clean',
    ]
  })
  return table(
    ['session', 'turns', 'main-thread tools', 'Agent calls', 'sub-agent calls', 'graded', 'cost', 'CLI cost', 'wall', 'tree'],
    rows,
  )
}

function report(sessions: SessionResult[], meta: Meta): string {
  const arms = meta.arms.filter(a => sessions.some(s => s.arm === a))
  const reps = [...new Set(sessions.map(s => s.rep))].sort((a, b) => a - b)
  const byArm = new Map(
    arms.map(a => [
      a,
      reps
        .map(r => sessions.filter(s => s.arm === a && s.rep === r))
        .filter(g => g.length > 0)
        .map(repRow),
    ]),
  )
  const multiRep = Math.max(...arms.map(a => byArm.get(a)!.length)) > 1
  const out: string[] = [
    `# delegation-steer-ab — ${meta.started}`,
    '',
    `- model \`${meta.model}\`, effort \`${meta.effort}\`, reps ${meta.reps}, per session: --max-turns ${meta.maxTurns}, --max-budget-usd ${meta.budgetUsd}`,
    `- target: clone of this repo at \`${meta.sha.slice(0, 12)}\`; answer key derived at \`${meta.answerSha.slice(0, 12)}\`` +
      (meta.sha === meta.answerSha ? '' : ' — **different commits: re-derive the key before trusting the grades**'),
    ...Object.entries(meta.versions).map(([k, v]) => `- ${k}: ${v}`),
    ...Object.entries(meta.armEnv)
      .filter(([, env]) => Object.keys(env).length > 0)
      .map(([k, env]) => `- ${k} runs with ${Object.entries(env).map(([n, v]) => `\`${n}=${v}\``).join(' ')}`),
    `- host variables stripped before the arms ran: ${meta.hostEnvRemoved.length ? meta.hostEnvRemoved.join(', ') : 'none'}`,
    `- run dir: \`${meta.runDir}\` (results.json, transcripts/)`,
    '- prices: Opus 5.5 at 4/20, cache read 0.2, write 5 (5m) / 8 (1h) per Mtok; other models from forkBench.priceFor',
    '',
  ]
  if (arms.length > 1) {
    out.push('## Pre-registered gates', '')
    for (const other of arms.slice(1)) out.push(`### ${other} vs ${arms[0]}`, '', gateTable(byArm, arms[0]!, other), '')
    out.push(
      '±20 pp on the delegation rate reads the plan\'s "±20%" as percentage points: with five multi-hop questions a relative ' +
        '20% is less than one question.',
      '',
    )
  }
  out.push(
    '## Totals',
    '',
    comparisonTable(byArm, arms, multiRep),
    '',
    'A fork is an Agent call without `subagent_type`; a fresh agent names one. Shares are of all Agent calls in the rep, ' +
      'and a rep with no Agent call has none. Cost is priced from the transcripts, parent plus sub-agents; ' +
      '`total_cost_usd` also counts side calls that write no transcript.',
    '',
    '## Agent types chosen',
    '',
    typesTable(sessions, arms),
    '',
  )
  const web = sessions.filter(s => s.agentUses.some(u => WEB_RESEARCHER_RE.test(u.type)))
  if (web.length) {
    out.push(`**WebResearcher on a code question** in ${web.map(s => `${s.arm} r${s.rep} ${s.qid}`).join(', ')}.`, '')
  }
  for (const a of arms) {
    const types = sessions.filter(s => s.arm === a).flatMap(s => s.children.map(c => c.agentType))
    const counts = Object.fromEntries([...new Set(types)].map(t => [t, types.filter(x => x === t).length]))
    out.push(`- ${a}: sub-agent transcripts by recorded type: ${types.length ? toolSummary(counts) : 'none'}`)
  }
  out.push('', '## Per question', '', questionTable(sessions, arms), '', '## Sessions', '', sessionTable(sessions), '')
  const misses = sessions.filter(s => !grade(QUESTION_BY_ID.get(s.qid), s.finalText).correct)
  out.push('## Answers the grader rejected', '')
  if (!misses.length) out.push('- none')
  for (const s of misses) {
    const g = grade(QUESTION_BY_ID.get(s.qid), s.finalText)
    const text = oneLine(s.finalText)
    const stderr = oneLine(s.stderrTail).slice(0, 160)
    out.push(
      `- ${s.arm} r${s.rep} ${s.qid}: missing ${g.missing.join(', ')} — ` +
        (text
          ? `"${text.slice(0, 240)}${text.length > 240 ? '…' : ''}"`
          : `no final answer (exit ${s.exitCode ?? 'timeout'}${stderr ? `; ${stderr}` : ''})`),
    )
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Dry run — the clone, the graders and the plumbing, without a token
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/
const PATHS_KEY_RE = /^paths\s*:/m

/** What every session loads before its first search: AGENTS.md, the memory index, and the rules without `paths:`. */
function alwaysLoaded(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.claudin/memory/team/MEMORY.md']) {
    if (existsSync(join(root, f))) out.push([f, readFileSync(join(root, f), 'utf8')])
  }
  const rules = join(root, '.claudin', 'rules')
  for (const f of existsSync(rules) ? readdirSync(rules).filter(n => n.endsWith('.md')) : []) {
    const text = readFileSync(join(rules, f), 'utf8')
    if (!PATHS_KEY_RE.test(FRONTMATTER_RE.exec(text)?.[1] ?? '')) out.push([`.claudin/rules/${f}`, text])
  }
  return out
}

/** Stands in for bin/claudin: reports the environment and argv it was given, as stream-json. */
function fakeCli(bun: string): string {
  return [
    `#!${bun}`,
    `const keys = Object.keys(process.env).filter(k => /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_)/.test(k)).sort()`,
    `const result = JSON.stringify({ keys, argv: process.argv.slice(2) })`,
    `console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'dry-run' }))`,
    `console.log(JSON.stringify({ type: 'assistant', session_id: 'dry-run', message: { id: 'msg_dry', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))`,
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', result, session_id: 'dry-run', total_cost_usd: 0 }))`,
    '',
  ].join('\n')
}

/**
 * A two-call parent that launches a fork and a readOnly Code agent. The fork's
 * transcript opens with the parent's history under the parent's own ids, as a
 * real fork's does, so a double count would show in the total.
 */
function syntheticSession(dir: string): [boolean, string] {
  const saved = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = join(dir, 'config')
  try {
    const ws = join(dir, 'synthetic-ws')
    const sid = 'dry-run-session'
    const parentPath = transcriptPath(ws, sid)
    const subagents = join(dirname(parentPath), sid, 'subagents')
    mkdirSync(subagents, { recursive: true })
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 },
      output_tokens: 500,
    }
    const assistant = (id: string, content: Json[]) =>
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-23T12:00:00Z', message: { id, model: 'claude-opus-5-5', usage, content } })
    const spawnCall = assistant('msg_parent_1', [
      { type: 'tool_use', id: 'tu_fork', name: 'Agent', input: { description: 'trace it', prompt: 'x' } },
      { type: 'tool_use', id: 'tu_code', name: 'Agent', input: { description: 'map it', prompt: 'y', subagent_type: 'Code', readOnly: true } },
    ])
    const results = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_fork', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu_code', content: 'ok' },
        ],
      },
    })
    writeFileSync(parentPath, [spawnCall, results, assistant('msg_parent_2', [{ type: 'text', text: 'answer' }])].join('\n') + '\n')
    writeFileSync(join(subagents, 'agent-afork.jsonl'), [spawnCall, assistant('msg_fork_1', [{ type: 'text', text: 'f' }])].join('\n') + '\n')
    writeFileSync(join(subagents, 'agent-afork.meta.json'), JSON.stringify({ agentType: 'fork', description: 'trace it' }))
    writeFileSync(join(subagents, 'agent-acode.jsonl'), assistant('msg_code_1', [{ type: 'text', text: 'c' }]) + '\n')
    writeFileSync(join(subagents, 'agent-acode.meta.json'), JSON.stringify({ agentType: 'Code', description: 'map it' }))
    const run: HeadlessRun = { calls: [], toolResults: [], systemLines: [], finalText: 'answer', sessionId: sid, totalCostUsd: 0, stderr: '', exitCode: 0 }
    const r = analyze({ arm: BASELINE, rep: 1, q: QUESTIONS[0]!, ws, run, wallMs: 0, dirty: '', fallbackModel: 'claude-opus-5-5' })
    // 10×4 + 20k×0.2 + 1k×8 + 500×20 per Mtok, four calls: two parent, one each child.
    const perCall = (10 * 4 + 20_000 * 0.2 + 1_000 * 8 + 500 * 20) / 1e6
    const checks: Array<[string, boolean]> = [
      ['2 main-thread turns', r.turns === 2],
      ['fork then fresh', r.agentUses.map(u => u.kind).join(',') === 'fork,fresh'],
      ['Code readOnly', r.agentUses[1]?.type === 'Code' && r.agentUses[1]?.readOnly === true],
      ['1 own call per child', r.children.map(c => `${c.agentType}:${c.calls}`).sort().join(',') === 'Code:1,fork:1'],
      ['cost = 4 calls', Math.abs(r.costUsd - 4 * perCall) < 1e-9],
    ]
    const failed = checks.filter(([, ok]) => !ok).map(([n]) => n)
    return [failed.length === 0, failed.length ? `wrong: ${failed.join('; ')}` : `fork + Code(ro), ${r.children.length} children, ${fmtUsd(r.costUsd)}`]
  } finally {
    if (saved === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = saved
  }
}

/** The reference answer with every alternative of one item blanked out. */
function ablate(reference: string, it: Item): string {
  let t = reference
  for (const n of it.anyOf) {
    t = typeof n === 'string' ? t.replaceAll(n, '_') : t.replace(new RegExp(n.source, `${n.flags.replace('g', '')}g`), '_')
  }
  return t
}

async function dryRun(args: Args): Promise<void> {
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const gates: Array<[string, boolean, string]> = []

  const clone = ensureClone(args.sha)
  const sha12 = clone.sha.slice(0, 12)
  gates.push([`clone at ${sha12}: branch main, clean, no remote`, cloneIsPristine(clone.dir, clone.sha), clone.dir])
  const ws = makeWorkspace(clone.dir, join(dir, 'ws', 'baseline-r1-m1-budget'))
  gates.push([
    'a session workspace is a clean copy at the SHA',
    git(ws, 'rev-parse', 'HEAD').out.trim() === clone.sha && git(ws, 'status', '--porcelain').out.trim() === '',
    ws,
  ])

  for (const q of QUESTIONS) {
    const fails = checkEvidence(ws, q)
    gates.push([`answer key holds at ${sha12}: ${q.id}`, fails.length === 0, fails.join('; ') || `${q.evidence.length} source lines`])
  }
  const refs = QUESTIONS.map(q => grade(q, q.reference))
  gates.push([
    'every reference answer passes',
    refs.every(g => g.correct),
    QUESTIONS.map((q, i) => (refs[i]!.correct ? '' : `${q.id} missing ${refs[i]!.missing.join(', ')}`)).filter(Boolean).join('; ') ||
      `${refs.length}/${refs.length}`,
  ])
  const wrongs = QUESTIONS.map(q => grade(q, q.wrong))
  gates.push([
    'every wrong answer fails, on exactly one item',
    wrongs.every(g => !g.correct && g.missing.length === 1),
    QUESTIONS.map((q, i) => `${q.id}: ${wrongs[i]!.missing.join(', ') || 'PASSED'}`).join('; '),
  ])
  const ablations = QUESTIONS.flatMap(q => q.items.map(it => ({ q, it, g: grade(q, ablate(q.reference, it)) })))
  const survived = ablations.filter(a => a.g.correct)
  gates.push([
    'every graded item is load-bearing (reference minus that item fails)',
    survived.length === 0,
    survived.map(a => `${a.q.id}/${a.it.label}`).join('; ') || `${ablations.length} ablations`,
  ])

  const steering = QUESTIONS.filter(q => STEERING_WORD_RE.test(q.prompt))
  gates.push([
    'no prompt mentions agents, delegation, forks, parallelism or tasks',
    steering.length === 0,
    steering.map(q => `${q.id}: "${STEERING_WORD_RE.exec(q.prompt)![0]}"`).join('; ') || `${QUESTIONS.length} prompts`,
  ])
  const inPrompt = QUESTIONS.flatMap(q => q.items.filter(it => grade({ ...q, items: [it] }, q.prompt).correct).map(it => `${q.id}/${it.label}`))
  gates.push(['no graded item is given away by its own prompt', inPrompt.length === 0, inPrompt.join('; ') || 'none'])
  const loaded = alwaysLoaded(ws)
  const free = QUESTIONS.map(q => ({
    q,
    items: q.items.filter(it => loaded.some(([, text]) => grade({ ...q, items: [it] }, text).correct)).map(it => it.label),
  }))
  gates.push([
    'at most one graded item per question is in always-loaded context',
    free.every(f => f.items.length <= 1),
    `${loaded.map(([f]) => f).join(', ')}: ` + (free.filter(f => f.items.length).map(f => `${f.q.id}/${f.items.join('+')}`).join('; ') || 'none'),
  ])

  // The plumbing: the variant's variables must reach the child, the host's
  // must not, and the flags must be the ones session-cache-ab passes.
  const fake = join(dir, 'fake-cli')
  writeFileSync(fake, fakeCli(process.execPath))
  chmodSync(fake, 0o755)
  process.env.CLAUDECODE = '1'
  process.env.CLAUDIN_DSAB_HOST_PROBE = '1'
  const removed = scrubHostEnv()
  const probe = await runHeadless({
    bin: fake,
    model: args.model,
    cwd: ws,
    prompt: QUESTIONS[0]!.prompt,
    env: armEnv({ CLAUDIN_LEAN_AGENT_PROMPT: '1' }),
    timeoutMs: 30_000,
    extraArgs: cliFlags(args),
  })
  let seen: { keys: string[]; argv: string[] } = { keys: [], argv: [] }
  try {
    seen = JSON.parse(probe.finalText) as typeof seen
  } catch {
    // Left empty: both gates below then fail and print what came back.
  }
  const want = ['CLAUDIN_LEAN_AGENT_PROMPT', 'CLAUDIN_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']
  const leaked = seen.keys.filter(k => HOST_ENV_RE.test(k) && !want.includes(k))
  gates.push([
    'variant env reaches the child; host CLAUDECODE/CLAUDE_CODE_*/CLAUDIN_* do not',
    want.every(k => seen.keys.includes(k)) && leaked.length === 0,
    `child saw ${seen.keys.join(' ') || '(nothing)'}; stripped ${removed.length} host var(s)`,
  ])
  const argv = seen.argv
  const pairOk = (flag: string, value: string) => argv[argv.indexOf(flag) + 1] === value
  const flagsOk =
    argv.includes('-p') &&
    argv.includes(QUESTIONS[0]!.prompt) &&
    pairOk('--model', args.model) &&
    pairOk('--effort', args.effort) &&
    pairOk('--max-turns', String(args.maxTurns)) &&
    pairOk('--max-budget-usd', String(args.budgetUsd)) &&
    pairOk('--permission-mode', 'bypassPermissions') &&
    argv.includes('--dangerously-skip-permissions')
  gates.push([
    'CLI flags: -p, prompt, model, effort, max-turns, budget, permissions bypassed',
    flagsOk,
    argv.filter(a => a.startsWith('-') || a === args.model || a === args.effort).join(' ') || probe.stderr.slice(0, 120),
  ])
  const [synthOk, synthDetail] = syntheticSession(dir)
  gates.push(['transcript analysis: fork/fresh/readOnly, no double count of a fork\'s history', synthOk, synthDetail])
  rmSync(ws, { recursive: true, force: true })

  console.log(`dry run in ${dir}\n`)
  console.log(table(['gate', 'ok', 'detail'], gates.map(([g, ok, d]) => [g, ok ? 'yes' : 'NO', d])))
  const dist = existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))
  console.log(
    `\n${QUESTIONS.length} questions (${N_MULTI} multi-hop, ${N_CONTROL} controls); ` +
      `dist/cli.mjs ${dist ? 'present' : 'MISSING — a paid run refuses without it'}; ` +
      `a paid run is ${QUESTIONS.length} sessions per arm per rep.`,
  )
  if (gates.some(([, ok]) => !ok)) process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ARG_RE = /=(.*)/s
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const REPLAY_SPEC_RE = /^(.*\.json)@([^/]+)$/

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 1,
    only: null,
    sequential: false,
    model: 'claude-opus-5-5',
    effort: 'high',
    sha: ANSWER_SHA,
    maxTurns: 80,
    budgetUsd: 5,
    timeoutMs: 20 * 60_000,
    dryRun: false,
    replay: '',
    bin: join(REPO_ROOT, 'bin', 'claudin'),
    env: { [BASELINE]: {} },
    variants: [],
  }
  const fail = (msg: string): never => {
    console.error(msg)
    process.exit(2)
  }
  for (const x of argv) {
    const [k, v = ''] = x.split(ARG_RE, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--sequential') a.sequential = true
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--sha') a.sha = v
    else if (k === '--max-turns') a.maxTurns = Number(v)
    else if (k === '--budget') a.budgetUsd = Number(v)
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--replay') a.replay = v
    else if (k === '--variant') {
      const colon = v.indexOf(':')
      const label = colon < 0 ? v : v.slice(0, colon)
      if (!label || label === BASELINE) fail(`--variant needs a label other than "${BASELINE}": ${x}`)
      const pairs = colon < 0 ? [] : v.slice(colon + 1).split(',').filter(Boolean)
      const env: Record<string, string> = {}
      for (const p of pairs) {
        const eq = p.indexOf('=')
        const name = eq < 0 ? p : p.slice(0, eq)
        if (eq < 0 || !ENV_NAME_RE.test(name)) fail(`--variant ${label}: "${p}" is not NAME=VALUE`)
        env[name] = p.slice(eq + 1)
      }
      a.env[label] = env
      a.variants.push(label)
    } else fail(`unknown argument ${x}`)
  }
  if (!Number.isInteger(a.reps) || a.reps < 1) fail(`--reps must be a positive integer`)
  return a
}

function replay(args: Args): void {
  // Several results files merge into one report; `file@label` suffixes that
  // file's arms, so the same arm from two runs lands in two columns.
  const files = args.replay.split(',').filter(Boolean)
  const saved = files.map((spec): Saved => {
    const [, file = spec, label] = REPLAY_SPEC_RE.exec(spec) ?? []
    const s = JSON.parse(readFileSync(file, 'utf8')) as Saved
    if (!label) return s
    const name = (arm: string) => `${arm}@${label}`
    const rekey = <T>(o: Record<string, T> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [name(k), v]))
    return {
      meta: { ...s.meta, arms: s.meta.arms.map(name), versions: rekey(s.meta.versions), armEnv: rekey(s.meta.armEnv) },
      sessions: s.sessions.map(x => ({ ...x, arm: name(x.arm) })),
    }
  })
  const arms = [...new Set(saved.flatMap(s => s.meta.arms))].filter(a => !args.only || args.only.includes(a))
  if (args.only) arms.sort((x, y) => args.only!.indexOf(x) - args.only!.indexOf(y))
  const pick = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => arms.includes(k)))
  const meta: Meta = {
    ...saved[0]!.meta,
    arms,
    versions: pick(Object.assign({}, ...saved.map(s => s.meta.versions))),
    armEnv: pick(Object.assign({}, ...saved.map(s => s.meta.armEnv))),
    reps: Math.max(...saved.map(s => s.meta.reps)),
  }
  const sessions = saved.flatMap(s => s.sessions).filter(x => arms.includes(x.arm))
  const text = report(sessions, meta)
  writeFileSync(join(meta.runDir, files.length > 1 ? `report-${arms.join('-vs-')}.md` : 'report.md'), text)
  console.log(text)
}

function version(bin: string): string {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: { ...process.env, ...armEnv() }, timeout: 30_000 })
  return (r.stdout ?? '').trim() || `(no --version: ${(r.stderr ?? '').trim().slice(0, 80)})`
}

function save(runDir: string, sessions: SessionResult[], meta: Meta): string {
  const path = join(runDir, 'results.json')
  writeFileSync(path, JSON.stringify({ meta, sessions } satisfies Saved, null, 1))
  return path
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) return dryRun(args)
  if (args.replay) return replay(args)

  const arms = args.only ?? [BASELINE, ...args.variants]
  const unknown = arms.filter(a => !args.env[a])
  if (unknown.length) {
    console.error(`no arm ${unknown.join(', ')} — declare it with --variant=<label>:<ENV>=<value>`)
    process.exit(2)
  }
  if (!existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const hostEnvRemoved = scrubHostEnv()
  const clone = ensureClone(args.sha)
  const broken = QUESTIONS.map(q => [q.id, checkEvidence(clone.dir, q)] as const).filter(([, f]) => f.length)
  if (broken.length) {
    console.error(`the answer key does not hold at ${clone.sha}:\n${broken.map(([id, f]) => `  ${id}: ${f.join('; ')}`).join('\n')}`)
    process.exit(1)
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim()
  const binVersion = `${version(args.bin)} @ ${head}${dirty ? ' (src dirty)' : ''}`
  const meta: Meta = {
    started: new Date().toISOString(),
    runDir,
    model: args.model,
    effort: args.effort,
    sha: clone.sha,
    answerSha: ANSWER_SHA,
    maxTurns: args.maxTurns,
    budgetUsd: args.budgetUsd,
    reps: args.reps,
    arms,
    questions: QUESTIONS.map(q => q.id),
    versions: Object.fromEntries(arms.map(a => [a, binVersion])),
    armEnv: Object.fromEntries(arms.map(a => [a, args.env[a] ?? {}])),
    hostEnvRemoved,
  }
  console.log(`delegation-steer-ab → ${runDir}`)
  console.log(`  ${args.bin}: ${binVersion}; target ${clone.dir}`)
  console.log(
    `  ${arms.length} arm(s) x ${args.reps} rep(s) x ${QUESTIONS.length} questions = ${arms.length * args.reps * QUESTIONS.length} sessions, ` +
      `each capped at $${args.budgetUsd} and ${args.maxTurns} turns`,
  )

  const ctx: RunContext = { args, runDir, clone: clone.dir }
  const sessions: SessionResult[] = []
  const onSession = (s: SessionResult) => {
    sessions.push(s)
    save(runDir, sessions, meta)
  }
  for (let rep = 1; rep <= args.reps; rep++) {
    if (args.sequential) {
      // Rotate who goes first, so the cold prefix is not always the same arm's.
      const order = rep % 2 ? arms : [...arms].reverse()
      for (const arm of order) await runArmRep(arm, rep, ctx, onSession)
    } else {
      await Promise.all(arms.map(arm => runArmRep(arm, rep, ctx, onSession)))
    }
  }

  const text = report(sessions, meta)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${save(runDir, sessions, meta)}\nreport  → ${join(runDir, 'report.md')}`)
}

if (import.meta.main) await main()
