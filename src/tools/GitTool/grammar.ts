/**
 * What the Git tool accepts, and whether it only reads.
 *
 * Three jobs, all narrow on purpose:
 *
 *  - **Accept/refuse.** One command per element, starting with `git` or `gh`,
 *    and nothing in it that the shell would act on rather than pass to git —
 *    scanned with bash's own quoting rules by `scanShellHazards`, so a quoted
 *    argument may hold operators and newlines while an unquoted one may not.
 *    Anything else belongs in Bash, which parses shell syntax properly.
 *  - **Decline the forms that cannot work here.** `git add -p` reads from a
 *    stdin nobody writes to, so it blocks until the timeout; `git rebase -i`
 *    and `git commit` with no message reach an editor that `Shell.ts` pins to
 *    `GIT_EDITOR=true`, so they either abort with a confusing message or, worse,
 *    silently succeed having done nothing. Refusing in microseconds with the
 *    flag to add beats both.
 *  - **Read vs mutate.** `isReadOnly` gates plan mode, so this is an ALLOWLIST
 *    and it fails closed: an unrecognised command counts as mutating. A wrong
 *    "read-only" leaks a write into plan mode; a wrong "mutating" only costs a
 *    permission prompt.
 *
 * Deliberate conservatism worth knowing about: `git -C <dir>` and `git -c
 * <cfg>` are never classified read-only. Both re-point git at a repository or a
 * config the caller did not vet — the same bare-repository hazard the Bash
 * permission layer blocks for compound `cd` + git. They still RUN; they just
 * ask, and they stay out of plan mode.
 */

import {
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from 'src/platform/bash/shellQuote.js'
import { oneLineCommand } from 'src/tools/GitTool/display.js'

export const GIT_BINARIES = ['git', 'gh'] as const
export type GitBinary = (typeof GIT_BINARIES)[number]

const BINARY_SET: ReadonlySet<string> = new Set(GIT_BINARIES)

const LEADING_WORD_RE = /^(\S+)/

/**
 * Only for `gitSubcommandOf`, which needs the subcommand and nothing else: it
 * always sits before any quoted argument, so splitting is enough there.
 */
const WHITESPACE_RE = /\s+/

/**
 * Characters that make one element do more than one thing when they are not
 * inside quotes.
 *
 * NOT `hasShellComposition` from `src/tools/shared/redirect.ts`: that regex
 * also treats `'` and `"` as composition, which would make `git commit -m "…"`
 * — the single most important mutating command — impossible to express here.
 * The Bash → Git redirect used to reuse that regex and paid for it: every
 * `git log --format='…'` and `gh run view --jq '…'` stayed in Bash because of
 * a `|` the shell would never have read as an operator. It now asks
 * `acceptsGitCommand` instead, so what Bash refuses and what this tool accepts
 * are the same set by construction.
 */
const UNQUOTED_OPERATORS: ReadonlySet<string> = new Set([
  ';',
  '|',
  '&',
  '<',
  '>',
  '(',
  ')',
  '\n',
  '\r',
])

/**
 * Walk the command with bash's own quoting rules and report the first thing
 * bash would do to it that git would then never see.
 *
 * The rule this encodes is bash's, not a blanket ban, because the two shapes
 * that matter most are a quoted *message*: `git commit -m` and
 * `gh pr create --body`. Inside single quotes everything is literal, so a
 * backtick in a PR body or a `$` in "costs $50" is safe; inside double quotes
 * `$` and a backtick still expand, so those are refused and the message names
 * the fix. Operators are literal inside either kind of quote and only compose
 * outside them, which is what lets a message contain `;` and, crucially,
 * newlines.
 *
 * Fail-closed in the direction that matters: whatever this accepts reaches git
 * byte-for-byte, so the tool can never commit a message the shell quietly
 * rewrote. Anything else falls back to Bash, which parses shell syntax
 * properly.
 *
 * Doing this scan ourselves is not optional. shell-quote — which resolves the
 * arguments below — has no newline in its operator set and drops unquoted
 * newlines as plain separators, so `git status\nrm -rf /` parses to tokens with
 * no operator in them at all.
 */
function scanShellHazards(command: string): string | null {
  const shown = oneLineCommand(command)
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (inSingle) {
      // Bash prints every character literally inside '…', backslash included.
      if (c === "'") inSingle = false
      continue
    }
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '"') {
      inDouble = !inDouble
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = true
      continue
    }
    if (c === '$') {
      if (command[i + 1] === '(') {
        return `\`${shown}\` uses command substitution \`$(…)\`, which needs a shell this tool does not give it. Work out the value first and pass it literally, or run the whole thing with Bash.`
      }
      return `\`${shown}\` has an unescaped \`$\` outside single quotes, and bash would expand it before git saw it. Put that argument in single quotes ('…'), or escape it as \\$.`
    }
    if (c === '`') {
      return `\`${shown}\` has a backtick outside single quotes, which bash would run as a command. Put that argument in single quotes ('…') — inside them a backtick is literal, which is what a PR body needs.`
    }
    if (!inDouble && UNQUOTED_OPERATORS.has(c)) {
      const named = c === '\n' || c === '\r' ? 'a newline' : `\`${c}\``
      return `\`${shown}\` contains a shell operator (${named}) outside quotes. Send one plain command per list element — several commands go in the list, not in one string — or run it with Bash if it genuinely needs a shell.`
    }
  }

  if (inSingle || inDouble) {
    return `\`${shown}\` has an unterminated quote.`
  }
  return null
}

/**
 * Resolve the command into argument tokens with quoting applied, so a quoted
 * message is ONE token instead of a handful of fragments.
 *
 * This is what the classification below reads, and resolving it properly is a
 * correctness fix rather than a nicety: whitespace-splitting made
 * `git stash push -m "wip -p thing"` look like patch mode, and made
 * `git branch --list "-D x"` safe only by the accident of the quote character
 * gluing itself onto the token.
 *
 * Deliberately NOT guarded by `hasMalformedTokens`. That guard belongs to the
 * Bash permission path, where an unquoted `{"a":"b;evil"}` can hide a second
 * command from a permission check, and it detects that by asking whether each
 * resolved token has balanced quotes, braces, parens and brackets. Every shape
 * it defends against here — an unquoted operator, an unterminated quote — is
 * already refused above by `scanShellHazards`, with bash's own semantics
 * rather than by counting characters. What was left of it was a balance test
 * running over the *prose* of a commit message: the apostrophe in "each arm's
 * own", a `renderBody(` mid-sentence, a stray `]`, a quoted phrase. Replaying
 * this repo's last 100 commit messages through the grammar, that heuristic
 * alone refused 21 of them — every one of which shell-quote had tokenized
 * identically to what bash passes to git.
 *
 * Nor is it the permission gate: `checkGitBatchPermission` hands every element
 * to `bashToolHasPermission`, which runs its own copy over its own parse. What
 * these tokens decide is read-only classification and the interactive refusals,
 * both of which fail closed.
 *
 * @returns null when the command cannot be tokenized confidently, in which case
 * the caller refuses and the command falls back to Bash.
 */
function resolveArgs(command: string): string[] | null {
  // shell-quote and bash disagree about a backslash inside single quotes; the
  // guard is the existing one from the Bash permission path.
  if (hasShellQuoteSingleQuoteBug(command)) return null

  const parsed = tryParseShellCommand(command)
  if (!parsed.success) return null

  const tokens: string[] = []
  for (const entry of parsed.tokens) {
    if (typeof entry === 'string') {
      tokens.push(entry)
      continue
    }
    // `src/*.ts` — the pattern is the token bash would pass to git.
    if ('pattern' in entry) {
      tokens.push(entry.pattern)
      continue
    }
    // An operator or a comment. The scan above already refused every operator,
    // and shell-quote treats an unquoted `#` as a comment ANYWHERE in a token
    // (bash only does at the start of a word) and drops the rest of the line,
    // so there is no token list here that is safe to classify.
    return null
  }
  return tokens.slice(1)
}

/** `-p`, `-ip`, `-p5` — a short-flag cluster containing the letter. */
function hasShortFlag(args: readonly string[], letter: string): boolean {
  const re = new RegExp(`^-[A-Za-z]*${letter}`)
  return args.some(a => !a.startsWith('--') && re.test(a))
}

function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some(a => flags.includes(a) || flags.some(f => a.startsWith(`${f}=`)))
}

/**
 * Git's own global options, split by whether they consume the next token.
 * Resolving through the value-less ones is what makes `git --no-pager log`
 * classify like `git log`.
 */
const VALUELESS_GLOBALS: ReadonlySet<string> = new Set([
  '--no-pager',
  '--paginate',
  '-P',
  '--bare',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-replace-objects',
  '--no-optional-locks',
  '--html-path',
  '--man-path',
  '--info-path',
])

/** Globals that re-point git somewhere the caller did not vet. */
const REPOINTING_GLOBALS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
])

type Resolved = {
  /** The subcommand, or '' when none could be found. */
  subcommand: string
  /** Everything after the subcommand. */
  rest: readonly string[]
  /** A `-C`/`-c`-style global was present. */
  repointed: boolean
}

/** Walk past git's global options to the real subcommand. */
function resolveGitSubcommand(args: readonly string[]): Resolved {
  let i = 0
  let repointed = false
  while (i < args.length) {
    const arg = args[i] as string
    if (VALUELESS_GLOBALS.has(arg)) {
      i += 1
      continue
    }
    if (REPOINTING_GLOBALS.has(arg)) {
      repointed = true
      i += 2 // the flag and its value
      continue
    }
    if (arg.startsWith('--') && REPOINTING_GLOBALS.has(arg.split('=')[0] ?? '')) {
      repointed = true
      i += 1
      continue
    }
    if (arg.startsWith('-')) {
      // An unknown global (e.g. `--version`, `--help`). Treat the flag itself
      // as the subcommand so `git --version` can be classified.
      return { subcommand: arg.replace(/^--?/, ''), rest: args.slice(i + 1), repointed }
    }
    return { subcommand: arg, rest: args.slice(i + 1), repointed }
  }
  return { subcommand: '', rest: [], repointed }
}

/** `git <sub>` forms that only ever read, whatever their flags. */
const ALWAYS_READ_GIT: ReadonlySet<string> = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'cherry',
  'count-objects',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'range-diff',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'status',
  'var',
  'verify-commit',
  'version',
  'whatchanged',
])

/** Flags that turn `branch`/`tag` into a write. */
const BRANCH_WRITE_FLAGS = [
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
]
/** Flags after which a positional is a PATTERN, not a name to create. */
const BRANCH_QUERY_FLAGS = [
  '-l',
  '--list',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
]
const TAG_WRITE_FLAGS = [
  '-d',
  '--delete',
  '-f',
  '--force',
  '-a',
  '--annotate',
  '-s',
  '--sign',
  '-m',
  '--message',
  '-F',
  '--file',
  '-u',
  '--local-user',
  '--create-reflog',
]
const TAG_QUERY_FLAGS = [
  '-l',
  '--list',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
]

const CONFIG_READ_FLAGS = [
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '-l',
  '--list',
]
const CONFIG_WRITE_FLAGS = [
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--edit',
  '-e',
  '--rename-section',
  '--remove-section',
]

/** Value-taking flags whose argument must not be mistaken for a positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--sort',
  '--format',
  '--points-at',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--color',
  '-n',
  '-m',
  '-F',
  '-u',
  '--set-upstream-to',
])

/** Non-flag tokens that are not the value of a preceding value-taking flag. */
function positionals(args: readonly string[]): string[] {
  const out: string[] = []
  let skip = false
  for (const arg of args) {
    if (skip) {
      skip = false
      continue
    }
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) skip = true
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Families where the subcommand alone decides nothing.
 * @returns true when this invocation only reads.
 */
function classifyFlagSensitiveGit(sub: string, rest: readonly string[]): boolean {
  switch (sub) {
    case 'branch':
      if (hasAnyFlag(rest, BRANCH_WRITE_FLAGS)) return false
      if (hasAnyFlag(rest, BRANCH_QUERY_FLAGS)) return true
      return positionals(rest).length === 0
    case 'tag':
      if (hasAnyFlag(rest, TAG_WRITE_FLAGS)) return false
      if (hasAnyFlag(rest, TAG_QUERY_FLAGS)) return true
      // `-n`, `-n5` list annotations.
      if (hasShortFlag(rest, 'n')) return true
      return positionals(rest).length === 0
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show'
    case 'worktree':
      return rest[0] === 'list'
    case 'config':
      if (hasAnyFlag(rest, CONFIG_WRITE_FLAGS)) return false
      return hasAnyFlag(rest, CONFIG_READ_FLAGS)
    case 'remote':
      if (rest.length === 0) return true
      if (rest[0] === 'show' || rest[0] === 'get-url') return true
      return rest.every(a => a === '-v' || a === '--verbose')
    case 'submodule':
      return rest[0] === 'status' || rest[0] === 'summary'
    case 'notes':
      return rest[0] === 'list' || rest[0] === 'show'
    case 'bisect':
      return rest[0] === 'log' || rest[0] === 'view' || rest[0] === 'visualize'
    case 'reflog':
      return rest[0] === 'show' || rest[0] === 'exists'
    default:
      return false
  }
}

const FLAG_SENSITIVE_GIT: ReadonlySet<string> = new Set([
  'bisect',
  'branch',
  'config',
  'notes',
  'reflog',
  'remote',
  'stash',
  'submodule',
  'tag',
  'worktree',
])

/**
 * `gh <family> <sub>` forms that only read. Keyed on both tokens because the
 * family alone decides nothing: `gh pr view` reads, `gh pr checkout` writes the
 * working tree.
 */
const READ_ONLY_GH_COMMANDS: ReadonlySet<string> = new Set([
  'auth status',
  'cache list',
  'gist list',
  'gist view',
  'issue list',
  'issue status',
  'issue view',
  'label list',
  'pr checks',
  'pr diff',
  'pr list',
  'pr status',
  'pr view',
  'release list',
  'release view',
  'repo list',
  'repo view',
  'run list',
  'run view',
  // Polls the runs API until the run finishes and prints what it sees. It
  // writes nothing, so it belongs here despite taking minutes; without this
  // line it classified as a mutation and was barred from plan mode.
  'run watch',
  'secret list',
  'variable list',
  'workflow list',
  'workflow view',
])

/** `gh <family>` forms that read whatever the subcommand is. */
const READ_ONLY_GH_FAMILIES: ReadonlySet<string> = new Set(['search', 'status'])

/** Fields on `gh api` that imply a POST even without an explicit method. */
const GH_API_WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

/** `gh api` defaults to GET; a method or a field body makes it a write. */
function ghApiIsReadOnly(rest: readonly string[]): boolean {
  if (hasAnyFlag(rest, GH_API_WRITE_FLAGS)) return false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    let method: string | undefined
    if (arg === '-X' || arg === '--method') method = rest[i + 1]
    else if (arg.startsWith('--method=')) method = arg.slice('--method='.length)
    else if (arg.startsWith('-X') && arg.length > 2) method = arg.slice(2)
    if (method !== undefined && method.toUpperCase() !== 'GET') return false
  }
  return true
}

function classifyGh(args: readonly string[]): boolean {
  const family = args[0]
  if (family === undefined || family.startsWith('-')) return false
  if (family === 'api') return ghApiIsReadOnly(args.slice(1))
  if (READ_ONLY_GH_FAMILIES.has(family)) return true
  const sub = args[1]
  if (sub === undefined) return false
  return READ_ONLY_GH_COMMANDS.has(`${family} ${sub}`)
}

/**
 * The two `gh` forms that poll until CI finishes: `gh run watch` and
 * `gh pr checks --watch`. There are no others — no `git` command watches, and
 * `gh run rerun`/`gh workflow run` return immediately.
 *
 * They are singled out because they invert two of this tool's defaults: the
 * 2-minute ceiling would kill nearly every one of them, and the answer is the
 * LAST thing they print rather than the first.
 */
function classifyWatch(binary: GitBinary, args: readonly string[]): boolean {
  if (binary !== 'gh') return false
  const family = args[0]
  if (family === 'run') return args[1] === 'watch'
  if (family === 'pr' && args[1] === 'checks') return hasAnyFlag(args, ['--watch'])
  return false
}

/**
 * Forms that cannot work through this tool. Each names the flag that makes the
 * same intent work, so the refusal is a signpost rather than a wall.
 */
function interactiveRefusal(
  binary: GitBinary,
  sub: string,
  rest: readonly string[],
): string | null {
  if (binary === 'gh') {
    if (sub === 'auth' && rest[0] === 'login') {
      return '`gh auth login` needs a terminal to prompt on. Run it yourself outside the agent, or use `gh auth login --with-token` from Bash.'
    }
    if (
      (sub === 'pr' || sub === 'issue' || sub === 'repo') &&
      rest[0] === 'create' &&
      rest.length === 1
    ) {
      return `\`gh ${sub} create\` with no flags prompts interactively. Pass the values instead — for a PR that is \`--title\` and \`--body\`.`
    }
    return null
  }

  // stdin-driven: nothing ever writes to the child's stdin, so these block
  // until the timeout rather than failing.
  const patchy =
    hasShortFlag(rest, 'p') ||
    hasShortFlag(rest, 'i') ||
    hasAnyFlag(rest, ['--patch', '--interactive'])
  switch (sub) {
    case 'add':
    case 'checkout':
    case 'restore':
    case 'stash':
    case 'clean':
      if (patchy) {
        return `\`git ${sub}\` in patch/interactive mode reads from a terminal this tool does not have, and would hang until the timeout. Select the paths or hunks explicitly instead.`
      }
      break
    case 'rebase':
      if (hasAnyFlag(rest, ['--interactive']) || hasShortFlag(rest, 'i')) {
        return '`git rebase -i` opens an editor, and the editor here is pinned to `true` — the todo list would be accepted unedited, silently rebasing nothing. Use the non-interactive form (`--onto`, `--exec`) or do it outside the agent.'
      }
      break
    case 'commit': {
      const hasMessage =
        hasShortFlag(rest, 'm') ||
        hasShortFlag(rest, 'C') ||
        hasAnyFlag(rest, [
          '--message',
          '--file',
          '-F',
          '--reuse-message',
          '--no-edit',
          '--fixup',
          '--squash',
        ])
      if (!hasMessage) {
        return '`git commit` with no message opens an editor, which is pinned to `true` here, so git aborts on the empty message. Pass `-m "…"` (or `--no-edit` when amending).'
      }
      break
    }
    case 'tag':
      if (
        hasAnyFlag(rest, ['-a', '--annotate', '-s', '--sign']) &&
        !hasShortFlag(rest, 'm') &&
        !hasAnyFlag(rest, ['--message', '-F', '--file'])
      ) {
        return '`git tag -a` with no message opens an editor, which is pinned to `true` here. Pass `-m "…"`.'
      }
      break
    case 'config':
      if (hasAnyFlag(rest, ['--edit', '-e'])) {
        return '`git config --edit` opens an editor this tool cannot drive. Set the key directly instead.'
      }
      break
    case 'mergetool':
      return '`git mergetool` waits on an external merge program. Resolve the conflicted files with Edit instead.'
    case 'difftool':
      if (!hasAnyFlag(rest, ['--no-prompt', '-y', '--yes'])) {
        return '`git difftool` prompts before each file. Use `git diff`, or pass `--no-prompt`.'
      }
      break
    case 'send-email':
      return '`git send-email` prompts interactively and would hang. Run it outside the agent.'
    default:
      break
  }
  return null
}

export type GitCommandRefusal = {
  ok: false
  /** Model-facing, names what to do instead. */
  reason: string
}

export type GitCommandAccepted = {
  ok: true
  command: string
  binary: GitBinary
  /** Tokens after the binary, with quoting resolved: `-m "a b"` is one token. */
  args: readonly string[]
  readOnly: boolean
  /** `gh run watch` / `gh pr checks --watch` — polls until CI finishes. */
  watch: boolean
}

export type ParsedGitCommand = GitCommandAccepted | GitCommandRefusal

/** Classify an already-accepted command. */
function classifyReadOnly(binary: GitBinary, args: readonly string[]): boolean {
  if (binary === 'gh') return classifyGh(args)
  const { subcommand, rest, repointed } = resolveGitSubcommand(args)
  if (!subcommand || repointed) return false
  if (ALWAYS_READ_GIT.has(subcommand)) return true
  if (FLAG_SENSITIVE_GIT.has(subcommand)) {
    return classifyFlagSensitiveGit(subcommand, rest)
  }
  return false
}

export function parseGitCommand(raw: string): ParsedGitCommand {
  const command = raw.trim()
  if (!command) {
    return { ok: false, reason: 'Empty command.' }
  }

  const binary = LEADING_WORD_RE.exec(command)?.[1] ?? ''
  if (!BINARY_SET.has(binary)) {
    return {
      ok: false,
      reason: `\`${oneLineCommand(command)}\` does not start with \`git\` or \`gh\`. Run it with Bash instead.`,
    }
  }

  const hazard = scanShellHazards(command)
  if (hazard !== null) {
    return { ok: false, reason: hazard }
  }

  const args = resolveArgs(command)
  if (args === null) {
    return {
      ok: false,
      reason: `\`${oneLineCommand(command)}\` could not be read as a single plain command — the quoting is ambiguous. Simplify it, or run it with Bash, which parses shell syntax properly.`,
    }
  }
  const typedBinary = binary as GitBinary
  const { subcommand, rest } =
    typedBinary === 'git'
      ? resolveGitSubcommand(args)
      : { subcommand: args[0] ?? '', rest: args.slice(1) }
  const refusal = interactiveRefusal(typedBinary, subcommand, rest)
  if (refusal !== null) {
    return { ok: false, reason: refusal }
  }

  return {
    ok: true,
    command,
    binary: typedBinary,
    args,
    readOnly: classifyReadOnly(typedBinary, args),
    watch: classifyWatch(typedBinary, args),
  }
}

export function acceptsGitCommand(raw: string): boolean {
  return parseGitCommand(raw).ok
}

/** Fail-closed: anything unparsed or unrecognised counts as mutating. */
export function isReadOnlyGitCommand(raw: string): boolean {
  const parsed = parseGitCommand(raw)
  return parsed.ok && parsed.readOnly
}

/** Fail-closed the other way: an unparsed command is not treated as a watch. */
export function isWatchGitCommand(raw: string): boolean {
  const parsed = parseGitCommand(raw)
  return parsed.ok && parsed.watch
}

/**
 * The `<family> <action>` pair a `gh` command resolves to — `pr checks`,
 * `run view` — or `null` for anything else, `git` included.
 *
 * Exported for the same reason as `gitSubcommandOf`: a caller that needs to
 * recognise one `gh` shape should ask the tokenizer that already resolved the
 * quoting, not re-split the string and hope.
 */
export function ghCommandPair(raw: string): string | null {
  const parsed = parseGitCommand(raw)
  if (!parsed.ok || parsed.binary !== 'gh') return null
  const family = parsed.args[0]
  const action = parsed.args[1]
  if (family === undefined || action === undefined) return null
  return `${family} ${action}`
}

/**
 * The `git` subcommand a command string resolves to, past any global options,
 * or `null` when it is not a `git` command at all.
 *
 * Exported so callers that need to recognise a subcommand do it through this
 * tokenizer rather than with a regex of their own: `resolveGitSubcommand`
 * already knows that `-c x=y` and `--git-dir d` swallow a following value,
 * which is the part a hand-written pattern gets wrong. It also keeps those
 * callers off a pattern like `(?:-\S+\s+|--\S+\s+)*`, whose two branches match
 * the same text and so backtrack exponentially when the subcommand does not
 * match (CodeQL flagged exactly that in `delta.ts`).
 */
export function gitSubcommandOf(raw: string): string | null {
  const tokens = raw.trim().split(WHITESPACE_RE)
  if (tokens[0] !== 'git') return null
  return resolveGitSubcommand(tokens.slice(1)).subcommand
}

/**
 * A batch is read-only only when EVERY element is, so a mixed batch is refused
 * in plan mode rather than half-executed. An empty list is not read-only —
 * there is nothing to vouch for.
 */
export function isReadOnlyGitBatch(commands: readonly string[]): boolean {
  return commands.length > 0 && commands.every(isReadOnlyGitCommand)
}
