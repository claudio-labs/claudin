export type BatchOutcome =
  | { readonly kind: 'usage' }
  | { readonly kind: 'needs-repository' }
  | { readonly kind: 'orchestrate'; readonly instruction: string }

/**
 * What `/batch` answers, from its trimmed instruction and whether the session
 * is inside a git repository. A missing instruction wins over a missing
 * repository, so a bare `/batch` always explains how to use it.
 */
export function decideBatchOutcome(
  instruction: string,
  inRepository: boolean,
): BatchOutcome {
  if (instruction === '') return { kind: 'usage' }
  if (!inRepository) return { kind: 'needs-repository' }
  return { kind: 'orchestrate', instruction }
}
