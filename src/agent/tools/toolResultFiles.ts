/**
 * Where tool results are saved, and under what name. Split from
 * toolResultStorage.ts so the context-relief stub (stableStubState) can name
 * the saved copy of a result it clips without importing the storage pipeline.
 *
 * A result is saved under its tool_use_id and a hash of its text: an id can
 * repeat (a provider's per-process `xml_tc_N` counter across a resume, an MCP
 * timestamp id), and a reused file would hold another result than the one the
 * model was shown. The same id and bytes name the same file, so a replay never
 * rewrites it.
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getProjectDir } from 'src/sessions/sessionStoragePortable.js'

// Subdirectory name for tool results within a session
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// XML tag used to wrap persisted output messages
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

/**
 * A result shipped whole at or past this many chars is saved all the same,
 * so a context-relief clip of it later can name the copy (`savedCopyOf`)
 * instead of leaving the model to run the call again. The summarizer used to
 * save the results it cut from about this size; past a tool's own line a
 * result is saved anyway, to be paged.
 */
export const SAVE_WHOLE_FROM_CHARS = 6_000

/**
 * Get the tool results directory for this session (projectDir/sessionId/tool-results)
 */
export function getToolResultsDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId(), TOOL_RESULTS_SUBDIR)
}

/**
 * Where a result goes when the session's directory cannot be written — a full
 * disk, a read-only config dir: a result past its line must still be saved,
 * or the model gets only its first page.
 */
function getFallbackResultsDir(): string {
  return join(tmpdir(), 'claudin-tool-results', getSessionId())
}

/** The directories a result may be saved in, in the order they are tried. */
export function resultDirs(): string[] {
  return [getToolResultsDir(), getFallbackResultsDir()]
}

/**
 * Get the filepath where a tool result would be persisted.
 */
export function getToolResultPath(id: string): string {
  return join(getToolResultsDir(), `${id}.txt`)
}

/** The file a result's text is saved as: its id and a hash of its bytes. */
export function resultFileName(toolUseId: string, text: string): string {
  return `${toolUseId}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.txt`
}

/**
 * Write `text` as `name` in the first results directory that takes it. A file
 * already there holds these very bytes (its name says so), and is kept.
 */
export async function writeResultFile(
  name: string,
  text: string,
): Promise<{ path: string } | { error: unknown }> {
  let lastError: unknown
  for (const dir of resultDirs()) {
    const path = join(dir, name)
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      // Its EEXIST is a file where the directory should be, not a saved result.
      lastError = error
      continue
    }
    try {
      // 'wx' rather than a stat-then-write race.
      await writeFile(path, text, { encoding: 'utf-8', flag: 'wx' })
      return { path }
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST') return { path }
      lastError = error
    }
  }
  return { error: lastError }
}

/** A result's content as the text it is saved as, or undefined when it holds anything but text. */
export function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    texts.push(block.text)
  }
  return texts.join('\n')
}

/**
 * The saved copy of a result, as the model holds it: the file a paged result
 * names, or the file a result shipped whole past SAVE_WHOLE_FROM_CHARS was
 * saved as. Undefined when there is none. Synchronous, for the relief stub; a
 * pure function of the content and the files on disk, so the stub it goes
 * into is the same bytes every time it is built.
 */
export function savedCopyOf(toolUseId: string, content: unknown): string | undefined {
  const text = resultText(content)
  if (text === undefined) return undefined
  if (text.startsWith(PERSISTED_OUTPUT_TAG)) {
    return /saved to: (\S+)\n/.exec(text.slice(0, 2_000))?.[1]
  }
  if (text.length < SAVE_WHOLE_FROM_CHARS || !toolUseId) return undefined
  const name = resultFileName(toolUseId, text)
  for (const dir of resultDirs()) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return undefined
}
