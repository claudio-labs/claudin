// git log / git status filters: rewrite verbose commands to compact equivalents.
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
