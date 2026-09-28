/**
 * What `/update-config` was asked for. `/init` passes `[hooks-only]` plus a
 * one-line summary when all it needs is the hooks reference; anything else
 * is a request for the full settings guidance.
 */
const HOOKS_ONLY_PREFIX = '[hooks-only]'

export type UpdateConfigRequest =
  | { readonly mode: 'hooks-only'; readonly task?: string }
  | { readonly mode: 'full'; readonly request?: string }

/** The prefix counts only as the exact text at the very start. */
export function parseUpdateConfigRequest(args: string): UpdateConfigRequest {
  if (args.startsWith(HOOKS_ONLY_PREFIX)) {
    return {
      mode: 'hooks-only',
      task: nonBlank(args.slice(HOOKS_ONLY_PREFIX.length)),
    }
  }
  return { mode: 'full', request: nonBlank(args) }
}

/** Blank text asks for nothing, so it becomes no task or request at all. */
function nonBlank(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}
