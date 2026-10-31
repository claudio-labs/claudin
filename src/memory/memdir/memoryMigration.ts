import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import { logError } from 'src/shared/log.js'

/** Left in the legacy dir once it has been copied, so it is never copied again. */
const MIGRATED_MARKER = '.migrated'

/** The legacy team dir: never copied, as the project-local one is git-tracked. */
const TEAM_DIRNAME = 'team'

/**
 * One-time, copy-only migration of a project's auto-memory from the legacy
 * per-project location under the config home
 * (~/.claudin/projects/<slug>/memory/) into the
 * project-local default (<gitRoot>/.claudin/memory/).
 *
 * Once: the copy leaves a `.migrated` marker in the legacy dir, so a private
 * dir that empties later is not refilled with that old snapshot. Never the
 * legacy `team/`: the project-local team dir is git-tracked, and the legacy
 * copies of memories moved, renamed or deleted since would come back as
 * untracked files ready to be committed (team bug
 * legacy-memory-migration-resurrects-team-files). Never deletes or moves the
 * legacy dir — it stays as a backup and only gains the marker.
 */
export function migrateLegacyMemoryIfNeeded(
  oldDir: string,
  newDir: string,
): void {
  if (oldDir === newDir) return
  if (existsSync(join(oldDir, MIGRATED_MARKER))) return
  if (hasMemoryContent(newDir)) return
  if (!hasMemoryContent(oldDir)) return
  try {
    cpSync(oldDir, newDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: source => {
        const rel = relative(oldDir, source)
        return rel !== TEAM_DIRNAME && !rel.startsWith(TEAM_DIRNAME + sep)
      },
    })
    writeFileSync(join(oldDir, MIGRATED_MARKER), `${newDir}\n`)
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
