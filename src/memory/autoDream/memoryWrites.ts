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
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import { writtenPaths } from 'src/tools/shared/writtenPaths.js'

const TOOL_USE_MARK = '"tool_use"'

/**
 * Each root as a transcript line spells it: JSON escapes a backslash (every
 * separator of a Windows path), so the raw root alone never matches there.
 */
function rootNeedles(roots: readonly string[]): string[] {
  return [...new Set(roots.flatMap(root => [root, JSON.stringify(root).slice(1, -1)]))]
}

/**
 * The memory files the assistant turns of `lines` wrote, in order, once
 * each, indexes left out. Only a line carrying a tool use and one of `roots`
 * is parsed — a transcript runs to megabytes, and nearly every line is
 * neither — and a line that does not parse is skipped.
 */
export function memoryWritesFromTranscript(
  lines: Iterable<string>,
  cwd: string,
  roots: readonly string[],
): string[] {
  const written: string[] = []
  const needles = rootNeedles(roots)
  for (const line of lines) {
    if (!line.includes(TOOL_USE_MARK) || !needles.some(needle => line.includes(needle))) continue
    let event: { type?: unknown; cwd?: unknown; message?: { content?: unknown } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue
    const at = typeof event.cwd === 'string' ? event.cwd : cwd
    for (const block of event.message.content as Array<{ type?: unknown; input?: unknown }>) {
      if (block?.type !== 'tool_use') continue
      for (const path of writtenPaths(block.input, at)) {
        if (basename(path) === ENTRYPOINT_NAME || !roots.some(root => path.startsWith(root))) continue
        if (!written.includes(path)) written.push(path)
      }
    }
  }
  return written
}

/** memoryWritesFromTranscript over a transcript file, streamed line by line. */
export async function readMemoryWrites(
  transcriptPath: string,
  cwd: string,
  roots: readonly string[],
): Promise<string[]> {
  const lines: string[] = []
  const needles = rootNeedles(roots)
  const reader = createInterface({ input: createReadStream(transcriptPath, 'utf8'), crlfDelay: Infinity })
  for await (const line of reader) {
    if (line.includes(TOOL_USE_MARK) && needles.some(needle => line.includes(needle))) lines.push(line)
  }
  return memoryWritesFromTranscript(lines, cwd, roots)
}
