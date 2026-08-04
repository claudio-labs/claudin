/**
 * Shared primitives for the Bash → dedicated-tool redirects.
 *
 * `RunTestsTool/redirect.ts`, `TypecheckTool/redirect.ts` and
 * `BashTool/toolRedirect.ts` each need the same three pieces, and each had its
 * own copy before this module existed:
 *
 *  - the shell-composition guard (a command doing more than the one thing the
 *    target tool can do stays in Bash),
 *  - the output-trim-tail stripper (`2>&1 | tail -40` asks for LESS output,
 *    which is exactly what these tools return, so it must not read as a second
 *    command),
 *  - the one-shot refusal memo (refuse once, run the identical re-send).
 *
 * What stays per tool is everything that encodes *which* commands it handles:
 * the allowlist of command heads, the opt-out flag set, and the refusal text.
 *
 * Each caller owns its OWN memo instance. Sharing one would let a refused
 * `bun test` spend the escape hatch belonging to `tsc --noEmit`.
 */

/**
 * Anything here means the command is doing more than running the single
 * operation the target tool performs — it has to stay in Bash.
 */
export const SHELL_COMPOSITION_RE = /[;|&<>\n`'"]|\$\(/

export function hasShellComposition(command: string): boolean {
  return SHELL_COMPOSITION_RE.test(command)
}

/**
 * Output *reducers* — the filters that mean "give me less of this". `tee` and
 * `>` persist the output somewhere else and are deliberately absent: they stay
 * shell composition.
 *
 * `wc` is not in the default set. It turns the output into a count rather than
 * trimming it, so a tool that returns a summary is not a substitute; the
 * Typecheck redirect opts into it explicitly because a diagnostic count is a
 * fair trade for a diagnostic list, while `bun test | wc -l` is not.
 */
export const DEFAULT_OUTPUT_TRIM_FILTERS = ['head', 'tail', 'grep', 'rg'] as const

/**
 * Builds the trailing-filter regex for a given filter set.
 *
 * A filter's own arguments may hold quotes and even a `|`
 * (`grep -E "^test |test result"`), so an argument run is matched as
 * quoted-string-or-plain-char rather than "everything up to the next pipe".
 *
 * The unquoted run stops at `;`, `&`, `<` and `>` on purpose. Without that it
 * swallows whatever follows the filter, and since a redirect SUGGESTS the
 * stripped command back to the model, the suggestion would silently drop real
 * work:
 *
 *     git show --stat X | head -30; echo ---; git log --oneline -8
 *                      └───────────── all of this was removed ────┘
 *
 * A tail that carries another command or a redirection is not a trim tail; the
 * command keeps its pipes, fails the composition check, and stays in Bash.
 * `2>&1` is unaffected — it is matched by its own alternatives, before and
 * after the run.
 *
 * Called once per consumer at module load — never per invocation. That is why
 * `createOutputTrimTailStripper` closes over the compiled result instead of
 * rebuilding it, which would violate the module-level-regex rule in
 * `.claudin/rules/typescript-patterns.md`.
 */
export function buildOutputTrimTailRe(filters: readonly string[]): RegExp {
  const alternation = filters.join('|')
  return new RegExp(
    `\\s(?:2>&1\\s*)?(?:\\|\\s*(?:${alternation})\\b(?:'[^']*'|"[^"]*"|[^|'";&<>\\n])*)+$|\\s2>&1$`,
  )
}

/**
 * Returns a stripper that removes the output-trimming tail — the part the
 * target tool would not run. A piped command handed to a tool's `command`
 * argument would be truncated before its parser saw the summary, so a refusal
 * message must suggest the stripped form, not the one the model typed.
 */
export function createOutputTrimTailStripper(
  filters: readonly string[] = DEFAULT_OUTPUT_TRIM_FILTERS,
): (command: string) => string {
  const re = buildOutputTrimTailRe(filters)
  return command => command.replace(re, '').trim()
}

/** Exported so the memo tests derive their fixtures from the real bound. */
export const MEMO_LIMIT = 100

export type OneShotMemo = {
  /**
   * True the FIRST time a command is seen, false afterwards — i.e. refuse now,
   * let the identical re-send through.
   */
  shouldRefuse(command: string): boolean
  reset(): void
}

/**
 * One-shot refusal memo.
 *
 * Past the limit the OLDEST entry is evicted — a Set iterates in insertion
 * order — so the set cannot grow for the life of the process AND a command that
 * already escaped is not re-armed just because a hundred unrelated ones came
 * after it.
 *
 * Safe for the callers to consume inside `validateInput`, which runs once per
 * tool call at each of its call sites (`services/tools/toolExecution.ts` and
 * `entrypoints/mcp.ts`). The instance is module-level in each consumer, so
 * PROCESS-WIDE and shared by both entrypoints.
 */
export function createOneShotMemo(limit: number = MEMO_LIMIT): OneShotMemo {
  const refusedCommands = new Set<string>()
  return {
    shouldRefuse(command: string): boolean {
      const key = command.trim()
      if (refusedCommands.has(key)) return false
      if (refusedCommands.size >= limit) {
        const oldest = refusedCommands.values().next().value
        if (oldest !== undefined) refusedCommands.delete(oldest)
      }
      refusedCommands.add(key)
      return true
    },
    reset(): void {
      refusedCommands.clear()
    },
  }
}
