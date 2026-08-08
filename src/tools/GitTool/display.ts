/**
 * One-line rendering of a command, for the surfaces that are single-line.
 *
 * A `-m "…"` argument legitimately carries newlines now (see `grammar.ts`), and
 * three of the places a command is printed cannot take them: the tool-use
 * header, the per-command rows of the result block, and the `$ command` header
 * `run.ts` writes in front of a batch. An embedded newline there makes a
 * three-command batch look like nine, and in a refusal message it buries the
 * signpost under the body of a commit message.
 */

const WHITESPACE_RUN_RE = /\s+/g

/** Long enough to keep `git commit -m "<subject>"` readable. */
export const COMMAND_DISPLAY_CHARS = 120

export function oneLineCommand(
  command: string,
  max: number = COMMAND_DISPLAY_CHARS,
): string {
  const flat = command.replace(WHITESPACE_RUN_RE, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
