import { dirname, isAbsolute, join, relative, sep } from 'path'
import {
  getManagedClaudeRulesDir,
  getMemoryPath,
  getUserClaudeRulesDir,
} from 'src/platform/config/config.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getProjectInstructionFilePath } from 'src/memory/instructions/projectInstructions.js'
import {
  processMdRules,
  processMemoryFile,
} from 'src/memory/instructions/claudemd/processing.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

/** A single instruction file, or the unconditional rules of a rules directory. */
type SourceKind = 'file' | 'rules'

type SourceRow = {
  type: MemoryType
  kind: SourceKind
  /** The setting source that must be enabled for the walk to read it; `null` is always read. */
  gate: SettingSource | null
}

/** A source at a fixed place: the managed and user files. */
type FixedSource = SourceRow & { path: () => string }

/** A source read in each directory the walk visits. */
type DirectorySource = SourceRow & {
  path: (dir: string, exists: (path: string) => boolean) => string
  /** Checked into the repository, so a nested worktree skips the main checkout's copy. */
  checkedIn: boolean
  /** Also read from a `--add-dir` directory, whatever the setting sources say. */
  fromAddedDirectory: boolean
}

const FIXED_SOURCES: readonly FixedSource[] = [
  { type: 'Managed', kind: 'file', gate: null, path: () => getMemoryPath('Managed') },
  { type: 'Managed', kind: 'rules', gate: null, path: getManagedClaudeRulesDir },
  { type: 'User', kind: 'file', gate: 'userSettings', path: () => getMemoryPath('User') },
  { type: 'User', kind: 'rules', gate: 'userSettings', path: getUserClaudeRulesDir },
]

const DIRECTORY_SOURCES: readonly DirectorySource[] = [
  {
    type: 'Project',
    kind: 'file',
    gate: 'projectSettings',
    checkedIn: true,
    fromAddedDirectory: true,
    path: (dir, exists) => getProjectInstructionFilePath(dir, exists),
  },
  {
    type: 'Project',
    kind: 'file',
    gate: 'projectSettings',
    checkedIn: true,
    fromAddedDirectory: true,
    path: dir => join(dir, '.claudin', 'CLAUDE.md'),
  },
  {
    type: 'Project',
    kind: 'rules',
    gate: 'projectSettings',
    checkedIn: true,
    fromAddedDirectory: true,
    path: dir => join(dir, '.claudin', 'rules'),
  },
  {
    type: 'Local',
    kind: 'file',
    gate: 'localSettings',
    checkedIn: false,
    fromAddedDirectory: false,
    path: dir => join(dir, 'CLAUDE.local.md'),
  },
]

export type WalkStop = { dir: string; skipCheckedIn: boolean }

export function isWithin(path: string, dir: string): boolean {
  const fromDir = relative(dir, path)
  if (fromDir === '') return true
  return !isAbsolute(fromDir) && fromDir !== '..' && !fromDir.startsWith(`..${sep}`)
}

/**
 * Every directory from the top down to `cwd`, the filesystem root excluded.
 * When `cwd` is in a worktree that lies inside its main checkout, the
 * directories of the checkout outside the worktree skip their checked-in
 * files: those belong to another branch.
 */
export function planInstructionWalk(input: {
  cwd: string
  gitRoot: string | null
  canonicalRoot: string | null
}): WalkStop[] {
  const { cwd, gitRoot, canonicalRoot } = input
  const dirs: string[] = []
  for (let dir = cwd; dirname(dir) !== dir; dir = dirname(dir)) dirs.unshift(dir)

  // Only an ancestor of the cwd can be skipped, so a worktree outside its
  // checkout, or a plain checkout (both roots equal), never skips anything.
  const insideCheckoutOnly = (dir: string): boolean =>
    gitRoot !== null && canonicalRoot !== null && isWithin(dir, canonicalRoot) && !isWithin(dir, gitRoot)
  return dirs.map(dir => ({ dir, skipCheckedIn: insideCheckoutOnly(dir) }))
}

export type PlannedRead = { type: MemoryType; kind: SourceKind; path: string }

export type SessionPlanInput = {
  stops: WalkStop[]
  addedDirectories: string[]
  isEnabled: (source: SettingSource) => boolean
  exists: (path: string) => boolean
}

/** What the session load reads, in order. */
export function planSessionReads({ stops, addedDirectories, isEnabled, exists }: SessionPlanInput): PlannedRead[] {
  const open = (row: SourceRow): boolean => row.gate === null || isEnabled(row.gate)
  const reads: PlannedRead[] = []
  for (const source of FIXED_SOURCES) {
    if (open(source)) reads.push({ type: source.type, kind: source.kind, path: source.path() })
  }
  for (const { dir, skipCheckedIn } of stops) {
    for (const source of DIRECTORY_SOURCES) {
      if (!open(source) || (source.checkedIn && skipCheckedIn)) continue
      reads.push({ type: source.type, kind: source.kind, path: source.path(dir, exists) })
    }
  }
  for (const dir of addedDirectories) {
    for (const source of DIRECTORY_SOURCES) {
      if (source.fromAddedDirectory) reads.push({ type: source.type, kind: source.kind, path: source.path(dir, exists) })
    }
  }
  return reads
}

/** User files may include anything; the others need the approval for files outside the cwd. */
export async function loadPlannedReads(
  reads: readonly PlannedRead[],
  processedPaths: Set<string>,
  externalApproved: boolean,
): Promise<MemoryFileInfo[]> {
  const loaded: MemoryFileInfo[] = []
  for (const { type, kind, path } of reads) {
    const includeExternal = type === 'User' || externalApproved
    const files =
      kind === 'rules'
        ? await processMdRules({ rulesDir: path, type, processedPaths, includeExternal, conditionalRule: false })
        : await processMemoryFile(path, type, processedPaths, includeExternal)
    loaded.push(...files)
  }
  return loaded
}
