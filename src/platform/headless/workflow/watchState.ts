// Processed-trigger dedup for `claudin workflow watch` (R3).
//
// One JSON file per repo at .claudin/workflow-watch-state.json (already
// git-ignored by the blanket .claudin/ ignore). Keyed by a stable trigger id
// (e.g. "#123") so a given issue fires exactly one run, ever, across restarts.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { getCwd } from 'src/shared/fs/cwd.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

const STATE_REL_PATH = '.claudin/workflow-watch-state.json'

type WatchStateFile = { processed: string[] }

function stateFilePath(): string {
  return join(getCwd(), STATE_REL_PATH)
}

/** Load the set of already-processed trigger ids. Empty on first run. */
export async function loadProcessed(): Promise<Set<string>> {
  try {
    const raw = await readFile(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as WatchStateFile
    return new Set(Array.isArray(parsed.processed) ? parsed.processed : [])
  } catch (e) {
    if (isENOENT(e)) return new Set()
    logError(
      `failed to read workflow-watch state, starting empty: ${e instanceof Error ? e.message : String(e)}`,
    )
    return new Set()
  }
}

/**
 * Persist the processed set. Writes to a temp file then renames it over the
 * target so a crash mid-write can never leave a corrupt/truncated state file —
 * a corrupt read fails open to an empty set, which would re-dispatch every
 * already-processed trigger (duplicate runs + duplicate PRs).
 */
export async function saveProcessed(processed: Set<string>): Promise<void> {
  const path = stateFilePath()
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    const data: WatchStateFile = { processed: [...processed] }
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path) // atomic on the same filesystem
  } catch (e) {
    logError(
      `failed to persist workflow-watch state: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
