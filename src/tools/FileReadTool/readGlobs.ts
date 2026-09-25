/**
 * Globs in a batch Read's `file_paths` (CLAUDIN_READ_GLOBS=1): `/repo/src/*.ts`,
 * or `src/*.ts` against the working directory, reads every file it matches —
 * the one call `cat src/*.ts` is, where the batch Read otherwise needs a call
 * that lists the files first.
 *
 * FileReadTool.resolveInput expands them before anything else sees the input,
 * so validateInput, the PreToolUse hooks (one per file), the permission check
 * and readBatch get concrete paths, while the transcript keeps the globs the
 * model sent; batchResult.ts credits a header under the glob it matches.
 *
 * Nothing outside the project is listed: every glob's base directory is
 * checked before the first listing, and each file a glob yields still goes
 * through the Read permission check like a path the model named.
 *
 * This module is the flag and the expansion, with the disk and the session
 * injected (ReadGlobDeps; FileReadTool.ts supplies the real ones). It imports
 * nothing heavier than path handling: schemas.ts and prompt.ts read the flag
 * from here at load, and glob.ts reaches the permission modules, which import
 * this directory back.
 *
 * Off by default. Off, the schema, both descriptions and every Read are what
 * they were, byte for byte: nothing here runs.
 *
 * PARKED since 2026-09-25, off by the user's decision after the session A/B
 * `/tmp/session-cache-ab/20260925-061930` (N=5): every session used it (2.2
 * glob Reads of ~26 files, none past the budget), yet API calls stayed at 17.2
 * against 17.0, and the first edit came later, at turn 3.6 against 2.8. Each
 * session listed the whole tree with Glob first and only then read by glob,
 * where Claude Code's first call guesses: `git ls-files && cat src/*.ts`.
 * Measure it again once that first call can be the glob Read, e.g. with the
 * project's file list already in context.
 */
import { AbortError, errorMessage, isAbortError } from 'src/shared/errors.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { RipgrepIncompleteReason } from 'src/shared/fs/ripgrep.js'
import { expandPath } from 'src/shared/fs/path.js'
import { logError } from 'src/shared/log.js'
import type { ResolvedInput } from 'src/tools/Tool.js'
import { batchShapeRefusal } from 'src/tools/FileReadTool/readMulti.js'
import type { Input } from 'src/tools/FileReadTool/schemas.js'

/**
 * Read once, at load, by every module whose surface the flag changes
 * (schemas.ts, prompt.ts, FileReadTool.ts) — the schema, the description and
 * the expansion must agree for the whole session, as with the batch Read
 * (readMultiEnabledAtLoad).
 */
export function readGlobsEnabledAtLoad(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_READ_GLOBS)
}

/**
 * The files one call reads once its globs are expanded. Past it the call is
 * refused rather than cut: a listing trimmed to its first fifty would read as
 * the whole of it.
 */
export const MAX_GLOB_FILES = 50

// A glob character with an even number of backslashes before it — none, or
// escaped backslashes — is live; `\*` is a literal star.
const LIVE_GLOB_CHAR_RE = /(?<!\\)(?:\\\\)*[*?[{]/

/** Whether a `file_paths` entry is a glob: it has an unescaped `*`, `?`, `[` or `{`. */
export function isReadGlob(entry: string): boolean {
  return LIVE_GLOB_CHAR_RE.test(entry)
}

/** What one glob matched, as glob.ts lists it. */
export type GlobMatches = {
  files: string[]
  /** Set when ripgrep stopped before the walk finished: `files` is a prefix. */
  incomplete: RipgrepIncompleteReason
}

/** The session and the disk, as the expansion reaches them. */
export type ReadGlobDeps = {
  /** The working directory a relative entry resolves against. */
  cwd: string
  /**
   * The directory a glob starts from: its path before the first glob
   * character (glob.ts, extractGlobBaseDirectory — passed in, for the reason
   * at the top).
   */
  baseDirectoryOf: (pattern: string) => string
  /**
   * Whether a directory lies inside the session's working directories. Must
   * not touch the disk for one that lies outside them.
   */
  isInsideProject: (directory: string) => boolean
  /** Whether a path names an existing file exactly as written. */
  isFile: (path: string) => Promise<boolean>
  /** The files a glob matches, in path order, `limit` at most. */
  listMatches: (pattern: string, limit: number) => Promise<GlobMatches>
}

type Expansion = { ok: true; paths: string[] } | { ok: false; message: string }

const PER_CALL = `Read takes ${MAX_GLOB_FILES} per call`

/**
 * FileReadTool.resolveInput under the flag: a `file_paths` that holds a glob
 * comes back with the files it matched, any other input as it was. A shape
 * validateInput refuses anyway is left for it to refuse, rather than listing
 * files for a call that cannot run.
 */
export async function resolveReadGlobs(
  input: Input,
  deps: ReadGlobDeps,
): Promise<ResolvedInput<Input>> {
  const entries = input.file_paths
  if (entries === undefined || !entries.some(isReadGlob)) return { ok: true, input }
  if (batchShapeRefusal(input) !== null) return { ok: true, input }
  const expanded = await expandReadGlobs(entries, deps)
  if (!expanded.ok) return expanded
  return { ok: true, input: { ...input, file_paths: expanded.paths } }
}

/**
 * `entries` with every glob replaced by the files it matches: the entries in
 * the order given, a glob's matches in path order, and each file once, where
 * it first appears. A plain path stays as written, and so does a glob that
 * names an existing file as written — `app/[slug]/page.tsx` is that file. A
 * glob that matches nothing is dropped; nothing left refuses the call.
 */
export async function expandReadGlobs(
  entries: readonly string[],
  deps: ReadGlobDeps,
): Promise<Expansion> {
  // Every glob's base is checked before anything is listed, so a glob outside
  // the project refuses the call without touching the disk — even behind a
  // glob inside it.
  const patterns = new Map<string, string>()
  const outside: string[] = []
  for (const entry of entries) {
    if (!isReadGlob(entry) || patterns.has(entry)) continue
    let pattern: string
    try {
      pattern = expandPath(entry, deps.cwd)
    } catch (e) {
      // expandPath refuses a path with a null byte in it.
      return { ok: false, message: `${entry}: ${errorMessage(e)}` }
    }
    patterns.set(entry, pattern)
    const base = deps.baseDirectoryOf(pattern)
    if (!deps.isInsideProject(base)) {
      outside.push(
        `${entry}: globs in file_paths expand only inside the project — list ${base} with Glob first.`,
      )
    }
  }
  if (outside.length > 0) return { ok: false, message: outside.join('\n') }

  const paths: string[] = []
  const seen = new Set<string>()
  const add = (path: string, absolute: string): void => {
    if (seen.has(absolute)) return
    seen.add(absolute)
    paths.push(path)
  }
  const expanded = new Set<string>()
  for (const entry of entries) {
    const pattern = patterns.get(entry)
    if (pattern === undefined) {
      add(entry, absoluteOf(entry, deps.cwd))
    } else if (!expanded.has(entry)) {
      // A glob named twice adds nothing the first one did not.
      expanded.add(entry)
      if (await deps.isFile(pattern)) {
        add(entry, pattern)
      } else {
        const listed = await listGlob(entry, pattern, deps)
        if (!listed.ok) return listed
        for (const file of listed.paths) add(file, absoluteOf(file, deps.cwd))
      }
    }
    if (paths.length > MAX_GLOB_FILES) {
      return {
        ok: false,
        message: `With ${entry} the call matches more than ${MAX_GLOB_FILES} files; ${PER_CALL} — narrow the patterns or split the call.`,
      }
    }
  }
  if (paths.length === 0) {
    return { ok: false, message: `No file matches ${[...patterns.keys()].join(', ')}.` }
  }
  return { ok: true, paths }
}

/** One glob's matches, or why the call cannot take them. */
async function listGlob(
  entry: string,
  pattern: string,
  deps: ReadGlobDeps,
): Promise<Expansion> {
  let matches: GlobMatches
  try {
    matches = await deps.listMatches(pattern, MAX_GLOB_FILES + 1)
  } catch (e) {
    if (isAbortError(e)) throw e
    logError(e)
    return { ok: false, message: `${entry}: ${errorMessage(e)} — list the files with Glob instead.` }
  }
  // The call was cancelled; its result is discarded, as a cancelled Read's is.
  if (matches.incomplete === 'aborted') throw new AbortError()
  if (matches.incomplete !== null) {
    return {
      ok: false,
      message: `${entry}: the listing stopped before it finished — narrow the pattern.`,
    }
  }
  if (matches.files.length > MAX_GLOB_FILES) {
    return {
      ok: false,
      message: `${entry} matches more than ${MAX_GLOB_FILES} files; ${PER_CALL} — narrow the pattern or split it.`,
    }
  }
  return { ok: true, paths: matches.files }
}

/** A path as the batch compares two of them (batchRead.ts, distinctPaths). */
function absoluteOf(entry: string, cwd: string): string {
  try {
    return expandPath(entry, cwd)
  } catch (e) {
    // A null byte: validateInput refuses the path, naming it, so it stays in
    // the list as written.
    logError(e)
    return entry
  }
}
