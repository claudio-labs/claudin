/**
 * Which memory files a session wrote, read back from its transcript — the
 * provenance the dream digest hands over beside each session, so a memory
 * that looks drifted can be traced to the conversation that wrote it.
 *
 * Derived, never stored. The transcript already records every write, and
 * memory's own rule is not to save what the history holds; a `sources:` key
 * stamped into the frontmatter would have duplicated it and still missed the
 * main agent's writes. What a transcript cannot hold is the extraction fork's
 * writes (it runs with skipTranscript), so the digest lists what else changed
 * in the period by mtime instead (dreamDigest.ts).
 */
import { createReadStream } from 'fs'
import { basename } from 'path'
import { createInterface } from 'readline'
import { findMemoryDir, type MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import { safeParseJSON } from 'src/shared/data/json.js'
import { writtenPaths } from 'src/tools/shared/writtenPaths.js'

const TOOL_USE_MARK = '"tool_use"'

type TranscriptEvent = { type?: unknown; cwd?: unknown; message?: { content?: unknown } }

/**
 * Each root as a transcript line spells it: JSON escapes a backslash (every
 * separator of a Windows path), so the raw root alone never matches there.
 */
function rootNeedles(dirs: readonly MemoryDir[]): string[] {
  return [...new Set(dirs.flatMap(dir => [dir.root, JSON.stringify(dir.root).slice(1, -1)]))]
}

/**
 * The memory files one transcript line wrote. Only a line carrying a tool
 * use and a memory root is parsed — a transcript runs to megabytes and nearly
 * every line is neither — and one that does not parse writes nothing.
 */
function writesOfLine(line: string, cwd: string, dirs: readonly MemoryDir[], needles: readonly string[]): string[] {
  if (!line.includes(TOOL_USE_MARK) || !needles.some(needle => line.includes(needle))) return []
  const event = safeParseJSON(line, false) as TranscriptEvent | null
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return []
  const at = typeof event.cwd === 'string' ? event.cwd : cwd
  return (event.message.content as Array<{ type?: unknown; input?: unknown }>).flatMap(block =>
    block?.type === 'tool_use'
      ? writtenPaths(block.input, at).filter(path => basename(path) !== ENTRYPOINT_NAME && findMemoryDir(dirs, path) !== null)
      : [],
  )
}

/** The memory files the assistant turns of `lines` wrote, in order, once each, indexes left out. */
export function memoryWritesFromTranscript(
  lines: Iterable<string>,
  cwd: string,
  dirs: readonly MemoryDir[],
): string[] {
  const needles = rootNeedles(dirs)
  const written = new Set<string>()
  for (const line of lines) for (const path of writesOfLine(line, cwd, dirs, needles)) written.add(path)
  return [...written]
}

/** memoryWritesFromTranscript over a transcript file, streamed line by line. */
export async function readMemoryWrites(
  transcriptPath: string,
  cwd: string,
  dirs: readonly MemoryDir[],
): Promise<string[]> {
  const needles = rootNeedles(dirs)
  const written = new Set<string>()
  const reader = createInterface({ input: createReadStream(transcriptPath, 'utf8'), crlfDelay: Infinity })
  for await (const line of reader) for (const path of writesOfLine(line, cwd, dirs, needles)) written.add(path)
  return [...written]
}
