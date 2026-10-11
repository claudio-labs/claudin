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
 * signature is the launcher's own wording, so a real failure that merely
 * mentions one of these phrases is still parsed (and reported) as itself.
 */

type Signature = { re: RegExp; reason: (match: RegExpExecArray) => string }

const SIGNATURES: readonly Signature[] = [
  // bash: "bash: line 4: pyright: command not found"; dash: "sh: 1: pyright: not found";
  // pyenv/rbenv shims: "pyenv: pyright: command not found".
  {
    re: /(?:^|: )([^\s:]+): (?:command )?not found$/m,
    reason: m => `\`${m[1]}\` is not installed or not on PATH, so it never ran`,
  },
  // mise: "mise ERROR No version is set for shim: pyright"; asdf: "No version is set for command pyright".
  {
    re: /No version is set for (?:shim:|command) (\S+)/,
    reason: m => `the \`${m[1]}\` shim has no version selected (mise/asdf), so it never ran`,
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
    ? `the command was not found (exit ${COMMAND_NOT_FOUND_EXIT}), so it never ran`
    : null
}
