/**
 * Read credit for a Bash command that printed files whole.
 *
 * A `cat` never counted as a read for the read-before-edit gate: BashTool
 * wrote `readFileState` only for a simulated sed edit (applySedEdit.ts). So a
 * file the model had just been shown by `cat` was refused by Edit and
 * apply_patch as never read — they answer with its lines and a resend passes,
 * a round-trip for text the model already holds — and by Write outright. That
 * is half of why the session-cache-ab loop (2026-09-23) was followed by a Read
 * of every file it had printed; the floor cap cutting the loop is the other
 * half (fileReadShape.ts).
 *
 * With `CLAUDIN_BASH_READ_CREDIT=1`, after a pure file read (fileReadShape.ts)
 * each file the command names — `cat` arguments, and a loop's word list with
 * its globs expanded against the cwd — is compared with what the model
 * actually received. When the file's complete current content, or its
 * `cat -n` rendering, sits in that text verbatim from the start of a line to
 * the end of one, the file is registered as a whole-file Read registers it
 * (`offset: 1`, no limit), dated to its mtime so a change on disk after the
 * `cat` still refuses a write as modified since read. It carries
 * `dedupExempt` because its bytes reached the model in a Bash result, not a
 * Read one: Read's `file_unchanged` stub must never point at a Read that did
 * not happen.
 *
 * Never credited:
 *  - a result the model got a preview of — BashTool spilled it to disk, or it
 *    is over the size the harness persists at;
 *  - an unwrapped result of 8k chars or more, which the tool-result summarizer
 *    cuts before the model sees it (it stands aside for the filter's wrapper);
 *  - a file shown only in part, which is every file the floor cap cut through;
 *  - a file of fewer than two non-blank lines: a single line can sit in the
 *    output for reasons that have nothing to do with that file;
 *  - an entry under a clip-pin stand-down marker, which keeps its own budget;
 *  - an entry that already stands for the whole file at this mtime, so a real
 *    Read keeps its clip pin and its dedup.
 *
 * Off by default. Read once at module load, like the Bash filter's switches.
 */
import { readdir, stat } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import picomatch from 'picomatch'
import { isAlreadyCompacted } from 'src/agent/tools/toolResultSummarizer/markers.js'
import { BASH_SUMMARIZE_THRESHOLD } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'
import {
  parsePureFileRead,
  type ReadWord,
} from 'src/tools/shared/outputFilter/Bash/fileReadShape.js'
import { stripOutputMarkers } from 'src/tools/shared/outputFilter/Bash/markers.js'
import { isWholeFileView } from 'src/tools/shared/readBeforeEditMessages.js'
import { fileLinesOf } from 'src/tools/shared/servedRegion.js'

const READ_CREDIT = isEnvTruthy(process.env.CLAUDIN_BASH_READ_CREDIT)

/**
 * BashTool's `maxResultSizeChars`: over it the harness saves the result to a
 * file and the model gets a 2 KB preview.
 */
const PERSISTED_ABOVE_CHARS = 30_000

/** Files checked per command, however wide its globs. */
const MAX_CANDIDATES = 32

/**
 * A UTF-16 code unit is at most three UTF-8 bytes (a surrogate pair is two
 * units and four bytes), so a file over this many bytes per output char
 * cannot be in the output, and is not read.
 */
const MAX_BYTES_PER_CHAR = 3

const GLOB_SEGMENT_RE = /[*?[]/

type ShownBashOutput = {
  /** The command the model sent. */
  readonly command: string
  /** The stdout of the tool result, exactly as the model receives it. */
  readonly stdout: string
  /** Set when BashTool spilled the run to disk and sent a preview. */
  readonly persistedOutputPath?: string
}

/**
 * Registers every file `shown` printed whole as read, and returns their paths.
 * Fail-open: a file that cannot be checked is not credited, and nothing here
 * can fail the Bash call.
 */
export async function creditShownFiles(
  shown: ShownBashOutput,
  readFileState: FileStateCache,
  cwd: string,
): Promise<string[]> {
  if (!READ_CREDIT) return []
  try {
    const { stdout } = shown
    if (shown.persistedOutputPath !== undefined) return []
    if (stdout.length > PERSISTED_ABOVE_CHARS) return []
    if (!isAlreadyCompacted(stdout) && stdout.length >= BASH_SUMMARIZE_THRESHOLD) {
      return []
    }
    const read = parsePureFileRead(shown.command)
    if (!read) return []

    const body = stripOutputMarkers(stdout)
    const credited: string[] = []
    for (const path of await candidatesOf(read.reads, cwd)) {
      if (await creditIfShownWhole(path, body, readFileState)) credited.push(path)
    }
    if (credited.length > 0) {
      logForDebugging(`bash read credit: ${credited.join(', ')}`)
    }
    return credited
  } catch (e) {
    logError(e)
    return []
  }
}

/** The files the read names, in order, each once, at most MAX_CANDIDATES. */
async function candidatesOf(
  reads: readonly ReadWord[],
  cwd: string,
): Promise<string[]> {
  const seen = new Set<string>()
  for (const word of reads) {
    const paths = word.glob
      ? await expandGlob(word.text, cwd)
      : [resolve(cwd, word.text)]
    for (const path of paths) {
      seen.add(path)
      if (seen.size >= MAX_CANDIDATES) return [...seen]
    }
  }
  return [...seen]
}

/**
 * A glob expanded the way the shell expands it: one path segment at a time,
 * where `*` stops at `/` and matches a leading dot only when the pattern
 * spells one. Sorted per directory; the order only decides which files a
 * glob wider than MAX_CANDIDATES gets to check.
 */
async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
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
      if (next.length >= MAX_CANDIDATES) break
    }
    bases = next
    if (bases.length === 0) break
  }
  return bases
}

async function creditIfShownWhole(
  path: string,
  body: string,
  readFileState: FileStateCache,
): Promise<boolean> {
  const existing = readFileState.get(path)
  if (existing?.standDownOutline) return false

  let content: string
  let timestamp: number
  try {
    const stats = await stat(path)
    if (!stats.isFile() || stats.size === 0) return false
    if (stats.size > body.length * MAX_BYTES_PER_CHAR) return false
    // The reader Read uses, so the entry holds what a Read would have stored.
    const file = await readFileInRange(path)
    content = file.content
    timestamp = Math.floor(file.mtimeMs)
  } catch (e) {
    if (!isFsInaccessible(e)) logError(e)
    return false
  }

  if (
    existing &&
    !existing.isPartialView &&
    isWholeFileView(existing) &&
    existing.timestamp === timestamp
  ) {
    return false
  }
  if (!isDistinctive(content) || !isShownWhole(body, content)) return false

  readFileState.set(path, {
    content,
    timestamp,
    offset: 1,
    limit: undefined,
    dedupExempt: true,
  })
  return true
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
    containsAsLines(body, content) || containsAsLines(body, catNumbered(content))
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
 * Whether `text` sits in `body` from the start of a line to the end of one.
 * The last thing a command prints arrives with its trailing whitespace
 * trimmed — BashTool trims the result — so a file that ends the output is
 * also matched without it.
 */
function containsAsLines(body: string, text: string): boolean {
  const startsLine = (at: number) => at === 0 || body[at - 1] === '\n'
  const endsLine = (at: number) =>
    text.endsWith('\n') || at === body.length || body[at] === '\n'
  for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + 1)) {
    if (startsLine(at) && endsLine(at + text.length)) return true
  }
  const trimmed = text.trimEnd()
  const bodyEnd = body.trimEnd()
  return (
    trimmed !== '' &&
    bodyEnd.endsWith(trimmed) &&
    startsLine(bodyEnd.length - trimmed.length)
  )
}
