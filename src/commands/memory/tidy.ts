import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memdir/paths.js'
import type { LocalJSXCommandOnDone } from 'src/types/command.js'
import { buildMemoryTidyPrompt } from './tidyPrompt.js'
import { resolveTidyTeamRoot } from './tidyTeam.js'

/**
 * Dispatch logic for `/memory` subcommands, kept in a pure module (no ink
 * imports) so it stays unit-testable — memory.tsx's import chain reaches
 * src/ink.js, which cannot load under `bun test`.
 */

export function parseMemorySubcommand(args: string): 'tidy' | null {
  return args.trim() === 'tidy' ? 'tidy' : null
}

/**
 * Runs `/memory tidy`: hands the model a conservative duplicate-merge prompt
 * via metaMessages and lets the main conversation do the work (the Bash
 * permission prompt on each `rm` is the human gate). Returns null because no
 * JSX is rendered — the same pattern as /goal set.
 *
 * Latent trap: the REPL's immediate-command dispatcher (src/screens/REPL.tsx)
 * ignores `shouldQuery` — it would inject the metaMessages but never fire the
 * query. Unreachable today (`/memory` is not `immediate: true`), but if that
 * ever changes, tidy would print "Running memory tidy…" and silently no-op.
 */
export function runMemoryTidy(onDone: LocalJSXCommandOnDone): null {
  if (!isAutoMemoryEnabled()) {
    onDone(
      'Memory tidy unavailable: auto memory is disabled (autoMemoryEnabled is false, or CLAUDE_CODE_DISABLE_AUTO_MEMORY is set).',
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
