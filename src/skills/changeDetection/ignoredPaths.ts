/**
 * What never counts as a change: anything with a `.git` segment in its path,
 * editor temporaries, and special files. The watcher asks about a path once
 * before it has stats and again after, so the name rules stand on their own.
 */
import type { Stats } from 'fs'
import { basename, sep } from 'path'

/** Enough of the stats to tell a special file; directories and symlinks are not special. */
export type EntryKind = Pick<Stats, 'isFIFO' | 'isSocket' | 'isBlockDevice' | 'isCharacterDevice'>

const GIT_SEGMENT = '.git'
// Emacs and many others keep the previous version as `name~`.
const BACKUP_FILE_RE = /~$/
// Vim swaps through `.name.swp`, then `.name.swx` when that one is taken.
const VIM_SWAP_FILE_RE = /^\..+\.sw[px]$/
// Sublime Text saves through `.subl<random>.tmp`.
const SUBLIME_TEMP_FILE_RE = /^\.subl.*\.tmp$/

export function isIgnoredPath(path: string, kind?: EntryKind): boolean {
  return (
    hasGitSegment(path) ||
    isEditorTemporary(basename(path)) ||
    (kind !== undefined && isSpecialFile(kind))
  )
}

/** A `.git` directory, anything in one, or a gitfile; `.gitignore` and `.github/` are not. */
function hasGitSegment(path: string): boolean {
  return path.split(sep).includes(GIT_SEGMENT)
}

function isEditorTemporary(name: string): boolean {
  return BACKUP_FILE_RE.test(name) || VIM_SWAP_FILE_RE.test(name) || SUBLIME_TEMP_FILE_RE.test(name)
}

function isSpecialFile(kind: EntryKind): boolean {
  return kind.isFIFO() || kind.isSocket() || kind.isBlockDevice() || kind.isCharacterDevice()
}
