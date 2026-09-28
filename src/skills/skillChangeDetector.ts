/**
 * Hot reload for skills and legacy commands. The detector watches the
 * directories they load from; when files there change, the ConfigChange hooks
 * may veto the reload, the skill and command caches are dropped, and the
 * subscribers (the REPL and headless streaming) re-read the command list.
 * Skills the loader discovers mid-session reach the same subscribers.
 *
 * This module wires the detector to the rest of the CLI. Its parts live in
 * src/skills/changeDetection/:
 *
 * - watchedLocations: the directories watched
 * - ignoredPaths: what never counts as a change
 * - fileWatcher: chokidar, and why Bun polls
 * - changeBatch: the quiet period that makes a burst one reload
 * - reload: hooks, then caches, then subscribers
 * - subscribers: each subscriber called on its own
 * - lifecycle: idle, starting, watching, disposed
 */
import { resetSentSkillNames } from 'src/agent/attachments/attachments.js'
import { clearCommandMemoizationCaches, clearCommandsCache } from 'src/commands/commands.js'
import { getAdditionalDirectoriesForClaudeMd } from 'src/platform/bootstrap/state.js'
import { executeConfigChangeHooks, hasBlockingResult } from 'src/platform/lifecycleHooks/hooks.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { pathExists } from 'src/shared/fs/file.js'
import { logError } from 'src/shared/log.js'
import { watchSkillFiles } from 'src/skills/changeDetection/fileWatcher.js'
import { createSkillChangeDetector } from 'src/skills/changeDetection/lifecycle.js'
import { findWatchedLocations } from 'src/skills/changeDetection/watchedLocations.js'
import { onDynamicSkillsLoaded } from 'src/skills/loadSkillsDir.js'

export type { SkillChangeTimingOverrides } from 'src/skills/changeDetection/lifecycle.js'

export const skillChangeDetector = createSkillChangeDetector({
  findLocations: () =>
    findWatchedLocations({
      configHome: getClaudinConfigHomeDir(),
      cwd: process.cwd(),
      additionalDirectories: getAdditionalDirectoriesForClaudeMd(),
      exists: pathExists,
    }),
  watchFiles: watchSkillFiles,
  isBlockedByHooks: async changedFile =>
    hasBlockingResult(await executeConfigChangeHooks('skills', changedFile)),
  dropSkillCaches: () => {
    // Also drops the skill and legacy-command listings (clearSkillCaches).
    clearCommandsCache()
    resetSentSkillNames()
  },
  dropCommandLists: clearCommandMemoizationCaches,
  onDynamicSkillsLoaded,
  registerCleanup,
  logError,
})
