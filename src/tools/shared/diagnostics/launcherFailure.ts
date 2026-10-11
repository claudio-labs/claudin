import type { ParseInput } from 'src/tools/shared/diagnostics/types.js'

/**
 * Did the tool fail to START, as opposed to running and failing?
 *
 * A checker, build or test runner that never ran still exits non-zero and
 * still prints something — the shell's `command not found`, or a version
 * manager's complaint about a shim — and the text scrape counts those lines as
 * errors. On 2026-10-08 a pyright behind an unconfigured mise shim came back
 * as "~3 errors scraped from text": three `mise ERROR` lines, and no type
 * check at all. The callers turn a match into their `runError` lane instead.
 *
 * Positive evidence only, and only from a run nothing could parse: each
 * signature is anchored on the launcher's own prefix, so a tool reporting a
 * missing FILE ("Error: config.yaml: not found") is still reported as itself —
 * the `runError` lane drops the raw tail, so a false match would hide it.
 */

type Signature = { re: RegExp; reason: (match: RegExpExecArray) => string }

const notOnPath = (m: RegExpExecArray): string => `\`${m[1]}\` is not installed or not on PATH`

const SIGNATURES: readonly Signature[] = [
  // bash: "/bin/bash: line 4: pyright: command not found", or under `bash -c`
  // "bash: pyright: command not found"; dash, as a Makefile recipe meets it:
  // "/bin/sh: 1: protoc: not found".
  { re: /^\S*sh(?:: line \d+|: \d+)?: ([^\s:]+): (?:command )?not found$/m, reason: notOnPath },
  // zsh, which exec() prefers when it is the login shell: "zsh:1: command not found: pyright".
  { re: /^\S*zsh(?::\d+)?: command not found: (\S+)$/m, reason: notOnPath },
  // pyenv/rbenv/nodenv shims: "pyenv: pyright: command not found".
  { re: /^(?:pyenv|rbenv|nodenv): ([^\s:]+): command not found$/m, reason: notOnPath },
  // mise: "mise ERROR No version is set for shim: pyright"; asdf: "No version is set for command pyright".
  {
    re: /No version is set for (?:shim:|command) (\S+)/,
    reason: m => `the \`${m[1]}\` shim has no version selected (mise/asdf)`,
  },
]

/** The shell's exit status for a command it could not find. */
const COMMAND_NOT_FOUND_EXIT = 127

/** @returns why the tool never ran, or null when it did. */
export function detectLauncherFailure(input: ParseInput): string | null {
  if (input.exitCode === 0) return null
  const text = `${input.stdout}\n${input.stderr}`
  for (const { re, reason } of SIGNATURES) {
    const match = re.exec(text)
    if (match) return reason(match)
  }
  return input.exitCode === COMMAND_NOT_FOUND_EXIT
    ? `the command was not found (exit ${COMMAND_NOT_FOUND_EXIT})`
    : null
}
