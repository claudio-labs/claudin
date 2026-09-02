import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { clearSystemPromptSections } from 'src/agent/prompts/systemPromptSections.js'
import { invalidateAll as invalidateToolResultCache } from 'src/agent/tools/toolResultCache.js'
import { clearMemoryFileCaches } from 'src/memory/instructions/claudemd.js'
import { loadMarkdownFilesForSubdir } from 'src/memory/instructions/markdownConfigLoader.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { updateHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { getProjectDir } from 'src/sessions/sessionStoragePortable.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import { getIsGit } from 'src/vcs/git/git.js'

export type RerootResult = {
  previousCwd: string
  newCwd: string
}

// Where the session was before the last reroot, for `/cd -`. Session-scoped
// and deliberately not persisted: it is a convenience, not state to restore.
let previousSessionDir: string | null = null

export function getPreviousSessionDir(): string | null {
  return previousSessionDir
}

/**
 * Move the whole session to `targetDir`: the process cwd, the session root
 * (permissions, plans) and the project identity (skills, history, auto-memory).
 *
 * A Bash `cd` moves only getCwd(); this is the re-root. Everything derived
 * from a directory is cached somewhere, so the caller gets a directory that
 * is consistent with the caches only because of clearRerootedCaches() below.
 *
 * Throws if the target does not exist (setCwd) or cannot be entered (chdir);
 * in both cases no session state has moved.
 */
export function rerootSession(targetDir: string): RerootResult {
  const previousCwd = getCwd()

  // setCwd first: it realpaths (matching `pwd -P`) and throws a friendly
  // error when the path is gone, and chdir should land on that same
  // resolved path rather than on the symlinked one.
  setCwd(targetDir)
  const newCwd = getCwd()
  try {
    process.chdir(newCwd)
  } catch (e) {
    setCwd(previousCwd)
    throw e
  }

  // Pin the transcript to the project dir it is already being written to,
  // BEFORE originalCwd moves: getTranscriptPath() derives from originalCwd
  // whenever sessionProjectDir is null, so moving originalCwd without this
  // splits the session's .jsonl across two project dirs (gh-30217 class).
  // switchSession is the only setter — sessionId and sessionProjectDir move
  // atomically (CC-34) — so the current session id goes back in unchanged.
  // Its sessionSwitched emit drops a pending /loop wakeup; callers surface
  // that to the user.
  switchSession(
    getSessionId(),
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
  )

  setOriginalCwd(newCwd)
  setProjectRoot(newCwd)
  previousSessionDir = previousCwd

  clearRerootedCaches()

  return { previousCwd, newCwd }
}

/**
 * Every cache that keys on — or was computed from — the directory the session
 * just left. The first four are what the worktree paths already clear; the
 * rest are the ones a *full* re-root additionally invalidates.
 */
function clearRerootedCaches(): void {
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
  // The read-only tool-result cache (Read/Glob/Grep/LSP) keys relative paths
  // with no cwd component. cacheInvalidation.ts only reaches it for the
  // worktree TOOLS, so a slash-command chdir has to invalidate it here or
  // stale hits resolve against the old directory.
  invalidateToolResultCache()
  // clearMemoryFileCaches() covers getMemoryFiles but not the subdir loader.
  loadMarkdownFilesForSubdir.cache?.clear?.()
  // Keyed on getProjectRoot(), which just moved.
  getAutoMemPath.cache?.clear?.()
  // Memoized with no key at all: without this, moving between a repo and a
  // non-repo keeps the old answer for the rest of the process.
  getIsGit.cache?.clear?.()
  // Re-read hooks from the new directory's .claudin/settings.json.
  updateHooksConfigSnapshot()
}
