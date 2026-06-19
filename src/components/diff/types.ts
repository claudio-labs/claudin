import type { StructuredPatchHunk } from 'diff'
import type { DiffFile } from '../../hooks/useDiffData.js'
import type { TurnDiff } from '../../hooks/useTurnDiffs.js'

/** One git repo's working-tree changes, used for per-project grouping. */
export type RepoGroup = {
  root: string
  /** basename(root), shown in the group header. */
  name: string
  branch: string
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
}

/** Selectable source in the Local Changes tab. */
export type DiffSource =
  | { type: 'working' }
  | { type: 'turn'; turn: TurnDiff }
  | { type: 'stash'; ref: string; subject: string }

/**
 * One row group in the collapsible diff render model: either a real hunk
 * (possibly a synthetic context-only hunk for revealed lines) or a collapsed
 * gap rendered as a `··· N lines` marker.
 */
export type DiffSegment =
  | { kind: 'hunk'; hunk: StructuredPatchHunk }
  | { kind: 'gap'; id: string; startLine: number; lineCount: number }
