/**
 * Re-run delta.
 *
 * The model re-runs `git diff` after every edit. Because the tool sees its own
 * previous output it can return only what changed since then — but only under
 * the rules in the plan, the first of which is the one that matters: never
 * elide text the model can no longer see.
 *
 * What is elided is narrow on purpose: a per-file diff section that is
 * BYTE-IDENTICAL to the one already delivered. That makes the elision true by
 * construction rather than by inference — nothing is reconstructed, nothing is
 * summarised, and the stat table covering every file in the diff is always
 * emitted in full, so the model can never be wrong about the SHAPE of the
 * change (rule 2).
 *
 * Disable with `CLAUDIN_DISABLE_GIT_DELTA=1`.
 */
import { createHash } from 'crypto'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClippedIds } from 'src/services/compact/stableStubState.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { logError } from 'src/utils/log.js'
import { getAgentId } from 'src/coordinator/teammate.js'
import { detectGitOperation } from 'src/tools/shared/gitOperationTracking.js'
import { gitSubcommandOf } from './grammar.js'

/**
 * How many consecutive deltas one command gets before a full body is served
 * again.
 *
 * Three, the same as `STICKY_REPLAY_BUDGET`/`STAND_DOWN_STRIKES` in
 * `FileReadTool.ts` and for the same reason: it is the point at which a model
 * that keeps re-running the same command is already repeating itself, so the
 * body arrives with the signal instead of long after it. Defined here rather
 * than imported because importing `FileReadTool.ts` for a number would pull the
 * whole Read tool into this module's graph.
 */
export const MAX_CONSECUTIVE_DELTAS = 3

/**
 * Remembered bodies, bounded like the one-shot memo in
 * `src/tools/shared/redirect.ts`: past the cap the OLDEST insertion is dropped,
 * so the map cannot grow for the life of the process.
 */
const MAX_REMEMBERED_COMMANDS = 32

/**
 * A delta must be a real saving or it is noise. Same spirit as the summarizer's
 * no-win guard, kept as a local constant so this lane does not break when the
 * budget module retunes its own.
 */
const DELTA_MAX_RATIO = 0.7

/** `diff --git a/x b/y` — the section boundary in every unified diff. */
const DIFF_HEADER_RE = /^diff --git (\S+) (\S+)$/
/** Not anchored: used with `.test()` per line. */
const DIFF_HEADER_LINE_RE = /^diff --git /
const ADDED_LINE_RE = /^\+(?!\+\+)/
const REMOVED_LINE_RE = /^-(?!--)/
/** Leading `a/`, `b/`, or the `c/`/`w/` pair `diff.mnemonicPrefix` emits. */
const DIFF_PATH_PREFIX_RE = /^[a-z]\//

/**
 * Commands that move the baseline a remembered diff was taken against.
 *
 * Defence in depth: the elision itself is already sound, since it only ever
 * drops a section that is byte-identical to one the model received. This set
 * exists so the lane does not have to rely on that argument holding for a shape
 * nobody anticipated.
 *
 * Deliberately NOT gated on the model's file edits — those are precisely what
 * the delta is for. Only operations that move HEAD or the index count.
 */
const BASELINE_MOVING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'merge',
  'mv',
  'pull',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
])

const DELTA_KILLSWITCH = 'CLAUDIN_DISABLE_GIT_DELTA'

export type DeltaOptions = {
  /** `full: true` on the tool input forces the whole body. */
  full: boolean
  /**
   * The `tool_use_id` this output will be delivered under.
   *
   * Rule 1 lives or dies on this: the lane compares the id of the PREVIOUS
   * delivery against `getClippedIds()`, so without an id there is no way to
   * know whether the body being elided is still visible. Absent → the lane
   * declines and returns everything.
   */
  toolUseId?: string
}

type DiffSection = {
  /** Stable identity for the file — the header line when the path is unparsable. */
  key: string
  /** What to show a human: the b-side path with its prefix stripped. */
  label: string
  text: string
  added: number
  removed: number
  hash: string
}

type Remembered = {
  /** Id of the delivery whose body these hashes describe. */
  toolUseId: string
  hashes: Map<string, string>
  consecutiveDeltas: number
}

/**
 * Keyed by session AND agent, matching `stableStubState`'s own composite key.
 * A sub-agent must not elide against a body only its parent ever saw — that is
 * rule 1 by another route.
 */
const remembered = new Map<string, Remembered>()

function currentKey(): string {
  const sid = getSessionId()
  const agentId = getAgentId()
  return agentId ? `${sid}:${agentId}` : sid
}

function entryKey(command: string): string {
  return `${currentKey()}\u0000${command.trim()}`
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function stripPathPrefix(raw: string): string {
  return raw.replace(DIFF_PATH_PREFIX_RE, '')
}

/**
 * Split a unified diff into its per-file sections.
 *
 * @returns null when the output is not diff-shaped, which is the decline
 * signal for every non-diff command that reaches this lane.
 */
function splitDiffSections(
  output: string,
): { preamble: string; sections: DiffSection[] } | null {
  const lines = output.split('\n')
  const starts: number[] = []
  for (const [i, line] of lines.entries()) {
    if (DIFF_HEADER_LINE_RE.test(line)) starts.push(i)
  }
  if (starts.length === 0) return null

  const preamble = lines.slice(0, starts[0]).join('\n')
  const sections: DiffSection[] = []
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length
    const body = lines.slice(start, end)
    const text = body.join('\n')
    const header = body[0] ?? ''
    const match = DIFF_HEADER_RE.exec(header)
    // A path containing spaces defeats the regex. Falling back to the whole
    // header keeps the KEY unique, which is all the comparison needs.
    const label = match?.[2] !== undefined ? stripPathPrefix(match[2]) : header
    let added = 0
    let removed = 0
    for (const line of body) {
      if (ADDED_LINE_RE.test(line)) added += 1
      else if (REMOVED_LINE_RE.test(line)) removed += 1
    }
    sections.push({
      key: match?.[2] ?? header,
      label,
      text,
      added,
      removed,
      hash: hash(text),
    })
  }
  return { preamble, sections }
}

function remember(
  command: string,
  toolUseId: string,
  sections: readonly DiffSection[],
  consecutiveDeltas: number,
): void {
  const key = entryKey(command)
  if (!remembered.has(key) && remembered.size >= MAX_REMEMBERED_COMMANDS) {
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
  remembered.set(key, {
    toolUseId,
    hashes: new Map(sections.map(s => [s.key, s.hash])),
    consecutiveDeltas,
  })
}

/**
 * Rule 3 — a command that moves HEAD or the index drops every remembered body
 * for this session, not just its own: a checkout invalidates every diff, not
 * the one that happens to share its command string.
 */
function invalidatesBaseline(command: string, output: string): boolean {
  const sub = gitSubcommandOf(command)
  if (sub !== null && BASELINE_MOVING_SUBCOMMANDS.has(sub)) return true
  const op = detectGitOperation(command, output)
  return Boolean(op.commit ?? op.push ?? op.branch ?? op.pr)
}

function dropAllForCurrentKey(): void {
  const prefix = `${currentKey()}\u0000`
  for (const key of remembered.keys()) {
    if (key.startsWith(prefix)) remembered.delete(key)
  }
}

function renderStatTable(
  sections: readonly DiffSection[],
  elided: ReadonlySet<string>,
): string {
  const width = Math.max(...sections.map(s => s.label.length))
  return sections
    .map(s => {
      const counts = `+${s.added} -${s.removed}`
      const mark = elided.has(s.key) ? 'unchanged, elided' : 'below'
      return `  ${s.label.padEnd(width)}  ${counts.padEnd(12)} (${mark})`
    })
    .join('\n')
}

function renderDelta(
  command: string,
  preamble: string,
  sections: readonly DiffSection[],
  elided: ReadonlySet<string>,
): string {
  const changed = sections.filter(s => !elided.has(s.key))
  const parts: string[] = []
  if (preamble.trim()) parts.push(preamble.trimEnd())
  parts.push(
    `Delta vs the previous \`${command}\` in this session: ${changed.length} of ${sections.length} ` +
      `file(s) changed since then. The other ${elided.size} are byte-identical to the diff you ` +
      `already received, so their hunks are elided below. Pass \`full: true\` for the whole diff.`,
  )
  parts.push(`Files in this diff:\n${renderStatTable(sections, elided)}`)
  for (const section of changed) parts.push(section.text.trimEnd())
  return parts.join('\n\n')
}

/**
 * @returns the output reduced to what changed since the previous identical
 * call, or the output unchanged when the delta lane declines.
 */
export function applyGitDelta(
  command: string,
  output: string,
  opts: DeltaOptions,
): string {
  try {
    if (isEnvTruthy(process.env[DELTA_KILLSWITCH])) return output

    // Rule 3 first: the invalidation has to happen even for a command this
    // lane would otherwise ignore, which is most of them.
    if (invalidatesBaseline(command, output)) {
      dropAllForCurrentKey()
      return output
    }

    const split = splitDiffSections(output)
    if (!split) return output

    const key = entryKey(command)

    // Rule 1, first half. Without an id there is no way to check later whether
    // this body survived, so nothing may be remembered against it either.
    const toolUseId = opts.toolUseId
    if (toolUseId === undefined) {
      remembered.delete(key)
      return output
    }

    const prior = remembered.get(key)
    // Rule 1, second half: a clipped id means the body being elided is already
    // gone from the model's context. Rule 4 shares the branch — a spent run of
    // deltas re-arms by serving a full body, which resets the count to 0.
    const canElide =
      opts.full !== true &&
      prior !== undefined &&
      !getClippedIds().has(prior.toolUseId) &&
      prior.consecutiveDeltas < MAX_CONSECUTIVE_DELTAS

    if (!canElide || prior === undefined) {
      remember(command, toolUseId, split.sections, 0)
      return output
    }

    const priorHashes = prior.hashes
    const elided = new Set(
      split.sections.filter(s => priorHashes.get(s.key) === s.hash).map(s => s.key),
    )
    const rendered =
      elided.size === 0
        ? null
        : renderDelta(command, split.preamble, split.sections, elided)

    // A delta that is not meaningfully shorter is noise with a risk attached.
    if (rendered === null || rendered.length > output.length * DELTA_MAX_RATIO) {
      remember(command, toolUseId, split.sections, 0)
      return output
    }

    remember(command, toolUseId, split.sections, prior.consecutiveDeltas + 1)
    return rendered
  } catch (e) {
    // Never block: a broken delta must degrade to the full output.
    logError(`Git: delta failed for \`${command}\` — ${String(e)}`)
    return output
  }
}

/** Drop remembered bodies — a history-touching command invalidates them. */
export function resetGitDelta(): void {
  remembered.clear()
}

export function _getRememberedCountForTesting(): number {
  return remembered.size
}
