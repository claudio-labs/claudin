// git filters: rewrite verbose commands (log, status) to compact equivalents,
// and pipeline-strip noisy output (blame, pull, add, commit, push).
//
// A coding agent rarely needs Author/Date/indented body per commit — the
// one-line summary is the signal. Similarly, `git status` prose output is
// wide; porcelain format is machine-readable and token-efficient.
//
// Extra args (file paths, --author=, --since=, etc.) are forwarded after the
// injected flag so the query scope is preserved.
//
// Regex are declared at module level — see .claude/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- git log ---------------------------------------------------------------

const GIT_LOG_MATCH = /^git\s+log\b/
// Passthrough when the user already asked for compact or patch format,
// or for a single-digit commit shorthand (-1 … -9) that collapses the log.
const GIT_LOG_REJECT =
  /--oneline\b|--format\b|--pretty\b|-p\b|--patch\b|(?:^|\s)-[1-9]\b/

export const gitLog: FilterSpec = {
  name: 'git-log',
  matchCommand: GIT_LOG_MATCH,
  matchCommandReject: GIT_LOG_REJECT,
  rewriteCommand: (ctx) => {
    // ctx.args = ["log", ...extras] — skip subverb at index 0
    const extra = ctx.args.slice(1).join(' ')
    return extra ? `git log --oneline ${extra}` : 'git log --oneline'
  },
  maxLines: 50,
}

// --- git status ------------------------------------------------------------

const GIT_STATUS_MATCH = /^git\s+status\b/
// Passthrough when the user already asked for machine-readable output.
const GIT_STATUS_REJECT = /--porcelain\b|--short\b|-s[a-z]*\b/

export const gitStatus: FilterSpec = {
  name: 'git-status',
  matchCommand: GIT_STATUS_MATCH,
  matchCommandReject: GIT_STATUS_REJECT,
  rewriteCommand: (ctx) => {
    // ctx.args = ["status", ...extras] — skip subverb at index 0
    const extra = ctx.args.slice(1).join(' ')
    return extra
      ? `git status --porcelain --branch ${extra}`
      : 'git status --porcelain --branch'
  },
}

// --- git blame -------------------------------------------------------------
// Strip author name, timezone and time-of-day — keep commit hash, date, line number.
// ^hash (Author YYYY-MM-DD HH:MM:SS +TZ N) → ^hash YYYY-MM-DD N)

const GIT_BLAME_MATCH = /^git\s+blame\b/
// Passthrough when user already asked for porcelain / structured output.
const GIT_BLAME_REJECT = /--porcelain\b|-p\b/
const GIT_BLAME_REPLACE =
  /(\^?[0-9a-f]{7,40})\s+\([^)]+?(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\s+[+\-]\d{4}\s+(\d+)\)/g

export const gitBlame: FilterSpec = {
  name: 'git-blame',
  matchCommand: GIT_BLAME_MATCH,
  matchCommandReject: GIT_BLAME_REJECT,
  stripAnsi: true,
  replace: [{ pattern: GIT_BLAME_REPLACE, replacement: '$1 $2 $3)' }],
}

// --- git pull --------------------------------------------------------------
// Strip remote progress noise (object counting/unpacking); preserve From,
// Updating, Fast-forward, diff-stat, and conflict markers.

const GIT_PULL_MATCH = /^git\s+pull\b/
// Passthrough: --dry-run is already minimal; --no-ff changes merge semantics.
const GIT_PULL_REJECT = /--dry-run\b|--no-ff\b/
const GIT_PULL_STRIP_ENUM = /^remote: Enumerating objects/
const GIT_PULL_STRIP_COUNT = /^remote: Counting objects/
const GIT_PULL_STRIP_COMPRESS = /^remote: Compressing objects/
const GIT_PULL_STRIP_TOTAL = /^remote: Total \d+ \(delta/
const GIT_PULL_STRIP_RESOLVE = /^remote: Resolving deltas/
const GIT_PULL_STRIP_UNPACK = /^Unpacking objects/

export const gitPull: FilterSpec = {
  name: 'git-pull',
  matchCommand: GIT_PULL_MATCH,
  matchCommandReject: GIT_PULL_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    GIT_PULL_STRIP_ENUM,
    GIT_PULL_STRIP_COUNT,
    GIT_PULL_STRIP_COMPRESS,
    GIT_PULL_STRIP_TOTAL,
    GIT_PULL_STRIP_RESOLVE,
    GIT_PULL_STRIP_UNPACK,
  ],
  matchOutput: [
    {
      pattern: /Already up to date\./,
      message: '✓ git pull: already up to date',
      unless: /\b(error|conflict|reject)\b/i,
    },
  ],
}

// --- git add ---------------------------------------------------------------
// Normally silent — output only in --dry-run or -v. Cap at 30 lines to handle
// monorepos with hundreds of staged files.

const GIT_ADD_MATCH = /^git\s+add\b/
// Passthrough interactive modes that are not captured output.
const GIT_ADD_REJECT = /--interactive\b|-i\b|--patch\b|-p\b/

export const gitAdd: FilterSpec = {
  name: 'git-add',
  matchCommand: GIT_ADD_MATCH,
  matchCommandReject: GIT_ADD_REJECT,
  maxLines: 30,
}

// --- git commit ------------------------------------------------------------
// On success, rewrite "[branch hash] message\n N files changed…" to
// "✓ committed <hash>" so the agent sees the commit SHA without the noisy stats.
// On errors/hook failures/gpg issues the replace pattern won't match
// (no "[branch hash]" line), so output passes through unchanged.
// "nothing to commit" is handled by a matchOutput short-circuit.

const GIT_COMMIT_MATCH = /^git\s+commit\b/
// --dry-run output is structurally identical to git-status; let git-status handle it.
const GIT_COMMIT_REJECT = /--dry-run\b/
// Matches "[branch hash] subject\n  N files changed…" — the commit header plus
// optional indented stats lines. Capture group $2 = the short hash.
const GIT_COMMIT_SUCCESS_RE =
  /^\[(\S+)\s+([0-9a-f]{7,40})\][^\n]*(?:\n[ \t][^\n]*)*/gm

export const gitCommit: FilterSpec = {
  name: 'git-commit',
  matchCommand: GIT_COMMIT_MATCH,
  matchCommandReject: GIT_COMMIT_REJECT,
  stripAnsi: true,
  // "nothing to commit" short-circuits before the replace stage runs.
  matchOutput: [
    {
      pattern: /nothing to commit, working tree clean/,
      message: '✓ nothing to commit',
      unless: /\berror\b/i,
    },
  ],
  replace: [
    {
      pattern: GIT_COMMIT_SUCCESS_RE,
      replacement: '✓ committed $2',
      unless: /\b(error|fail|failed|hook exited|hook declined|denied|rejected|gpg failed)\b|✗/i,
    },
  ],
}

// --- git diff --------------------------------------------------------------
// Strip the `index <hash>..<hash> <mode>` line (purely git-internal — the
// `--- a/X` / `+++ b/X` headers above carry all the navigational info the
// agent needs) and `\ No newline at end of file` markers. Hunks themselves
// are the signal — never touched.

const GIT_DIFF_MATCH = /^git\s+diff\b/
// Passthrough for summary/structural variants whose output IS already compact.
const GIT_DIFF_REJECT =
  /--stat\b|--shortstat\b|--name-only\b|--name-status\b|--check\b|--numstat\b|--summary\b/
const GIT_DIFF_STRIP_INDEX = /^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/
const GIT_DIFF_STRIP_NOEOL = /^\\ No newline at end of file$/
// `diff --git a/X b/X` is redundant with the `--- a/X` / `+++ b/X` headers
// that always follow (or, for rename/binary, with the explicit rename/Binary
// lines). Safe to strip in both regular diffs and special-case diffs.
const GIT_DIFF_STRIP_HEADER = /^diff --git\s+a\/\S+\s+b\/\S+$/

export const gitDiff: FilterSpec = {
  name: 'git-diff',
  matchCommand: GIT_DIFF_MATCH,
  matchCommandReject: GIT_DIFF_REJECT,
  stripAnsi: true,
  stripLinesMatching: [GIT_DIFF_STRIP_HEADER, GIT_DIFF_STRIP_INDEX, GIT_DIFF_STRIP_NOEOL],
  matchOutput: [
    {
      pattern: /^\s*$/,
      message: '✓ git diff: no changes',
      unless: /\S/,
    },
  ],
}

// --- git show --------------------------------------------------------------
// Same diff-body cleanup as git-diff plus collapse the redundant
// `Author: Name <email>\nDate:   ...` pair into a single line. Email and
// timezone are noise for an agent reading the diff.

const GIT_SHOW_MATCH = /^git\s+show\b/
const GIT_SHOW_REJECT =
  /--stat\b|--name-only\b|--name-status\b|--no-patch\b|(?:^|\s)-s\b|--summary\b|--pretty\b|--format\b/
// Capture the author name (greedy up to the email bracket) and the date,
// emit a single-line "Author: Name (Date)" sentinel.
const GIT_SHOW_AUTHOR_DATE_RE =
  /^Author:\s+([^<\n]+?)\s*<[^>\n]+>\nDate:\s+(.+)$/m

export const gitShow: FilterSpec = {
  name: 'git-show',
  matchCommand: GIT_SHOW_MATCH,
  matchCommandReject: GIT_SHOW_REJECT,
  stripAnsi: true,
  stripLinesMatching: [GIT_DIFF_STRIP_HEADER, GIT_DIFF_STRIP_INDEX, GIT_DIFF_STRIP_NOEOL],
  replace: [{ pattern: GIT_SHOW_AUTHOR_DATE_RE, replacement: 'Author: $1 ($2)' }],
}

// --- git push --------------------------------------------------------------
// Strip git transfer protocol noise (Enumerating/Counting/Compressing/Writing).
// Preserve remote: lines (includes server-side hook warnings and PR creation URLs),
// the To <remote> result line, and any rejection/error content.

const GIT_PUSH_MATCH = /^git\s+push\b/
// Passthrough: --dry-run is already minimal.
const GIT_PUSH_REJECT = /--dry-run\b/
const GIT_PUSH_STRIP_ENUM = /^Enumerating objects/
const GIT_PUSH_STRIP_COUNT = /^Counting objects/
const GIT_PUSH_STRIP_DELTA = /^Delta compression/
const GIT_PUSH_STRIP_COMPRESS = /^Compressing objects/
const GIT_PUSH_STRIP_WRITE = /^Writing objects/
const GIT_PUSH_STRIP_TOTAL = /^Total \d+ \(delta/
const GIT_PUSH_STRIP_RESOLVE = /^remote: Resolving deltas/
const GIT_PUSH_STRIP_BLANK = /^\s*$/

export const gitPush: FilterSpec = {
  name: 'git-push',
  matchCommand: GIT_PUSH_MATCH,
  matchCommandReject: GIT_PUSH_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    GIT_PUSH_STRIP_ENUM,
    GIT_PUSH_STRIP_COUNT,
    GIT_PUSH_STRIP_DELTA,
    GIT_PUSH_STRIP_COMPRESS,
    GIT_PUSH_STRIP_WRITE,
    GIT_PUSH_STRIP_TOTAL,
    GIT_PUSH_STRIP_RESOLVE,
    GIT_PUSH_STRIP_BLANK,
  ],
  matchOutput: [
    {
      pattern: /Everything up-to-date/,
      message: '✓ push: up-to-date',
      unless: /\berror\b/i,
    },
  ],
}
