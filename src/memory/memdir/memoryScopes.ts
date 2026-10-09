import { basename } from 'path'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { plural } from 'src/shared/text/stringUtils.js'

/**
 * The memory directories by what they hold, general to specific: who the
 * user is and how they work, in every project (global); what this user
 * learned in this project (private); what the project's contributors share
 * (team). The indexes load in this order, and every surface lists them in it.
 *
 * Pure — no path resolution, no settings — so the transcript, /context and
 * /memory name the directories from here without that import chain. Which
 * directories are on, and where each one is, is memoryDirs.ts.
 */
export const MEMORY_SCOPES = ['global', 'private', 'team'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

type ScopeSpec = {
  /**
   * The getMemoryFiles type its files load as — its index, and a memory of it
   * a `paths:` match attaches. Persisted in transcripts, so `'AutoMem'` stays.
   */
  indexType: Extract<MemoryType, 'GlobalMem' | 'AutoMem' | 'TeamMem'>
  /** The mode its directory is created with, when it is the user's alone across projects. */
  dirMode?: number
  /** Whether its memories may sit in subdirectories (the team categories). */
  hasSubdirectories: boolean
  /** Whether its memories may carry `paths:` — false for one not tied to a project's files. */
  takesPaths: boolean
  /** Its row in /memory, and its browser's title. */
  title: string
  /** Its row's description in /memory, before the directory's path. */
  description: string
  /** What deleting one of its memories in /memory costs beyond this project, if anything. */
  deleteNote?: string
  /** The /memory subcommand that opens it. */
  subcommand: string
}

export const MEMORY_SCOPE_SPECS: Readonly<Record<MemoryScope, ScopeSpec>> = {
  global: {
    indexType: 'GlobalMem',
    dirMode: 0o700,
    hasSubdirectories: false,
    takesPaths: false,
    title: 'Global memory',
    description: 'What Claudin learned about you, for every project, in',
    deleteNote: 'Global memory — every project loses it, not just this one.',
    subcommand: '/memory global',
  },
  private: {
    indexType: 'AutoMem',
    hasSubdirectories: false,
    takesPaths: true,
    title: 'Private memory',
    description: 'What Claudin learned in this project, for you only, in',
    subcommand: '/memory private',
  },
  team: {
    indexType: 'TeamMem',
    hasSubdirectories: true,
    takesPaths: true,
    title: 'Team memory',
    description: 'Shared with the team, git-tracked at',
    deleteNote: 'Shared memory — the deletion reaches the team on the next commit.',
    subcommand: '/memory team',
  },
}

/** The index file of every memory directory. */
export const ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * The scope a getMemoryFiles type belongs to, or null for an instruction
 * file. A memory directory's files share its type — its index, and a memory
 * a `paths:` match attaches (pathScopedMemories.ts).
 */
export function scopeOfMemoryType(type: MemoryType | string): MemoryScope | null {
  return MEMORY_SCOPES.find(scope => MEMORY_SCOPE_SPECS[scope].indexType === type) ?? null
}

/**
 * A memory directory's file, as opposed to an instruction file (CLAUDE.md,
 * AGENTS.md, rules): it goes under the memory preamble, never the
 * instructions'. In getMemoryFiles the only ones are the indexes.
 */
export function isMemoryFileType(type: MemoryType | string): boolean {
  return scopeOfMemoryType(type) !== null
}

/** A memory directory's index: its `MEMORY.md`, truncated at the index caps. */
export function isMemoryIndex(file: { type: MemoryType | string; path: string }): boolean {
  return isMemoryFileType(file.type) && basename(file.path) === ENTRYPOINT_NAME
}

/** "global memories index" — an index's name in the transcript and /context. */
export function memoryIndexLabel(scope: MemoryScope): string {
  return `${scope} memories index`
}

/** "2 global memories", "1 private memory". */
export function countMemories(scope: MemoryScope, count: number): string {
  return `${count} ${scope} ${plural(count, 'memory', 'memories')}`
}

/**
 * A directory as a prompt names it: without the trailing separator the
 * resolvers keep, so `${dir}/MEMORY.md` never renders `…//MEMORY.md`.
 */
export function withoutTrailingSep(dir: string): string {
  return dir.replace(/[/\\]+$/, '')
}
