import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import { buildMemoryTidyPrompt } from 'src/commands/memory/tidyPrompt.js'
import { resolveTidyTeamRoot } from 'src/commands/memory/tidyTeam.js'

/**
 * Dispatch logic for `/memory` subcommands, kept in a pure module (no ink
 * imports) so it stays unit-testable — memory.tsx's import chain reaches
 * src/terminal/ink.js, which cannot load under `bun test`.
 */

export type MemorySubcommand = 'tidy' | 'private' | 'team'

const SUBCOMMANDS: readonly MemorySubcommand[] = ['tidy', 'private', 'team']

/**
 * `private` and `team` open the dialog straight into that directory's browser;
 * `tidy` skips the dialog entirely. Anything else falls through to the normal
 * dialog rather than erroring — a typo should not cost the user their `/memory`.
 */
export function parseMemorySubcommand(args: string): MemorySubcommand | null {
  const trimmed = args.trim()
  return SUBCOMMANDS.find(name => name === trimmed) ?? null
}

/**
 * Runs `/memory tidy`: hands the model a conservative duplicate-merge prompt
 * via metaMessages and lets the main conversation do the work (the Bash
 * permission prompt on each `rm` is the human gate). Returns null because no
 * JSX is rendered — the same pattern as /goal set.
 *
 * Latent trap: the REPL's immediate-command dispatcher (src/agent/repl/REPL.tsx)
 * ignores `shouldQuery` — it would inject the metaMessages but never fire the
 * query. Unreachable today (`/memory` is not `immediate: true`), but if that
 * ever changes, tidy would print "Running memory tidy…" and silently no-op.
 */
export function runMemoryTidy(onDone: LocalJSXCommandOnDone): null {
  if (!isAutoMemoryEnabled()) {
    onDone(
      'Memory tidy unavailable: auto memory is disabled (autoMemoryEnabled is false, or CLAUDIN_DISABLE_AUTO_MEMORY is set).',
      { display: 'system' },
    )
    return null
  }

  onDone('Running memory tidy — merging duplicate memories…', {
    display: 'system',
    shouldQuery: true,
    metaMessages: [
      buildMemoryTidyPrompt(getAutoMemPath(), resolveTidyTeamRoot()),
    ],
  })
  return null
}
