import { resolve } from 'path'

/**
 * The repository root, for every script under `scripts/`.
 *
 * This is the ONE file allowed to count `..` levels. Before it existed, ~45
 * scripts each derived the root from their own depth
 * (`resolve(import.meta.dir, '..', '..')`), so moving a script between
 * subdirectories silently broke it — and broke it at *runtime*, since
 * `tsconfig.json` only includes `src/**`, so `bun run typecheck` never looks
 * at `scripts/`.
 *
 * Import it instead of recomputing:
 *
 *   import { REPO_ROOT } from '../repoRoot.js'
 *
 * Keep this file at the top level of `scripts/`.
 */
export const REPO_ROOT = resolve(import.meta.dir, '..')
