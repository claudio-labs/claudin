/**
 * Folds a path for comparison, never for display or I/O.
 *
 * The fold is the same on every platform: the protected-path checks have to
 * hold on case-insensitive filesystems (macOS, Windows) even when the host
 * that runs the check is case-sensitive.
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}
