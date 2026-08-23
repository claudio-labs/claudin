/**
 * Shared transcript walking for the token benches.
 *
 * Every bench that measures what the agent actually spent reads the same thing:
 * `~/.claudin/projects/<slug>/*.jsonl`, one JSON message per line, with
 * `tool_use` blocks to be paired against `tool_result` blocks by `tool_use_id`.
 * This module owns that walk so a bench can describe what it wants to measure
 * instead of re-deriving the file layout.
 *
 * Transcripts are read as DATA, never as context: the per-line JSON is parsed
 * and thrown away, and callers are expected to print aggregates. A corpus
 * written out of here holds the user's real command output — see
 * `extract-bash-corpus.ts` for where that is allowed to land.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Block = Record<string, unknown>

/** A `tool_use` paired with the `tool_result` that answered it. */
export type ToolCall = {
  /** Transcript file it came from — the session identity for per-session stats. */
  readonly file: string
  readonly tool: string
  readonly input: Block
  /** Result content flattened to text; `''` when the result carried no text. */
  readonly text: string
  readonly chars: number
  readonly isError: boolean
}

/** A transcript on disk. */
export type Transcript = {
  readonly path: string
  readonly mtimeMs: number
  /** True for `<project>/<session>/subagents/*.jsonl` — a fork's own transcript. */
  readonly isSubagent: boolean
}

/** The config dir, honouring `CLAUDIN_CONFIG_DIR` the way the app does. */
export function configDir(): string {
  return process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
}

/** A `tool_result`'s content is either a string or an array of text blocks. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      part && typeof part === 'object' && typeof (part as Block).text === 'string'
        ? ((part as Block).text as string)
        : '',
    )
    .join('')
}

export function projectDirs(explicit?: string | null): string[] {
  const root = join(configDir(), 'projects')
  if (explicit) return [join(root, explicit)]
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .map(name => join(root, name))
    .filter(p => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
}

/**
 * Transcript paths, newest first, optionally limited to files modified within
 * `maxAgeDays`. A bench that reports a date range needs the mtime anyway, so it
 * is returned rather than made the caller stat again.
 *
 * The walk RECURSES, and that is load-bearing rather than tidy: a session's
 * sub-agents write to `<project>/<session>/subagents/*.jsonl`, and forking is
 * this repo's default for anything past a couple of searches. A depth-1 listing
 * finds 721 files here against 2,229 on disk and misses most of the tool traffic
 * — a bench built on it measures the orchestrator alone and reports it as the
 * whole agent.
 */
export function transcriptFiles(
  dirs: readonly string[],
  maxAgeDays?: number,
): Transcript[] {
  const cutoff =
    maxAgeDays === undefined ? 0 : Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const out: Transcript[] = []
  const walk = (dir: string, isSubagent: boolean): void => {
    let names: Dirent[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, isSubagent || entry.name === 'subagents')
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      let mtimeMs: number
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (mtimeMs < cutoff) continue
      out.push({ path, mtimeMs, isSubagent })
    }
  }
  for (const dir of dirs) walk(dir, false)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Yields every tool call in one transcript.
 *
 * The whole file is indexed before results are matched: a `tool_use` normally
 * precedes its result, but after a resume the two can land out of order, and a
 * one-pass matcher silently drops those pairs.
 */
export function* toolCallsInFile(file: string): Generator<ToolCall> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = raw.split('\n')
  const uses = new Map<string, { name: string; input: Block }>()
  const results: { id: string; text: string; isError: boolean }[] = []

  for (const line of lines) {
    if (!line) continue
    let parsed: Block
    try {
      parsed = JSON.parse(line) as Block
    } catch {
      continue
    }
    const message = parsed.message as Block | undefined
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Block
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        uses.set(b.id, {
          name: typeof b.name === 'string' ? b.name : '',
          input: (b.input as Block) ?? {},
        })
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.push({
          id: b.tool_use_id,
          text: contentText(b.content),
          isError: b.is_error === true,
        })
      }
    }
  }

  for (const result of results) {
    const use = uses.get(result.id)
    if (!use) continue
    yield {
      file,
      tool: use.name,
      input: use.input,
      text: result.text,
      chars: result.text.length,
      isError: result.isError,
    }
  }
}

/** Yields every tool call across a set of transcripts. */
export function* toolCalls(
  files: readonly Transcript[],
): Generator<ToolCall> {
  for (const file of files) yield* toolCallsInFile(file.path)
}

export function pct(part: number, whole: number): string {
  if (whole === 0) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

// ---------------------------------------------------------------------------
// Bash replay corpus — shape and location
// ---------------------------------------------------------------------------

/**
 * One recorded Bash call. The three flags say how much of the RAW output this
 * text still is; see `extract-bash-corpus.ts` for why each matters.
 */
export type CorpusEntry = {
  command: string
  text: string
  chars: number
  isError: boolean
  /** Exit status parsed off the `Exit code N` prefix the error renderer adds. */
  exitCode: number | null
  alreadyFiltered: boolean
  truncatedUpstream: boolean
  hardCapped: boolean
}

/**
 * OUTSIDE the repository, on purpose: these are verbatim command outputs from
 * real sessions — absolute paths, source code, and whatever an `env` or a
 * `curl -v` printed. A `.gitignore` entry is one line of defence and `git add -f`
 * walks past it; a path the repo cannot reach is the invariant.
 */
export const CORPUS_DIR = join(configDir(), 'bench', 'bash-corpus')
export const CORPUS_PATH = join(CORPUS_DIR, 'corpus.jsonl')

export function readCorpus(): CorpusEntry[] {
  return readFileSync(CORPUS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as CorpusEntry)
}
