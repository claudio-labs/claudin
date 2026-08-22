/**
 * Bash command security validation — barrel over ./bashSecurity/.
 *
 * Four call sites import from here; new code should prefer importing directly
 * from the relevant submodule.
 *
 * Splitting layout:
 *   context.ts    — ValidationContext, the quote extraction that builds it,
 *                   and the two regexes shared across groups
 *   checkIds.ts   — BASH_SECURITY_CHECK_IDS, the telemetry id table
 *   heredoc.ts    — isSafeHeredoc and stripSafeHeredocSubstitutions
 *   validators/   — the 23 validators, grouped by the parser differential each
 *                   one defends against
 *   dispatch.ts   — the two legacy dispatchers and the ordered validator lists
 *                   they share
 */

export {
  bashCommandIsSafe_DEPRECATED,
  bashCommandIsSafeAsync_DEPRECATED,
} from 'src/tools/BashTool/bashSecurity/dispatch.js'
export { stripSafeHeredocSubstitutions } from 'src/tools/BashTool/bashSecurity/heredoc.js'
