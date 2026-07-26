import { splitCommandWithOperators } from './commands.js'

/**
 * Segment walk for compound bash commands.
 *
 * Several call sites need the same traversal: split a command on its control
 * operators, drop the target of an output redirection, and look at each
 * remaining segment's head token. It lived inline in `isSearchOrReadBashCommand`
 * (BashTool.tsx), which is a `.tsx` and therefore unimportable under `bun test`
 * (the Ink import chain reaches the build-time growthbook stub). Pulling it here
 * gives it a test home and one implementation of the two subtleties that would
 * otherwise drift between copies — the redirect-target skip and the neutral set.
 *
 * This is a shape-only walk. It says what the segments ARE, never what they
 * mean; classification belongs to the caller, because "read command" means
 * something different to the UI collapser (which counts `wc` and `jq`) than to
 * the Bash→tool redirect (which cannot map either).
 */

/** The control operator that joined a segment to the one before it. */
export type SegmentJoin = '|' | '&&' | '||' | ';'

export type CommandSegment = {
  /** Segment text with quotes intact, e.g. `sed -n '330,400p'`. */
  text: string
  /** Head token, e.g. `sed`. Never empty. */
  name: string
  /** null for the first segment. */
  joinedBy: SegmentJoin | null
  /** Pure output/status command — does not change the nature of the pipeline. */
  isNeutral: boolean
}

export type WalkedCommand = {
  segments: CommandSegment[]
  /**
   * The command writes somewhere with `>`, `>>` or `>&`. Callers that care
   * about where the output GOES must consult this: the walk drops the
   * redirection and its target, so without the flag `grep foo f > out` and
   * `grep foo f` are indistinguishable.
   */
  hasOutputRedirection: boolean
}

/**
 * Commands that are semantic-neutral in any position — pure output/status
 * commands that don't change the read/search nature of the overall pipeline.
 * e.g. `ls dir && echo "---" && ls dir2` is still a read-only compound command.
 */
export const SEMANTIC_NEUTRAL_COMMANDS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':', // bash no-op
])

const CONTROL_OPERATORS: ReadonlySet<string> = new Set(['||', '&&', '|', ';'])

/**
 * `>&` is here with the file-writing operators even though `2>&1` is fd
 * duplication rather than a write. Telling them apart needs the target, which
 * this walk has already committed to dropping, and every caller uses the flag
 * to stand DOWN — so the conservative reading costs a missed opportunity, never
 * a wrong action.
 */
const OUTPUT_REDIRECTIONS: ReadonlySet<string> = new Set(['>', '>>', '>&'])

/**
 * Returns null when there is nothing to walk: malformed shell syntax, an empty
 * command, or a command that is only operators. Callers treat null as "not
 * classifiable" rather than as an error.
 *
 * Note that `splitCommandWithOperators` does NOT throw on malformed syntax — it
 * falls back to a single element holding the whole command. That element walks
 * out of here as one segment whose `text` still contains the operators, so a
 * caller that acts on segments must independently validate what it found (the
 * redirect does it by requiring every extracted path to exist on disk).
 */
export function walkCommandSegments(command: string): WalkedCommand | null {
  let parts: string[]
  try {
    parts = splitCommandWithOperators(command)
  } catch {
    return null
  }
  if (parts.length === 0) return null

  const segments: CommandSegment[] = []
  let hasOutputRedirection = false
  let skipNextAsRedirectTarget = false
  let pendingJoin: SegmentJoin | null = null

  for (const part of parts) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false
      continue
    }
    if (OUTPUT_REDIRECTIONS.has(part)) {
      hasOutputRedirection = true
      skipNextAsRedirectTarget = true
      continue
    }
    if (CONTROL_OPERATORS.has(part)) {
      pendingJoin = part as SegmentJoin
      continue
    }
    const text = part.trim()
    if (!text) continue
    const name = text.split(/\s+/)[0]
    if (!name) continue
    segments.push({
      text,
      name,
      joinedBy: segments.length === 0 ? null : pendingJoin,
      isNeutral: SEMANTIC_NEUTRAL_COMMANDS.has(name),
    })
    pendingJoin = null
  }

  if (segments.length === 0) return null
  return { segments, hasOutputRedirection }
}
