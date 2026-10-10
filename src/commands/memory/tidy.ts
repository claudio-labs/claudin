import {
  type GlobalMemoryOff,
  globalMemoryOffReason,
  isAutoMemoryEnabled,
} from 'src/memory/memdir/paths.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import {
  MEMORY_SCOPE_SPECS,
  MEMORY_SCOPES,
  type MemoryScope,
  withoutTrailingSep,
} from 'src/memory/memdir/memoryScopes.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import { buildMemorySortPrompt } from 'src/commands/memory/sortPrompt.js'
import { buildMemoryTidyPrompt } from 'src/commands/memory/tidyPrompt.js'

/**
 * Dispatch logic for `/memory` subcommands, kept in a pure module (no ink
 * imports) so it stays unit-testable — memory.tsx's import chain reaches
 * src/terminal/ink.js, which cannot load under `bun test`.
 */

/** The actions, then one subcommand per memory directory, named as its scope. */
export const SUBCOMMANDS = ['tidy', 'sort', ...MEMORY_SCOPES] as const
export type MemorySubcommand = (typeof SUBCOMMANDS)[number]

/**
 * A scope (`global`, `private`, `team`) opens the dialog straight into that
 * directory's browser — or, when the directory is off, says why
 * (memoryScopeOffMessage); `tidy` and `sort` skip the dialog entirely.
 * Anything else falls through to the normal dialog rather than erroring — a
 * typo should not cost the user their `/memory`.
 */
export function parseMemorySubcommand(args: string): MemorySubcommand | null {
  const trimmed = args.trim()
  return SUBCOMMANDS.find(name => name === trimmed) ?? null
}

/** Whether a subcommand names a memory directory rather than an action. */
export function isScopeSubcommand(
  subcommand: MemorySubcommand,
): subcommand is MemoryScope {
  return MEMORY_SCOPES.some(scope => scope === subcommand)
}

const AUTO_MEMORY_OFF =
  'auto memory is disabled (autoMemoryEnabled is false, or CLAUDIN_DISABLE_AUTO_MEMORY is set)'

/**
 * Why `/memory <scope>` has no directory to open, for a scope that is off:
 * the reason paths.ts globalMemoryOffReason gives — the one place that
 * decides it — or memory being off altogether. Pure over `off`.
 */
export function explainScopeOff(
  scope: MemoryScope,
  off: GlobalMemoryOff | null,
): string {
  const title = MEMORY_SCOPE_SPECS[scope].title
  if (off?.reason === 'auto-memory-off') return `${title} is off: ${AUTO_MEMORY_OFF}.`
  if (scope !== 'global' || off === null) return `${title} is off.`
  switch (off.reason) {
    case 'env':
      return `${title} is off: CLAUDIN_GLOBAL_MEMORY=0 is set. Unset it to share memories about you across projects.`
    case 'cowork-override':
      return `${title} is off: a Cowork/SDK caller set CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, so memory is that directory alone.`
    case 'nested':
      return `${title} is off: the global dir ${withoutTrailingSep(off.globalDir)} and this project's private dir ${withoutTrailingSep(off.privateDir)} are one inside the other, so a memory would belong to both. Point autoMemoryGlobalDirectory or autoMemoryDirectory elsewhere.`
  }
}

/** The message for `/memory <scope>` when that directory is off. */
export function memoryScopeOffMessage(scope: MemoryScope): string {
  return explainScopeOff(
    scope,
    isAutoMemoryEnabled() ? globalMemoryOffReason() : { reason: 'auto-memory-off' },
  )
}

/**
 * Runs `/memory tidy`: hands the model a conservative duplicate-merge prompt
 * via metaMessages and lets the main conversation do the work. The Bash
 * permission prompt on each `rm` is the human gate; the merged file's edit
 * and the index edits go through the memory carve-out without a prompt.
 * Returns null because no JSX is rendered — the same pattern as /goal set.
 *
 * Latent trap: the REPL's immediate-command dispatcher (src/agent/repl/REPL.tsx)
 * ignores `shouldQuery` — it would inject the metaMessages but never fire the
 * query. Unreachable today (`/memory` is not `immediate: true`), but if that
 * ever changes, tidy would print "Running memory tidy…" and silently no-op.
 */
export function runMemoryTidy(onDone: LocalJSXCommandOnDone): null {
  const dirs = getMemoryDirs()
  if (dirs.length === 0) {
    onDone(`Memory tidy unavailable: ${AUTO_MEMORY_OFF}.`, { display: 'system' })
    return null
  }

  onDone('Running memory tidy — merging duplicate memories…', {
    display: 'system',
    shouldQuery: true,
    metaMessages: [buildMemoryTidyPrompt(dirs)],
  })
  return null
}

/**
 * Runs `/memory sort`: the same shape as tidy. It files team memories into
 * `decisions/`, `bugs/`, `docs/`, and — with the global dir on — promotes
 * what is about the user from the private dir to the global one. The Bash
 * permission prompt on each `git mv`/`mv -n`/`rm` is the human veto per file;
 * what is written without a prompt — a split's new global file, a merge's
 * edit, the frontmatter keys and index edits — the prompt names and asks the
 * model to report (sortPrompt.ts).
 */
export function runMemorySort(onDone: LocalJSXCommandOnDone): null {
  const dirs = getMemoryDirs()
  if (dirs.length === 0) {
    onDone(`Memory sort unavailable: ${AUTO_MEMORY_OFF}.`, { display: 'system' })
    return null
  }
  const what = [
    'filing team memories into decisions/, bugs/ and docs/',
    ...(dirs.some(dir => dir.scope === 'global')
      ? ['promoting what is about you to the global memory']
      : []),
  ].join(', and ')
  onDone(
    `Running memory sort — ${what}…`,
    {
      display: 'system',
      shouldQuery: true,
      metaMessages: [buildMemorySortPrompt(dirs)],
    },
  )
  return null
}
