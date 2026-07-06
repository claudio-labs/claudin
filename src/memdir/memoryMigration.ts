import { cpSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { logError } from '../utils/log.js'

const ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * One-time, copy-only migration of a project's auto-memory from the legacy
 * global location (~/.claudin/projects/<slug>/memory/) into the new
 * project-local default (<gitRoot>/.claudin/memory/).
 *
 * Idempotent by construction (no marker file): once newDir has any memory
 * content, this is a no-op, so it's safe to call on every getAutoMemPath()
 * resolution. Never deletes or moves oldDir — it's left untouched as a
 * backup in case something goes wrong with the new location.
 */
export function migrateGlobalMemoryIfNeeded(
  oldDir: string,
  newDir: string,
): void {
  if (oldDir === newDir) return
  if (hasMemoryContent(newDir)) return
  if (!hasMemoryContent(oldDir)) return
  try {
    cpSync(oldDir, newDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    })
  } catch (e) {
    logError(
      new Error(
        `Failed to migrate auto-memory from ${oldDir} to ${newDir}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ),
    )
  }
}

function hasMemoryContent(dir: string): boolean {
  try {
    if (readFileSync(join(dir, ENTRYPOINT_NAME), 'utf-8').trim()) {
      return true
    }
  } catch {
    // No index yet.
  }
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      d =>
        d.isFile() && d.name.endsWith('.md') && d.name !== ENTRYPOINT_NAME,
    )
  } catch {
    return false
  }
}
