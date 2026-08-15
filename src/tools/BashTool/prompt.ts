import { feature } from 'bun:bundle'
import { prependBullets } from 'src/constants/prompts.js'
import { isLeanToolPromptFamily } from 'src/constants/toolPromptTier.js'
import { getAttributionTexts } from 'src/services/git/attribution.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'
import { shouldIncludeGitInstructions } from 'src/platform/config/gitSettings.js'
import { getClaudeTempDir } from 'src/services/permissions/filesystem.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from 'src/shared/timeouts.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { TodoWriteTool } from 'src/tools/TodoWriteTool/TodoWriteTool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
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
 * Override with CLAUDE_CODE_BASH_GIT_IN_MESSAGES=false to revert to the
 * inline behavior. Default = true (attachment on).
 *
 * Note: the upstream `tengu_bash_git_attach` GrowthBook gate is intentionally
 * skipped here because Claudin's getFeatureValue_CACHED_MAY_BE_STALE is a
 * stub that always returns the default — adding a gate would be cargo-cult
 * without the GrowthBook server. Env var is the only toggle.
 */
export function shouldInjectBashGitInstructionsInMessages(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES))
    return false
  return true
}

/**
 * The bash git/PR instructions body, without the `shouldIncludeGitInstructions()`
 * gate. Callers must check `shouldIncludeGitInstructions()` themselves before
 * deciding to emit this (the attachment builder does — see attachments.ts).
 */
export function getBashGitInstructionsBody(): string {
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  return `# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully (run independent commands in parallel where possible):

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following in a SINGLE ${GIT_TOOL_NAME} call, passing all three as one \`commands\` list:
  - A git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - A git diff command to see both staged and unstaged changes that will be committed.
  - A git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following, in this order:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message${commitAttribution ? ` ending with:\n   ${commitAttribution}` : '.'}
   - Run git status after the commit completes to verify success.
   These depend on each other and must run in order, which is exactly what one ${GIT_TOOL_NAME} call gives you: the list runs in order and stops at the first failure, so send all three as one \`commands\` list.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:${commitAttribution ? '' : `\n- Do NOT append any AI attribution trailer to the commit message (e.g. "🤖 Generated with Claude Code", "Generated with Claude Code", "Co-Authored-By: Claude"). Write the message with no such footer.`}
- NEVER run additional commands to read or explore code, besides the git/gh commands this protocol calls for
- NEVER use the ${TodoWriteTool.name} or ${AGENT_TOOL_NAME} tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- Never use git commands with the \`-i\` flag (rebase/add interactive) — they require TTY input. Also never use \`--no-edit\` with \`git rebase\` — it is not a valid rebase flag.
- If there are no changes to commit, do not create an empty commit.
- Pass the whole message — subject, blank line and body — as ONE quoted \`-m\` argument. Inside quotes a newline is literal, so the message keeps its formatting, e.g.:
<example>
${GIT_TOOL_NAME}({commands: ["git add file-one.ts file-two.ts", "git commit -m \\"Commit subject here.\\n\\nBody line here.${commitAttribution ? `\\n\\n${commitAttribution}` : ''}\\"", "git status"]})
</example>
- Quote that argument with '…' instead of "…" when the message contains a backtick or a \`$\`, which bash would otherwise expand before git saw it — inside single quotes both are literal. Inside "…", put a backslash before every \`"\` and \`\\\` the message itself contains, and before each backtick and \`$\` too when an apostrophe rules single quotes out. Escaping always works, so no commit message needs ${BASH_TOOL_NAME}.

# Creating pull requests
Use gh for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases — via the ${GIT_TOOL_NAME} tool, which runs gh as well as git. If given a Github URL use gh to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following in a SINGLE ${GIT_TOOL_NAME} call, passing them as one \`commands\` list, in order to understand the current state of the branch since it diverged from the main branch:
   - A git status command to see all untracked files (never use -uall flag)
   - A git diff command to see both staged and unstaged changes that will be committed
   - A check of whether the current branch tracks a remote branch and is up to date with it, so you know if you need to push to the remote
   - A git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following, in this order:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below, through ${GIT_TOOL_NAME}. A PR body is markdown and normally holds backticks, so quote it with '…' — inside single quotes a backtick and a newline are both literal. If the body also holds an apostrophe, use "…" instead and backslash-escape each backtick, \`$\`, \`"\` and \`\\\` in it.
<example>
${GIT_TOOL_NAME}({commands: ["gh pr create --title 'the pr title' --body '## Summary\\n<1-3 bullet points>\\n\\n## Test plan\\n[Bulleted markdown checklist of TODOs for testing the pull request...]${prAttribution ? `\\n\\n${prAttribution}` : ''}'"]})
</example>

Important:${prAttribution ? '' : `\n- Do NOT append any AI attribution footer to the PR body (e.g. "🤖 Generated with Claude Code", "Generated with Claude Code", "Co-Authored-By: Claude"). Write the body with no such footer.`}
- DO NOT use the ${TodoWriteTool.name} or ${AGENT_TOOL_NAME} tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: \`gh api repos/foo/bar/pulls/123/comments\` (via ${GIT_TOOL_NAME})`
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
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.',
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
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
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
