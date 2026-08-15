/**
 * Read-only tool-result cache invalidation for writes.
 *
 * Extracted from toolExecution.ts so it can be unit-tested directly: that
 * module pulls in the full tool registry (→ ink + the build-only analytics
 * stub), so it cannot be imported under `bun test`. The dispatch here depends
 * only on tool-name constants, the apply_patch path helper, and the cache —
 * all ink-free — so the wiring is testable in isolation.
 */

import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { applyPatchCacheInvalidationPaths } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { ENTER_WORKTREE_TOOL_NAME } from 'src/tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from 'src/tools/ExitWorktreeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import { invalidateAll, invalidateForPath } from 'src/agent/tools/toolResultCache.js'

/**
 * Drop cached read-only tool results that may have been invalidated by a
 * write. File-targeted writes invalidate by path; shell-style writes (Bash,
 * PowerShell, Monitor) clear everything because the command can touch any path.
 * Worktree enter/exit also clear everything — they don't write, but they
 * process.chdir(), which silently repoints every relative-path cache key.
 */
export function invalidateCacheForWrite(
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (toolName === FILE_EDIT_TOOL_NAME || toolName === FILE_WRITE_TOOL_NAME) {
    const p = input.file_path
    if (typeof p === 'string') invalidateForPath(p)
    return
  }
  if (toolName === NOTEBOOK_EDIT_TOOL_NAME) {
    const p = input.notebook_path
    if (typeof p === 'string') invalidateForPath(p)
    return
  }
  if (toolName === APPLY_PATCH_TOOL_NAME) {
    const patchText = input.patchText
    if (typeof patchText === 'string') {
      for (const p of applyPatchCacheInvalidationPaths({ patchText })) {
        invalidateForPath(p)
      }
    }
    return
  }
  if (
    toolName === ENTER_WORKTREE_TOOL_NAME ||
    toolName === EXIT_WORKTREE_TOOL_NAME
  ) {
    // Worktree enter/exit run process.chdir() to repoint the working dir. Cache
    // keys are `tool::stableStringify(input)` with no cwd component, so every
    // relative-path entry (Read/Glob/Grep/LSP) would now resolve against the
    // wrong directory and serve a stale hit. Clear everything.
    invalidateAll()
    return
  }
  if (
    toolName === BASH_TOOL_NAME ||
    toolName === POWERSHELL_TOOL_NAME ||
    toolName === MONITOR_TOOL_NAME
  ) {
    // Monitor runs the same Shell.exec() as Bash (background-flavored), so a
    // monitored command can touch any path — clear everything, like Bash.
    invalidateAll()
  }
}
