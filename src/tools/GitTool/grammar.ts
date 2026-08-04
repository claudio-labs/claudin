/**
 * What the Git tool accepts, and whether it only reads.
 *
 * Two jobs, both narrow on purpose:
 *
 *  - **Accept/refuse.** One command per element, starting with `git` or `gh`,
 *    no shell operators. Anything else belongs in Bash, which parses shell
 *    syntax properly.
 *  - **Read vs mutate.** `isReadOnly` gates plan mode, so this is an
 *    ALLOWLIST and it fails closed: an unrecognised command counts as
 *    mutating. A wrong "read-only" leaks a write into plan mode; a wrong
 *    "mutating" only costs a permission prompt.
 *
 * The classification table here is the starter set (diff/log/status/show/blame
 * and the obvious `gh` reads). The flag-sensitive families — `branch`, `tag`,
 * `stash`, `worktree`, `config`, `remote`, `submodule`, `gh api` method
 * sniffing — are deliberately absent and land as mutating until the full table
 * is written.
 */

export const GIT_BINARIES = ['git', 'gh'] as const
export type GitBinary = (typeof GIT_BINARIES)[number]

const BINARY_SET: ReadonlySet<string> = new Set(GIT_BINARIES)

/**
 * Operators that make one element do more than one thing.
 *
 * NOT `hasShellComposition` from `src/tools/shared/redirect.ts`: that regex
 * also treats `'` and `"` as composition. That is right for a *redirect* (a
 * quoted command should stay in Bash) but would make `git commit -m "…"` —
 * the single most important mutating command — impossible to express here.
 *
 * Quotes are safe to allow: `exec()` hands the command to `quoteShellCommand`
 * (`src/utils/shell/bashProvider.ts:125`), the same escaping BashTool relies
 * on. A `;` or `|` inside a quoted argument is still refused — that is the
 * safe direction, and the command falls back to Bash.
 */
const COMPOSITION_RE = /[;|&<>\n`]|\$\(/

const WHITESPACE_RE = /\s+/

/** `git <sub>` forms that only read. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'blame',
  'diff',
  'log',
  'show',
  'status',
])

/**
 * `gh <family> <sub>` forms that only read. Keyed on both tokens because the
 * family alone decides nothing: `gh pr view` reads, `gh pr checkout` writes the
 * working tree.
 */
const READ_ONLY_GH_COMMANDS: ReadonlySet<string> = new Set([
  'pr checks',
  'pr list',
  'pr view',
])

export type GitCommandRefusal = {
  ok: false
  /** Model-facing, names what to do instead. */
  reason: string
}

export type GitCommandAccepted = {
  ok: true
  command: string
  binary: GitBinary
  /** Whitespace-split tokens after the binary. Quoting is NOT resolved. */
  args: readonly string[]
  readOnly: boolean
}

export type ParsedGitCommand = GitCommandAccepted | GitCommandRefusal

/**
 * Classify an already-accepted command. Split out so the (future) full family
 * table has one place to grow, and so `parseGitCommand` stays about syntax.
 */
function classifyReadOnly(binary: GitBinary, args: readonly string[]): boolean {
  const first = args[0]
  if (first === undefined || first.startsWith('-')) return false
  if (binary === 'git') return READ_ONLY_GIT_SUBCOMMANDS.has(first)
  const second = args[1]
  if (second === undefined) return false
  return READ_ONLY_GH_COMMANDS.has(`${first} ${second}`)
}

export function parseGitCommand(raw: string): ParsedGitCommand {
  const command = raw.trim()
  if (!command) {
    return { ok: false, reason: 'Empty command.' }
  }

  const tokens = command.split(WHITESPACE_RE)
  const binary = tokens[0] ?? ''
  if (!BINARY_SET.has(binary)) {
    return {
      ok: false,
      reason: `\`${command}\` does not start with \`git\` or \`gh\`. Run it with Bash instead.`,
    }
  }

  if (COMPOSITION_RE.test(command)) {
    return {
      ok: false,
      reason: `\`${command}\` contains a shell operator (a pipe, \`&&\`, \`;\` or a redirect). Send one plain command per list element — several commands go in the list, not in one string — or run it with Bash if it genuinely needs a shell.`,
    }
  }

  return {
    ok: true,
    command,
    binary: binary as GitBinary,
    args: tokens.slice(1),
    readOnly: classifyReadOnly(binary as GitBinary, tokens.slice(1)),
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

/**
 * A batch is read-only only when EVERY element is, so a mixed batch is refused
 * in plan mode rather than half-executed. An empty list is not read-only —
 * there is nothing to vouch for.
 */
export function isReadOnlyGitBatch(commands: readonly string[]): boolean {
  return commands.length > 0 && commands.every(isReadOnlyGitCommand)
}
