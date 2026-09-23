import { feature } from 'bun:bundle'
import { prependBullets } from 'src/agent/prompts/prompts.js'
import { isLeanToolPromptFamily } from 'src/agent/prompts/toolPromptTier.js'
import { getAttributionTexts } from 'src/vcs/git/attribution.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'
import { shouldIncludeGitInstructions } from 'src/platform/config/gitSettings.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from 'src/shared/timeouts.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter."
}

/**
 * Whether the bash git/PR instructions block should be injected as an
 * attachment message instead of embedded in the BashTool description. When
 * true, getCommitAndPRInstructions() returns an empty string and
 * attachments.ts emits a bash_git_instructions attachment per request.
 *
 * Lifting the git block out of the tool description keeps the tool-schema
 * cache stable when only the git block changes (toggle, cwd switch in/out
 * of repo).
 *
 * Override with CLAUDIN_BASH_GIT_IN_MESSAGES=false to revert to the
 * inline behavior. Default = true (attachment on).
 *
 * Note: the upstream `tengu_bash_git_attach` GrowthBook gate is intentionally
 * skipped here because Claudin's getFeatureValue_CACHED_MAY_BE_STALE is a
 * stub that always returns the default — adding a gate would be cargo-cult
 * without the GrowthBook server. Env var is the only toggle.
 */
export function shouldInjectBashGitInstructionsInMessages(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDIN_BASH_GIT_IN_MESSAGES))
    return false
  return true
}

let leanGitInstructions: boolean | undefined

/**
 * The commit/PR protocol at a little over half its size with every rule kept,
 * and none at all for agents that never commit
 * (`AgentDefinition.omitGitInstructions`, honored in runAgent). The full block
 * is ~3.9k chars in `messages[0]` of every agent that has Bash, sub-agents
 * included. On by default since the session A/B of 2026-09-23 (N=5, in one arm
 * with CLAUDIN_LEAN_AGENT_PROMPT): cost no higher, and all five sessions
 * committed once, conventionally, with no AI trailer. This body alone takes
 * ~580 tokens off the first request (resume-wire-probe).
 * `CLAUDIN_LEAN_GIT_INSTRUCTIONS=0` restores the full text.
 *
 * Read once: the body is cached prefix and must not change while the process
 * lives.
 */
export function isLeanGitInstructionsEnabled(): boolean {
  leanGitInstructions ??= !isEnvDefinedFalsy(
    process.env.CLAUDIN_LEAN_GIT_INSTRUCTIONS,
  )
  return leanGitInstructions
}

/**
 * The bash git/PR instructions body, without the `shouldIncludeGitInstructions()`
 * gate. Callers must check `shouldIncludeGitInstructions()` themselves before
 * deciding to emit this (the attachment builder does — see attachments.ts).
 */
export function getBashGitInstructionsBody(): string {
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()
  if (isLeanGitInstructionsEnabled()) {
    return getLeanGitInstructionsBody(commitAttribution, prAttribution)
  }

  return `# Committing changes with git

Only create commits when the user asks for one; if that is unclear, ask first. Never update the git config, and never push unless you were asked to.

Destructive commands — \`push --force\`, \`reset --hard\`, \`checkout .\`, \`restore .\`, \`clean -f\`, \`branch -D\` — and hook skips (\`--no-verify\`, \`--no-gpg-sign\`) need the user to ask for them by name; a force push to main/master gets a warning instead of a run. Never amend unless the user asks: when a pre-commit hook fails the commit did NOT happen, so \`--amend\` would rewrite the PREVIOUS commit and can destroy work. Fix the issue, re-stage, and create a NEW commit.

1. Read the repo in a SINGLE ${GIT_TOOL_NAME} call, passing the reads as one \`commands\` list: \`git status\` (never \`-uall\`, which can exhaust memory on large repos), \`git diff\` for staged and unstaged changes, and \`git log\` for this repository's commit-message style. Don't run anything beyond the git/gh commands this protocol calls for.
2. Draft a concise (1-2 sentence) message in that style, saying WHY rather than what — "add" for a wholly new feature, "update" for an enhancement to an existing one, "fix" for a bug fix.
3. Stage the files **by name** (never \`git add -A\` or \`git add .\`, which sweep in .env, credentials and large binaries — warn the user if they ask for a file that likely holds secrets), then commit and run \`git status\` to verify. All three go in one more ${GIT_TOOL_NAME} call: the list runs in order and stops at the first failure, which is what makes batching them safe. If there is nothing to commit, don't create an empty one.${commitAttribution ? `\n\nEvery commit message must end with this trailer, on its own line after a blank one:\n\n${commitAttribution}` : ''}

<example>
${GIT_TOOL_NAME}({commands: ["git add file-one.ts file-two.ts", "git commit -m \\"Commit subject here.\\n\\nBody line here.${commitAttribution ? `\\n\\n${commitAttribution}` : ''}\\"", "git status"]})
</example>

Pass the whole message — subject, blank line and body — as ONE quoted \`-m\` argument: inside quotes a newline is literal, so the formatting survives. Quote that argument with '…' instead of "…" when the message contains a backtick or a \`$\`, which bash would otherwise expand before git saw it — inside single quotes both are literal. Inside "…", put a backslash before every \`"\` and \`\\\` the message itself contains, and before each backtick and \`$\` too when an apostrophe rules single quotes out. Escaping always works, so no commit message needs ${BASH_TOOL_NAME}. Never use \`-i\` (interactive rebase or add — it needs a TTY), nor \`--no-edit\` with \`git rebase\`, which is not a valid rebase flag.${commitAttribution ? '' : `\n\nDo not append an AI attribution trailer to the message (e.g. "🤖 Generated with Claude Code", "Generated with Claude Code", "Co-Authored-By: Claude") — write it with no such footer.`}

# Creating pull requests

Use \`gh\` for everything GitHub — issues, pull requests, checks, releases — through the ${GIT_TOOL_NAME} tool, which runs gh as well as git; given a GitHub URL, use gh to read it. A PR's review comments come back from \`gh api repos/foo/bar/pulls/123/comments\`.

Before opening one, read the whole branch rather than its last commit, again in a SINGLE ${GIT_TOOL_NAME} call: status, diff, whether the branch tracks a remote and is up to date with it, and \`git log\` plus \`git diff [base-branch]...HEAD\` for every commit since it diverged. Then create the branch and push with \`-u\` if needed, and open the PR with a title under 70 characters (details belong in the body), returning its URL when you're done.

<example>
${GIT_TOOL_NAME}({commands: ["gh pr create --title 'the pr title' --body '## Summary\\n<1-3 bullet points>\\n\\n## Test plan\\n[Bulleted markdown checklist of TODOs for testing the pull request...]${prAttribution ? `\\n\\n${prAttribution}` : ''}'"]})
</example>

A PR body is markdown and normally holds backticks, so quote it with '…' — inside single quotes a backtick and a newline are both literal. If the body also holds an apostrophe, use "…" instead and backslash-escape each backtick, \`$\`, \`"\` and \`\\\` in it.${prAttribution ? '' : `\n\nThe same goes for attribution: do not append an AI footer (e.g. "🤖 Generated with Claude Code", "Co-Authored-By: Claude") to the body.`}`
}

/**
 * The same protocol with every rule kept — the deny list, the amend rule, the
 * three steps, the quoting rules, both examples (each accepted by the Git
 * tool's grammar) and the attribution handling — and the reasoning between
 * them cut. CLAUDIN_LEAN_GIT_INSTRUCTIONS.
 */
function getLeanGitInstructionsBody(
  commitAttribution: string,
  prAttribution: string,
): string {
  return `# Committing changes with git

Commit only when the user asks; if unclear, ask first. Never update the git config; never push unless asked. Destructive commands — \`push --force\`, \`reset --hard\`, \`checkout .\`, \`restore .\`, \`clean -f\`, \`branch -D\` — and hook skips (\`--no-verify\`, \`--no-gpg-sign\`) run only when the user asks for them by name; warn instead of force-pushing to main/master. Never amend unless asked: a failed pre-commit hook means the commit did NOT happen, so fix it, re-stage and make a NEW commit.

1. Read the repo in a SINGLE ${GIT_TOOL_NAME} call: \`git status\` (never \`-uall\`), \`git diff\` (staged and unstaged), \`git log\` for the message style. Run nothing beyond these git/gh steps.
2. Write a 1-2 sentence message in that style saying why, not what.
3. In one more ${GIT_TOOL_NAME} call, stage files by name — never \`git add -A\` or \`git add .\`; warn about any that likely hold secrets — then commit and run \`git status\`. Nothing to commit: no empty commit.${commitAttribution ? `\n\nEvery commit message must end with this trailer, on its own line after a blank one:\n\n${commitAttribution}` : ''}

<example>
${GIT_TOOL_NAME}({commands: ["git add a.ts b.ts", "git commit -m \\"Subject.\\n\\nBody line here.${commitAttribution ? `\\n\\n${commitAttribution}` : ''}\\"", "git status"]})
</example>

Subject, blank line and body go in ONE quoted \`-m\` argument: '…' when it holds a backtick or a \`$\`, otherwise "…"; inside "…", put a backslash before every \`"\` and \`\\\` in it, and before each backtick and \`$\` too when an apostrophe rules out '…'. No commit message needs ${BASH_TOOL_NAME}. Never use \`-i\` (it needs a TTY), nor \`--no-edit\` with \`git rebase\`.${commitAttribution ? '' : ' Add no AI attribution trailer ("Generated with Claude Code", "Co-Authored-By: Claude").'}

# Creating pull requests

Use \`gh\` through the ${GIT_TOOL_NAME} tool for everything GitHub, a GitHub URL included (review comments: \`gh api repos/foo/bar/pulls/123/comments\`). Before opening a PR, read the whole branch in a SINGLE ${GIT_TOOL_NAME} call: status, diff, remote tracking and sync, \`git log\` and \`git diff [base-branch]...HEAD\`. Create the branch and push with \`-u\` if needed, open the PR with a title under 70 characters (details go in the body), and return its URL.

<example>
${GIT_TOOL_NAME}({commands: ["gh pr create --title 'the pr title' --body '## Summary\\n<1-3 bullets>\\n\\n## Test plan\\n[checklist]${prAttribution ? `\\n\\n${prAttribution}` : ''}'"]})
</example>

Quote the body with '…', where a backtick and a newline are literal; if it holds an apostrophe, use "…" and backslash-escape each backtick, \`$\`, \`"\` and \`\\\`.${prAttribution ? '' : ' Add no AI footer to the body.'}`
}

function getCommitAndPRInstructions(): string {
  if (!shouldIncludeGitInstructions()) return ''
  if (shouldInjectBashGitInstructionsInMessages()) return ''
  return getBashGitInstructionsBody()
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const items: Array<string | string[]> = [
    'Commands MUST run in sandbox mode. If a command fails due to sandbox restrictions, explain the likely restriction and work with the user to adjust sandbox settings or run an explicit user-initiated shell command.',
    'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
    'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

// `leanOverride` is a test seam: getSimplePrompt reads many globals (sandbox,
// embedded, MONITOR_TOOL, timeouts), so a fully pure builder would be invasive.
// Production callers pass nothing → the family tier is resolved live.
export function getSimplePrompt(leanOverride?: boolean): string {
  // Capable families follow the system prompt's altitude principle on their
  // own, so per-tool hand-holding (ls-first, quote-paths, sleep coaching) and
  // the parallelism block (already covered by TOOL_BATCHING_NUDGE) are dropped
  // for them; glm/kimi/default keep the verbose form.
  const lean =
    leanOverride ??
    (feature('LEAN_TOOL_PROMPTS') ? isLeanToolPromptFamily() : false)

  // Ant-native builds alias find/grep to embedded bfs/ugrep in Claude's shell,
  // so we don't steer away from them (and Glob/Grep tools are removed).
  const embedded = hasEmbeddedSearchTools()

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    `Run tests: Use ${RUN_TESTS_TOOL_NAME} (NOT npm test/pytest/go test)`,
    `Build the project: Use ${BUILD_TOOL_NAME} (NOT make/cargo build/gradle)`,
    `Type-check: Use ${TYPECHECK_TOOL_NAME} (NOT tsc --noEmit/cargo check/mypy)`,
    `git and gh: Use ${GIT_TOOL_NAME}, several commands per call (NOT one shell call each)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const avoidCommands = embedded
    ? '`cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
    : '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'

  const multipleCommandsSubitems = [
    // GATED: parallel tool-call batching is covered by TOOL_BATCHING_NUDGE for
    // capable families. The &&/;/newline composition rules below are NOT covered
    // anywhere else and stay CORE — the BashTool permission/sandbox splitter
    // (splitCommandWithOperators) is sensitive to how commands are separated.
    ...(lean
      ? []
      : [
          `If the commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "ls dist" and "cat package.json", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel. (For a burst of git/gh commands, use one ${GIT_TOOL_NAME} call carrying the whole list instead.)`,
        ]),
    `If the commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
    "Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    'DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
  ]


  const sleepSubitems = [
    'Do not sleep between commands that can run immediately — just run them.',
    ...(feature('MONITOR_TOOL')
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
        ]
      : []),
    'If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.',
    'Do not retry failing commands in a sleep loop — diagnose the root cause.',
    'If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.',
    ...(feature('MONITOR_TOOL')
      ? [
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
        ]
      : [
          'If you must poll an external process, use a check command (e.g. `gh run view`) rather than sleeping first.',
          'If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.',
        ]),
  ]
  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    // GATED: per-tool hand-holding redundant for capable families.
    ...(lean
      ? []
      : [
          'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.',
          'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
        ]),
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd` — a `cd` to anywhere but the directory you are already in is checked as its own subcommand, so it can turn a compound command into a permission prompt. You may use `cd` if the User explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    // git-specific safety rules are delivered via the bash_git_instructions
    // attachment (production default; emitted once per agentKey, see
    // attachments.ts:3033). When the attachment is gated off the same body
    // is embedded inline via getCommitAndPRInstructions(). Either way, the
    // short bullet list that used to live here was a strict duplicate.
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    // GATED: sleep coaching is weak-model hand-holding.
    ...(lean
      ? []
      : [
          'Avoid unnecessary `sleep` commands:',
          sleepSubitems,
        ]),
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    'Executes a given bash command and returns its output.',
    '',
    "The working directory persists between commands, but shell state (env vars, functions) does not. The shell environment is initialized from the user's profile (bash or zsh).",
    'Command output is displayed to you, not reliably to the user — describe what you found rather than pointing at it.',
    '',
    `IMPORTANT: Avoid running ${avoidCommands} via this tool unless a dedicated tool cannot do the job. Prefer:`,
    '',
    ...prependBullets(toolPreferenceItems),
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
