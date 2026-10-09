import {
  getAutoMemPath,
  getGlobalMemPath,
  isAutoMemoryEnabled,
  isGlobalMemoryEnabled,
} from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import { buildMemorySortPrompt } from 'src/commands/memory/sortPrompt.js'
import { buildMemoryTidyPrompt } from 'src/commands/memory/tidyPrompt.js'

/**
 * Dispatch logic for `/memory` subcommands, kept in a pure module (no ink
 * imports) so it stays unit-testable — memory.tsx's import chain reaches
 * src/terminal/ink.js, which cannot load under `bun test`.
 */

export type MemorySubcommand = 'tidy' | 'sort' | 'global' | 'private' | 'team'

const SUBCOMMANDS: readonly MemorySubcommand[] = [
  'tidy',
  'sort',
  'global',
  'private',
  'team',
]

/**
 * `global`, `private` and `team` open the dialog straight into that directory's browser;
 * `tidy` and `sort` skip the dialog entirely. Anything else falls through to
 * the normal dialog rather than erroring — a typo should not cost the user
 * their `/memory`.
 */
export function parseMemorySubcommand(args: string): MemorySubcommand | null {
  const trimmed = args.trim()
  return SUBCOMMANDS.find(name => name === trimmed) ?? null
}

/** The global memory dir while it is on, else null. */
function resolveGlobalRoot(): string | null {
  return isGlobalMemoryEnabled() ? getGlobalMemPath() : null
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
      buildMemoryTidyPrompt(
        getAutoMemPath(),
        getTeamMemPath(),
        resolveGlobalRoot(),
      ),
    ],
  })
  return null
}

/**
 * Runs `/memory sort`: the same shape as tidy. It files team memories into
 * `decisions/`, `bugs/`, `docs/`, and — with the global dir on — promotes
 * what is about the user from the private dir to the global one. The Bash
 * permission prompt on each `git mv`/`mv`/`rm` is the human veto per file.
 */
export function runMemorySort(onDone: LocalJSXCommandOnDone): null {
  if (!isAutoMemoryEnabled()) {
    onDone(
      'Memory sort unavailable: auto memory is disabled (autoMemoryEnabled is false, or CLAUDIN_DISABLE_AUTO_MEMORY is set).',
      { display: 'system' },
    )
    return null
  }
  const globalRoot = resolveGlobalRoot()

  const what = [
    'filing team memories into decisions/, bugs/ and docs/',
    ...(globalRoot === null ? [] : ['promoting what is about you to the global memory']),
  ].join(', and ')
  onDone(
    `Running memory sort — ${what}…`,
    {
      display: 'system',
      shouldQuery: true,
      metaMessages: [
        buildMemorySortPrompt(
          getTeamMemPath(),
          globalRoot === null
            ? null
            : { privateRoot: getAutoMemPath(), globalRoot },
        ),
      ],
    },
  )
  return null
}
