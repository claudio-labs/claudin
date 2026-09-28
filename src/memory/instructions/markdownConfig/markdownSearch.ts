/**
 * The markdown files under one source directory, found in-process. Links are
 * followed and the reported path runs through them; the entry's own name
 * decides whether it counts; hidden entries count and no ignore file is read;
 * whatever cannot be read is passed over.
 */
import type { Dirent } from 'fs'
import { readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'

import { logForDebugging } from 'src/shared/debug.js'
import { ClaudeError, errorMessage, isENOENT } from 'src/shared/errors.js'

const MARKDOWN_EXTENSION = '.md'
const SEARCH_BUDGET_MS = 3_000

export type SearchClock = { budgetMs: number; now: () => number }

const SYSTEM_CLOCK: SearchClock = { budgetMs: SEARCH_BUDGET_MS, now: () => Date.now() }

export class MarkdownSearchTimeoutError extends ClaudeError {
  constructor(root: string, budgetMs: number) {
    super(`searching ${root} for markdown files found nothing within ${budgetMs} ms`)
  }
}

type SearchState = {
  readonly root: string
  readonly found: string[]
  /** Real paths of the directories entered, so a link loop is entered once. */
  readonly entered: Set<string>
  readonly deadline: number
  readonly now: () => number
  expired: boolean
}

type EntryKind = 'directory' | 'file'

/**
 * Past the time budget the files found so far are the answer, and finding
 * none by then is a failure rather than an empty directory.
 */
export async function findMarkdownFiles(
  root: string,
  clock: SearchClock = SYSTEM_CLOCK,
): Promise<string[]> {
  const search: SearchState = {
    root,
    found: [],
    entered: new Set(),
    deadline: clock.now() + clock.budgetMs,
    now: clock.now,
    expired: false,
  }
  const settled = await settlesWithin(searchDirectory(root, search), clock.budgetMs)
  if (settled && !search.expired) return search.found
  search.expired = true
  if (search.found.length === 0) throw new MarkdownSearchTimeoutError(root, clock.budgetMs)
  logForDebugging(
    `[markdown config] ${root}: out of time after ${clock.budgetMs} ms, keeping the ${search.found.length} files found`,
  )
  return [...search.found]
}

/** A file-system call that hangs (a stale network mount) cannot hold the load past the budget. */
async function settlesWithin(work: Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<false>(resolve => {
    timer = setTimeout(resolve, budgetMs, false)
  })
  try {
    return await Promise.race([work.then(() => true), expiry])
  } finally {
    clearTimeout(timer)
  }
}

function outOfTime(search: SearchState): boolean {
  if (search.now() >= search.deadline) search.expired = true
  return search.expired
}

async function searchDirectory(dir: string, search: SearchState): Promise<void> {
  for (const entry of await enterDirectory(dir, search)) {
    if (search.expired) return
    await visit(join(dir, entry.name), entry, search)
  }
}

/** Its entries in name order, or none: entered already, out of time, or unreadable. */
async function enterDirectory(dir: string, search: SearchState): Promise<Dirent[]> {
  if (outOfTime(search)) return []
  try {
    const realDir = await realpath(dir)
    if (search.entered.has(realDir)) return []
    search.entered.add(realDir)
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.sort(byName)
  } catch (error) {
    // A source directory that does not exist is the usual case, not a failure.
    if (dir !== search.root || !isENOENT(error)) {
      logForDebugging(`[markdown config] passing over ${dir}: ${errorMessage(error)}`)
    }
    return []
  }
}

async function visit(path: string, entry: Dirent, search: SearchState): Promise<void> {
  // A link, or an entry whose type the file system did not report, is judged
  // by what it leads to.
  const kind = kindOf(entry) ?? (await kindBehind(path, search))
  if (kind === 'directory') {
    await searchDirectory(path, search)
  } else if (kind === 'file' && entry.name.endsWith(MARKDOWN_EXTENSION)) {
    search.found.push(path)
  }
}

async function kindBehind(path: string, search: SearchState): Promise<EntryKind | undefined> {
  if (outOfTime(search)) return undefined
  try {
    return kindOf(await stat(path))
  } catch (error) {
    logForDebugging(`[markdown config] passing over ${path}: ${errorMessage(error)}`)
    return undefined
  }
}

/** Sockets, pipes and devices are none of these: reading a pipe could block the load. */
function kindOf(item: { isDirectory(): boolean; isFile(): boolean }): EntryKind | undefined {
  if (item.isDirectory()) return 'directory'
  if (item.isFile()) return 'file'
  return undefined
}

function byName(a: Dirent, b: Dirent): number {
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}
