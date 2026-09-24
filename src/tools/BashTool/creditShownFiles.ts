/**
 * Read credit for a Bash command that printed files whole.
 *
 * A `cat` never counted as a read for the read-before-edit gate: BashTool
 * wrote `readFileState` only for a simulated sed edit (applySedEdit.ts). So a
 * file the model had just been shown by `cat` was refused by Edit and
 * Patch as never read — they answer with its lines and a resend passes,
 * a round-trip for text the model already holds — and by Write outright. That
 * is half of why the session-cache-ab loop (2026-09-23) was followed by a Read
 * of every file it had printed; the floor cap cutting the loop is the other
 * half (fileReadShape.ts).
 *
 * With `CLAUDIN_BASH_READ_CREDIT=1`, after any command that succeeded, each
 * file its `cat` segments name (`catReadsOf`, fileReadShape.ts — `cat`
 * arguments, and a loop's word list with its globs expanded) is compared with
 * what the model actually received. A path resolves in the directory the
 * command started in, or in the one a `cd` before it moved to: BashTool reads
 * the cwd before the run, since a `cd` has moved the shell's by the time this
 * runs. The `head` and `tail` segments name their files too, and a file they
 * printed only part of is not found whole. When the file's complete
 * current content, or its `cat -n` rendering, sits in that text verbatim from
 * the start of a line to the end of one, the file is registered as a
 * whole-file Read registers it (`offset: 1`, no limit), dated to its mtime so
 * a change on disk after the `cat` still refuses a write as modified since
 * read. It carries `dedupExempt` because its bytes reached the model in a Bash
 * result, not a Read one: Read's `file_unchanged` stub must never point at a
 * Read that did not happen.
 *
 * The result then says so in one line after the output (`readNote`, see
 * shellToolResultMappers.ts), naming the files it printed that do not count
 * and why. Untold, the credit changed nothing the model did: in the
 * 2026-09-23 A/B it Read every file again before editing it, as the tool
 * contract said to. The credited paths ride on the result as well
 * (`creditedFiles`), which is what `/resume` rebuilds them from
 * (queryHelpers.ts) and what drops the note pointing that `cat` at Read
 * (redirectLanes.ts).
 *
 * Never credited:
 *  - a result the model got a preview of — BashTool spilled it to disk, or it
 *    is over the size the harness persists at;
 *  - an unwrapped result of 8k chars or more, which the tool-result summarizer
 *    cuts before the model sees it (it stands aside for the filter's
 *    wrappers). Both sizes are the tool result's, which carries any note after
 *    stdout, this one's line included;
 *  - a run that was interrupted or carries stderr (the cwd-reset note);
 *  - a file shown only in part, which is every file the floor cap cut through,
 *    and every one a `head` or `tail` printed part of;
 *  - a file of fewer than two non-blank lines: a single line can sit in the
 *    output for reasons that have nothing to do with that file;
 *  - a file written at or after the command started (see judge);
 *  - a file outside the session's working directories (see candidatesOf);
 *  - an entry under a clip-pin stand-down marker, which keeps its own budget;
 *  - an entry that already stands for the whole file at this mtime, so a real
 *    Read keeps its clip pin and its dedup. That file counts as read already,
 *    and the line counts it.
 *
 * ## A read too long to show whole
 *
 * `fitWholeFiles` belongs to the pass-through
 * (`CLAUDIN_BASH_FILE_READ_PASSTHROUGH`, outputFilter/Bash/index.ts): a pure
 * read over the 28k it shows whole keeps the whole files that fit — found in
 * the output by the same verbatim match — and names the rest. It lives here
 * because it finds files the way the credit does.
 *
 * Off by default. Read once at module load, like the Bash filter's switches.
 */
import { readdir, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import picomatch from 'picomatch'
import { isAlreadyCompacted } from 'src/agent/tools/toolResultSummarizer/markers.js'
import { BASH_SUMMARIZE_THRESHOLD } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import type { FileState, FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'
import {
  mapShellResultToToolResultBlockParam,
  trimShellStdout,
  type ShellToolResultData,
} from 'src/tools/shellToolResultMappers.js'
import {
  catReadsOf,
  type ReadWord,
} from 'src/tools/shared/outputFilter/Bash/fileReadShape.js'
import { stripOutputMarkers } from 'src/tools/shared/outputFilter/Bash/markers.js'
import { isWholeFileView } from 'src/tools/shared/readBeforeEditMessages.js'
import { fileLinesOf } from 'src/tools/shared/servedRegion.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

const READ_CREDIT = isEnvTruthy(process.env.CLAUDIN_BASH_READ_CREDIT)

/**
 * BashTool's `maxResultSizeChars`: over it the harness saves the result to a
 * file and the model gets a 2 KB preview.
 */
const PERSISTED_ABOVE_CHARS = 30_000

/** Files checked per command, however wide its globs. */
const MAX_CANDIDATES = 32

/**
 * Files `fitWholeFiles` names, however wide its globs. More than the credit
 * checks, because past the cut a file is only named, never read.
 */
const MAX_NAMED = 256

/**
 * What the names in a fitted read's line may add up to. The line follows up
 * to 28k chars of files, and the tool result has to stay under the 30k the
 * harness persists at.
 */
const MAX_NOT_SHOWN_CHARS = 800

/**
 * A UTF-16 code unit is at most three UTF-8 bytes (a surrogate pair is two
 * units and four bytes), so a file over this many bytes per output char
 * cannot be in the output, and is not read.
 */
const MAX_BYTES_PER_CHAR = 3

const GLOB_SEGMENT_RE = /[*?[]/

/**
 * A finished Bash call: the run as BashTool returns it — stdout as the model
 * receives it, and whatever else the tool result will carry — and the command.
 */
type ShownBashOutput = ShellToolResultData & {
  /** The command the model sent. */
  readonly command: string
  /** `Date.now()` read just before the command was spawned. */
  readonly startedAt: number
  /**
   * What the result already names as not shown (`fitWholeFiles`), which the
   * credit's line does not name a second time.
   */
  readonly notShown?: readonly string[]
}

/** What the credit did for one run. */
export type ReadCredit = {
  /** The files it registered as read, in the order the command named them. */
  readonly credited: readonly string[]
  /** The line the tool result ends with; null when nothing counts as read. */
  readonly note: string | null
}

const NO_CREDIT: ReadCredit = { credited: [], note: null }

/** Why a file the command printed does not count as read, as the line says it. */
type NotCountedReason = 'cut' | 'changed since' | 'one line' | 'outside the project'

/** One named file, judged against what the model received. */
type Verdict =
  | { readonly kind: 'credit'; readonly entry: FileState }
  /** An entry already stands for the whole file at this mtime. */
  | { readonly kind: 'counted' }
  | { readonly kind: 'refused'; readonly reason: NotCountedReason }
  /** Nothing to say: missing, empty, not a file, or held by a stand-down marker. */
  | { readonly kind: 'silent' }

const COUNTED: Verdict = { kind: 'counted' }
const SILENT: Verdict = { kind: 'silent' }
const refused = (reason: NotCountedReason): Verdict => ({ kind: 'refused', reason })

type Judged = { readonly path: string; readonly verdict: Verdict }

/**
 * Registers every file `shown` printed whole as read, and returns their paths
 * with the line that tells the model so. Fail-open: a file that cannot be
 * checked is not credited, and nothing here can fail the Bash call.
 *
 * `cwd` is the directory the command started in. The paths it names resolve
 * from there, and the line names them relative to it.
 *
 * Every file is judged before any is registered, because the line joins the
 * result the size gates measure: a result it would push past one of them
 * credits nothing, and says nothing.
 */
export async function creditShownFiles(
  shown: ShownBashOutput,
  readFileState: FileStateCache,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
): Promise<ReadCredit> {
  if (!READ_CREDIT) return NO_CREDIT
  try {
    if (shown.isImage || shown.persistedOutputPath) return NO_CREDIT
    // An interrupted run stopped wherever it was cut, and either one gives the
    // result an `<error>` part — the abort marker, the cwd-reset note.
    if (shown.interrupted || shown.stderr?.trim()) return NO_CREDIT
    const received = receivedText(shown)
    if (received === undefined || !reachesModelWhole(received, received.length)) {
      return NO_CREDIT
    }
    const reads = catReadsOf(shown.command)
    if (reads.length === 0) return NO_CREDIT

    // Stdout alone, as the mapper trims it: a note after it is not output.
    const body = stripOutputMarkers(trimShellStdout(shown.stdout ?? ''))
    const judged: Judged[] = []
    for (const { path, inside } of await candidatesOf(reads, cwd, toolPermissionContext)) {
      const verdict = inside
        ? await judge(path, body, readFileState, shown.startedAt)
        : await judgeOutside(path)
      judged.push({ path, verdict })
    }
    const note = renderCreditNote(judged, cwd, shown.notShown ?? [])
    if (
      note === null ||
      !reachesModelWhole(received, received.length + 1 + note.length)
    ) {
      return NO_CREDIT
    }

    const credited: string[] = []
    for (const { path, verdict } of judged) {
      if (verdict.kind !== 'credit') continue
      readFileState.set(path, verdict.entry)
      credited.push(path)
    }
    if (credited.length > 0) {
      logForDebugging(`bash read credit: ${credited.join(', ')}`)
    }
    return { credited, note }
  } catch (e) {
    logError(e)
    return NO_CREDIT
  }
}

/**
 * The text the model receives for the run: the tool_result BashTool maps it
 * to — stdout trimmed, then any note, stderr part and background note — which
 * is what the summarizer and result persistence measure. The id only labels
 * the block.
 */
function receivedText(shown: ShownBashOutput): string | undefined {
  const { content } = mapShellResultToToolResultBlockParam(shown, '')
  return typeof content === 'string' ? content : undefined
}

/**
 * Whether a tool result that opens like `received` and is `length` chars long
 * reaches the model as it is: not persisted behind a preview, and not cut by
 * the tool-result summarizer, which stands aside only for a wrapped one.
 */
function reachesModelWhole(received: string, length: number): boolean {
  if (length > PERSISTED_ABOVE_CHARS) return false
  return isAlreadyCompacted(received) || length < BASH_SUMMARIZE_THRESHOLD
}

/**
 * The files the read names, in order, each once, and whether each is inside
 * the session's working directories — by the check the file tools make
 * (pathInAllowedWorkingPath), symlinks followed. Those are where a Read needs
 * no rule and no prompt; `cat ../x` or `cat /etc/hosts` must not stand in for
 * a Read that would have asked first. At most MAX_CANDIDATES inside, and as
 * many outside.
 */
async function candidatesOf(
  reads: readonly ReadWord[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ path: string; inside: boolean }[]> {
  const inside = new Set<string>()
  const outside = new Set<string>()
  const candidates: { path: string; inside: boolean }[] = []
  for (const word of reads) {
    const base = baseOf(word, cwd)
    const paths = word.glob
      ? await expandGlob(word.text, base, MAX_CANDIDATES)
      : [resolve(base, word.text)]
    for (const path of paths) {
      if (inside.has(path) || outside.has(path)) continue
      if (!pathInAllowedWorkingPath(path, toolPermissionContext)) {
        if (outside.size >= MAX_CANDIDATES) continue
        outside.add(path)
        candidates.push({ path, inside: false })
        continue
      }
      inside.add(path)
      candidates.push({ path, inside: true })
      if (inside.size >= MAX_CANDIDATES) return candidates
    }
  }
  return candidates
}

/**
 * The directory `word` resolves in: the one the command started in (`cwd`),
 * or the one a `cd` earlier in the command moved to from there.
 */
function baseOf(word: ReadWord, cwd: string): string {
  return word.dir === undefined ? cwd : resolve(cwd, word.dir)
}

/**
 * A glob expanded the way the shell expands it: one path segment at a time,
 * where `*` stops at `/` and matches a leading dot only when the pattern
 * spells one. Sorted per directory; the order only decides which files a
 * glob wider than `max` gets to check.
 */
async function expandGlob(
  pattern: string,
  cwd: string,
  max: number,
): Promise<string[]> {
  let bases = [isAbsolute(pattern) ? '/' : cwd]
  for (const segment of pattern.split('/')) {
    if (segment === '') continue
    if (!GLOB_SEGMENT_RE.test(segment)) {
      bases = bases.map(base => join(base, segment))
      continue
    }
    const isMatch = picomatch(segment)
    const next: string[] = []
    for (const base of bases) {
      let names: string[]
      try {
        names = await readdir(base)
      } catch (e) {
        if (!isFsInaccessible(e)) logError(e)
        continue
      }
      for (const name of names.sort()) {
        if (isMatch(name)) next.push(join(base, name))
      }
      if (next.length >= max) break
    }
    bases = next
    if (bases.length === 0) break
  }
  return bases
}

/**
 * Whether `path` counts as read after this run, and why not when it does not.
 * Reads the file; writes nothing.
 */
async function judge(
  path: string,
  body: string,
  readFileState: FileStateCache,
  startedAt: number,
): Promise<Verdict> {
  const existing = readFileState.get(path)
  if (existing?.standDownOutline) return SILENT

  let content: string
  let timestamp: number
  try {
    const stats = await stat(path)
    if (!stats.isFile() || stats.size === 0) return SILENT
    if (stats.size > body.length * MAX_BYTES_PER_CHAR) {
      return standsForWhole(existing, Math.floor(stats.mtimeMs)) ? SILENT : refused('cut')
    }
    // The reader Read uses, so the entry holds what a Read would have stored.
    const file = await readFileInRange(path)
    // The file is read here, after the command. Written since it started, it
    // may no longer hold what `cat` printed — and a version cut down to its
    // first lines still sits in the output line for line. Credited at that
    // mtime, it would let a Write built from the version the model saw pass
    // the read-before-edit gate.
    if (file.mtimeMs >= startedAt) return refused('changed since')
    content = file.content
    timestamp = Math.floor(file.mtimeMs)
  } catch (e) {
    if (!isFsInaccessible(e)) logError(e)
    return SILENT
  }

  // Already read whole at this mtime: it counts, and the entry is left as it
  // is. Shown only in part this time, it is not this output's to count.
  const covered = standsForWhole(existing, timestamp)
  if (!isDistinctive(content)) return covered ? SILENT : refused('one line')
  if (!isShownWhole(body, content)) return covered ? SILENT : refused('cut')
  if (covered) return COUNTED
  return {
    kind: 'credit',
    entry: { content, timestamp, offset: 1, limit: undefined, dedupExempt: true },
  }
}

/** An entry that already stands for the whole file at `timestamp`: a real Read's, or an earlier credit's. */
function standsForWhole(existing: FileState | undefined, timestamp: number): boolean {
  return (
    existing !== undefined &&
    !existing.isPartialView &&
    isWholeFileView(existing) &&
    existing.timestamp === timestamp
  )
}

/**
 * A file outside the working directories never counts. Named only when it is
 * a file, which is when the model might go on to edit it.
 */
async function judgeOutside(path: string): Promise<Verdict> {
  try {
    return (await stat(path)).isFile() ? refused('outside the project') : SILENT
  } catch (e) {
    if (!isFsInaccessible(e)) logError(e)
    return SILENT
  }
}

/**
 * The line the result ends with, or null when nothing the command printed
 * counts as read. A file the result already names as not shown is not named
 * again.
 */
function renderCreditNote(
  judged: readonly Judged[],
  cwd: string,
  notShown: readonly string[],
): string | null {
  const counted = judged.filter(
    ({ verdict }) => verdict.kind === 'credit' || verdict.kind === 'counted',
  ).length
  if (counted === 0) return null
  const line =
    counted === 1
      ? '(1 file printed whole — it counts as read: Edit, Patch and Write accept it without a Read.)'
      : `(${counted} files printed whole — they count as read: Edit, Patch and Write accept them without a Read.)`
  const alreadyNamed = new Set(notShown)
  const notCounted = judged.flatMap(({ path, verdict }) => {
    if (verdict.kind !== 'refused') return []
    const name = displayPath(path, cwd)
    return alreadyNamed.has(name) ? [] : [`${name} (${verdict.reason})`]
  })
  return notCounted.length === 0 ? line : `${line} Not counted: ${notCounted.join(', ')}.`
}

/** `path` as the notes name it: relative to the cwd when it is under it, absolute when not. */
function displayPath(path: string, cwd: string): string {
  const fromCwd = relative(cwd, path)
  const outside =
    fromCwd === '' || isAbsolute(fromCwd) || fromCwd.split(sep)[0] === '..'
  return outside ? path : fromCwd
}

function isDistinctive(content: string): boolean {
  let nonBlank = 0
  for (const line of fileLinesOf(content)) {
    if (line.trim() !== '' && ++nonBlank >= 2) return true
  }
  return false
}

function isShownWhole(body: string, content: string): boolean {
  return (
    wholeLinesEnd(body, content) !== -1 ||
    wholeLinesEnd(body, catNumbered(content)) !== -1
  )
}

/**
 * `cat -n`'s rendering of a whole file: each line behind its number, right
 * aligned in six columns, and a tab. Numbered from 1, as a `cat -n` per file
 * prints it; `cat -n a b` numbers on through `b`, which is then not credited.
 */
function catNumbered(content: string): string {
  const numbered = fileLinesOf(content)
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n')
  return content.endsWith('\n') ? `${numbered}\n` : numbered
}

/**
 * Where `text` ends in `body`, at its first place at or after `from` that runs
 * from the start of a line to the end of one; -1 when it has none. The last
 * thing a command prints arrives with its trailing whitespace trimmed —
 * BashTool trims the result — so a file that ends the output is also found
 * without it.
 */
function wholeLinesEnd(body: string, text: string, from = 0): number {
  const startsLine = (at: number) => at === 0 || body[at - 1] === '\n'
  const endsLine = (at: number) =>
    text.endsWith('\n') || at === body.length || body[at] === '\n'
  for (let at = body.indexOf(text, from); at !== -1; at = body.indexOf(text, at + 1)) {
    if (startsLine(at) && endsLine(at + text.length)) return at + text.length
  }
  const trimmed = text.trimEnd()
  const bodyEnd = body.trimEnd()
  const at = bodyEnd.length - trimmed.length
  return trimmed !== '' && at >= from && bodyEnd.endsWith(trimmed) && startsLine(at)
    ? bodyEnd.length
    : -1
}

// ---------------------------------------------------------------------------
// A pure read too long to show whole (CLAUDIN_BASH_FILE_READ_PASSTHROUGH)
// ---------------------------------------------------------------------------

/** A pure read cut back to the whole files that fit. */
export type FittedRead = {
  /** The output up to the end of the last whole file that fits. */
  readonly shown: string
  /** The files it leaves out, in the order the command named them, relative to the cwd. */
  readonly notShown: readonly string[]
  /** False when the command named more files than were counted (MAX_NAMED). */
  readonly namesAll: boolean
}

/**
 * `stdout` cut back to the whole files that fit in `budget` chars, and the
 * files it leaves out by name: the pass-through's answer to a pure read too
 * long for one result (`overBudgetFileRead`, outputFilter/Bash/index.ts),
 * where the cap would keep 30 lines of it and a spill a 2 KB preview.
 *
 * The files are taken in the order the command names them, each found after
 * the one before it — its bytes or its `cat -n` rendering, from the start of a
 * line to the end of one, as the credit finds them — and the cut falls where
 * the last one that ends inside the budget ends. The walk stops at the first
 * file it cannot find whole: past a file it cannot place, it cannot say where
 * the next one starts. So what is kept is whole files, and whatever the
 * command printed between them.
 *
 * Unlike the credit, a file outside the working directories is read here too:
 * its bytes are in the output already, and reading them again only places it.
 * `cwd` is where the command started, as for the credit: the paths resolve
 * from it and the files left out are named relative to it.
 *
 * Null when the command names no file, when not even its first file can be
 * placed, or on any failure; the caller then goes on as before.
 */
export async function fitWholeFiles(
  stdout: string,
  reads: readonly ReadWord[],
  cwd: string,
  budget: number,
): Promise<FittedRead | null> {
  try {
    const { paths, namesAll } = await namedFiles(reads, cwd)
    if (paths.length === 0) return null
    let cut = 0
    let fitted = 0
    for (; fitted < paths.length; fitted++) {
      const end = await wholeFileEnd(stdout, paths[fitted]!, cut)
      // Not even the first file placed: there is nowhere to cut, and the cap
      // does better. shell-quote hands a bracket-only glob (`f0[1-3].ts`) back
      // as a plain word, for one.
      if (end === -1 && fitted === 0) return null
      if (end === -1 || end > budget) break
      cut = end
    }
    const shownPaths = new Set(paths.slice(0, fitted))
    const notShown = [...new Set(paths.slice(fitted))]
      .filter(path => !shownPaths.has(path))
      .map(path => displayPath(path, cwd))
    return { shown: stdout.slice(0, cut), notShown, namesAll }
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * The line a fitted read ends with: which files it left out, and how to get
 * them. Null when it left none out.
 */
export function renderNotShownNote(fitted: FittedRead, budget: number): string | null {
  if (fitted.notShown.length === 0) return null
  const listed: string[] = []
  let length = 0
  for (const name of fitted.notShown) {
    if (listed.length > 0 && length + name.length > MAX_NOT_SHOWN_CHARS) break
    listed.push(name)
    length += name.length + 2
  }
  const more = listed.length < fitted.notShown.length || !fitted.namesAll ? ' and more' : ''
  return `Not shown — over the ${Math.round(budget / 1000)}k a Bash result shows whole: ${listed.join(', ')}${more}. cat them in another call, or Read them.`
}

/**
 * Every file the read names, in order and as often as it names them — the
 * shell prints `cat a a` twice — with globs expanded as the shell expands
 * them, at most MAX_NAMED.
 */
async function namedFiles(
  reads: readonly ReadWord[],
  cwd: string,
): Promise<{ paths: string[]; namesAll: boolean }> {
  const paths: string[] = []
  let namesAll = true
  for (const word of reads) {
    const base = baseOf(word, cwd)
    const expanded = word.glob
      ? await expandGlob(word.text, base, MAX_NAMED)
      : [resolve(base, word.text)]
    // A glob that reached the cap may have matched more than it returned.
    if (expanded.length >= MAX_NAMED) namesAll = false
    for (const path of expanded) {
      if (paths.length >= MAX_NAMED) return { paths, namesAll: false }
      paths.push(path)
    }
  }
  return { paths, namesAll }
}

/**
 * Where the whole of `path` ends in `stdout`, placed at or after `from` and
 * past the newline that ends it; -1 when it is not there whole. An empty file
 * prints nothing, so it ends where it would have started.
 */
async function wholeFileEnd(
  stdout: string,
  path: string,
  from: number,
): Promise<number> {
  try {
    const stats = await stat(path)
    if (!stats.isFile()) return -1
    if (stats.size === 0) return from
    if (stats.size > (stdout.length - from) * MAX_BYTES_PER_CHAR) return -1
    const { content } = await readFileInRange(path)
    let end = wholeLinesEnd(stdout, content, from)
    if (end === -1) end = wholeLinesEnd(stdout, catNumbered(content), from)
    if (end === -1) return -1
    // The reader drops a file's final newline; the cut keeps it.
    return stdout[end] === '\n' ? end + 1 : end
  } catch (e) {
    if (!isFsInaccessible(e)) logError(e)
    return -1
  }
}
