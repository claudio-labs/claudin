/**
 * Shell builtins that evaluate their arguments as code, or otherwise escape the
 * argv abstraction that every other check reads.
 *
 * `eval "rm -rf /"` has argv ['eval', 'rm -rf /']: inert to flag validation,
 * and to permission matching, which sees `eval` as the command. The same holds
 * for `coproc rm -rf /`, for the zsh precommand modifiers, and for the builtins
 * that take a code STRING they run later — `trap`, `enable -f`, `mapfile -C`,
 * `hash -p`.
 *
 * This list lived in `platform/bash/ast.ts` as EVAL_LIKE_BUILTINS, on the AST
 * security walker — which no shipped bundle has ever reached, because the
 * parser behind it returns null unconditionally. So this coverage did not
 * exist: the legacy path that actually guards every Bash command had none of
 * these names, and `trap`, `enable` and `hash` went through under a broad
 * `Bash(*)` rule. The carve-outs below are the walker's own, kept verbatim so
 * the ported check is neither wider nor narrower than what it replaces.
 *
 * An ask from here is flagged as a misparsing concern by the dispatcher, which
 * means a prefix or wildcard allow rule cannot clear it — an EXACT allow rule
 * still can (`decide.ts:525`). That asymmetry is the point: the hazard was
 * always a broad rule, never a user who named the command.
 */

import { splitCommand_DEPRECATED } from 'src/platform/bash/commands.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import type { ValidationContext } from 'src/tools/BashTool/bashSecurity/context.js'

const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  // Bare `command foo` bypasses function and alias lookup; `command -v/-V` are
  // POSIX existence checks that only print a path, carved out below.
  'command',
  'builtin',
  // `fc -e ed` invokes an editor then executes; `fc -s` re-executes the last
  // matching command. `fc -l` merely lists history — carved out below.
  'fc',
  // `coproc rm -rf /` spawns rm as a coprocess, with argv[0] = 'coproc'.
  'coproc',
  // Zsh precommand modifiers: the real command is argv[1], so permission
  // matching against argv[0] sees the modifier.
  'noglob',
  'nocorrect',
  // `trap 'cmd' EXIT` fires at the end of every BashTool invocation, so the
  // string is guaranteed to run.
  'trap',
  // `enable -f /path/lib.so name` dlopens arbitrary native code as a builtin.
  'enable',
  // `mapfile -C callback -c N` runs the callback as shell code every N lines.
  'mapfile',
  'readarray',
  // `hash -p /path cmd` poisons bash's lookup cache for the rest of the command.
  'hash',
  // Code-string callbacks. `compgen -C cmd` is not interactive-only — it runs
  // its argument immediately to generate completions, carved out below for the
  // listing flags that do not.
  'bind',
  'complete',
  'compgen',
  // Not expanded in non-interactive bash by default, but `shopt -s
  // expand_aliases` enables them; blocked as defense in depth.
  'alias',
  // `let 'x=a[$(id)]'` expands the substitution at evaluation time even from a
  // single-quoted argument — the same primitive an arithmetic expansion has.
  'let',
])

const ENV_ASSIGNMENT_RE = /^[A-Za-z_]\w*=/
const WHITESPACE_RE = /\s+/
/** `fc -e` and `fc -s` execute; any other short option only lists. */
const FC_EXECUTING_FLAG_RE = /^-[^-]*[es]/
/** `compgen -C/-F/-W` execute; `-c`/`-f`/`-v` only list. Case-sensitive. */
const COMPGEN_EXECUTING_FLAG_RE = /^-[^-]*[CFW]/

/**
 * argv[0] of one subcommand, with leading environment assignments skipped.
 *
 * No unescaping happens here, on purpose: bash's quote removal turns `\X` into
 * `X` in unquoted context, so `\eval` runs eval — but `splitCommand_DEPRECATED`
 * has already applied that, and hands back `eval`. The AST walker needed its
 * own unescape only because it matched against tree-sitter's raw text
 * (`ast.ts:1410`); this path does not. Verified: the escaped form is still
 * caught with no unescape here.
 *
 * Precommand modifiers are deliberately NOT skipped here, unlike in the zsh
 * validator: `command`, `builtin`, `noglob` and `nocorrect` are themselves on
 * the list, so skipping them would step over the very name being looked for.
 */
function baseCommandOf(subcommand: string): string {
  for (const token of subcommand.trim().split(WHITESPACE_RE)) {
    if (token === '') continue
    if (ENV_ASSIGNMENT_RE.test(token)) continue
    return token
  }
  return ''
}

/** True when this name with these arguments only reads, and never executes. */
function isReadOnlyUse(name: string, args: string[]): boolean {
  if (name === 'command') return args[0] === '-v' || args[0] === '-V'
  if (name === 'fc') return !args.some(a => FC_EXECUTING_FLAG_RE.test(a))
  if (name === 'compgen') {
    return !args.some(a => COMPGEN_EXECUTING_FLAG_RE.test(a))
  }
  return false
}

/**
 * Checked per subcommand rather than once on the whole string: `ls && eval "$X"`
 * has `ls` as its first word, and a check that only read the base command of the
 * full input would pass it.
 */
export function validateEvalLikeBuiltins(
  context: ValidationContext,
): PermissionResult {
  for (const subcommand of splitCommand_DEPRECATED(context.originalCommand)) {
    const tokens = subcommand.trim().split(WHITESPACE_RE).filter(t => t !== '')
    const name = baseCommandOf(subcommand)
    if (!EVAL_LIKE_BUILTINS.has(name)) continue

    const args = tokens.slice(tokens.indexOf(name) + 1)
    if (isReadOnlyUse(name, args)) continue

    return {
      behavior: 'ask',
      message: `Command uses '${name}', which evaluates its arguments as shell code`,
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No eval-like builtins',
  }
}
