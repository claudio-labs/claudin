import { LRUCache } from 'lru-cache'
import { join } from 'path'
import { logError } from 'src/shared/log.js'
import type { WatchFile } from 'src/vcs/git/gitFilesystem/filePoller.js'
import { readCommonDir } from 'src/vcs/git/gitFilesystem/gitDir.js'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'
import { headCommit, readHead, resolveHead } from 'src/vcs/git/gitFilesystem/head.js'
import {
  FALLBACK_DEFAULT_BRANCH,
  readDefaultBranch,
  readOriginUrl,
} from 'src/vcs/git/gitFilesystem/origin.js'

/** The branch when HEAD names none: detached, unreadable, or no repository at all. */
export const NO_BRANCH = 'HEAD'
/** The commit when HEAD stands on none. */
export const NO_COMMIT = ''

export type RepoStateDeps = {
  files: GitFiles
  watchFile: WatchFile
  /** Resolves once the terminal has stopped scrolling. */
  waitForScrollIdle(): Promise<void>
  registerCleanup(cleanup: () => Promise<void>): () => void
  maxRepositories: number
}

/** The four values kept for one repository. */
export type RepoValues = {
  branch(): Promise<string>
  head(): Promise<string>
  remoteUrl(): Promise<string | null>
  defaultBranch(): Promise<string>
}

/**
 * One value, read again only once the repository's generation has moved on.
 * Calls that arrive while it is being read share that read.
 */
class GenerationValue<T> {
  private slot: { generation: number; value: Promise<T> } | undefined

  constructor(
    private readonly read: () => Promise<T>,
    private readonly fallback: T,
  ) {}

  at(generation: number): Promise<T> {
    if (this.slot !== undefined && this.slot.generation === generation) return this.slot.value
    const value = this.read().catch((error: unknown) => {
      logError(error)
      return this.fallback
    })
    this.slot = { generation, value }
    return value
  }
}

/**
 * One repository's values. Each is read on first use and kept until one of
 * three files changes: HEAD, the config, or the checked-out branch's ref.
 * Remote-tracking refs and packed-refs are not watched, so after a fetch the
 * values catch up only when one of those three files changes.
 */
class WatchedRepository implements RepoValues {
  private generation = 0
  private closed = false
  private readonly stops: Array<() => void> = []
  private commonDir: string | null = null
  private storeDir: string
  /** undefined before the first look at HEAD; null while no branch is checked out. */
  private followedBranch: string | null | undefined
  private stopBranchWatch: (() => void) | undefined
  private following: Promise<void> = Promise.resolve()
  private refollowPending = false
  private refollowing = false
  private readonly ready: Promise<void>

  private readonly branchValue = new GenerationValue(async () => {
    const head = await readHead(this.gitDir, this.deps.files)
    return head.kind === 'branch' ? head.branch : NO_BRANCH
  }, NO_BRANCH)

  private readonly headValue = new GenerationValue(async () => {
    return headCommit(await resolveHead(this.gitDir, this.deps.files)) ?? NO_COMMIT
  }, NO_COMMIT)

  private readonly remoteUrlValue = new GenerationValue<string | null>(
    () => readOriginUrl(this.gitDir, this.commonDir, this.deps.files),
    null,
  )

  private readonly defaultBranchValue = new GenerationValue(
    () => readDefaultBranch(this.storeDir, this.deps.files),
    FALLBACK_DEFAULT_BRANCH,
  )

  constructor(
    private readonly gitDir: string,
    private readonly deps: RepoStateDeps,
  ) {
    this.storeDir = gitDir
    this.ready = this.startWatching().catch((error: unknown) => logError(error))
  }

  branch(): Promise<string> {
    return this.current(this.branchValue)
  }

  head(): Promise<string> {
    return this.current(this.headValue)
  }

  remoteUrl(): Promise<string | null> {
    return this.current(this.remoteUrlValue)
  }

  defaultBranch(): Promise<string> {
    return this.current(this.defaultBranchValue)
  }

  close(): void {
    this.closed = true
    for (const stop of this.stops.splice(0)) stop()
    this.stopBranchWatch?.()
    this.stopBranchWatch = undefined
  }

  /** Values are read only once the watches are in place, so no change slips between. */
  private async current<T>(value: GenerationValue<T>): Promise<T> {
    await this.ready
    return value.at(this.generation)
  }

  private invalidate(): void {
    this.generation += 1
  }

  private async startWatching(): Promise<void> {
    this.commonDir = await readCommonDir(this.gitDir, this.deps.files)
    this.storeDir = this.commonDir ?? this.gitDir
    if (this.closed) return
    this.stops.push(
      this.deps.watchFile(join(this.gitDir, 'HEAD'), () => this.headChanged()),
      this.deps.watchFile(join(this.storeDir, 'config'), () => this.invalidate()),
    )
    await this.follow()
  }

  /** Runs one follow at a time, so an older look at HEAD never lands last. */
  private follow(): Promise<void> {
    this.following = this.following
      .then(() => this.followBranch())
      .catch((error: unknown) => logError(error))
    return this.following
  }

  /**
   * Moves the ref watch to the branch HEAD names now. The ref file of a new
   * branch may not exist yet; it is watched for its first commit all the same.
   * Moving the watch invalidates nothing: only a change to a watched file
   * does, and the HEAD change that led here already has.
   */
  private async followBranch(): Promise<void> {
    const head = await readHead(this.gitDir, this.deps.files)
    const branch = head.kind === 'branch' ? head.branch : null
    if (this.closed || branch === this.followedBranch) return
    this.stopBranchWatch?.()
    this.stopBranchWatch =
      branch === null
        ? undefined
        : this.deps.watchFile(join(this.storeDir, 'refs', 'heads', branch), () => this.invalidate())
    this.followedBranch = branch
  }

  /** Scrolling may hold back moving the ref watch, never the invalidation. */
  private headChanged(): void {
    this.invalidate()
    this.refollowPending = true
    if (!this.refollowing) void this.refollow()
  }

  private async refollow(): Promise<void> {
    this.refollowing = true
    try {
      while (this.refollowPending && !this.closed) {
        this.refollowPending = false
        await this.deps.waitForScrollIdle()
        await this.follow()
      }
    } catch (error) {
      logError(error)
    } finally {
      this.refollowing = false
    }
  }
}

export type RepoStateCache = {
  /** The values of the repository whose git directory is `gitDir`. */
  valuesFor(gitDir: string): RepoValues
}

/**
 * One entry per git directory, so every caller gets the repository it is in.
 * Past `maxRepositories` the least recently used entry stops being watched:
 * sub-agents can alternate between several worktrees.
 */
export function createRepoStateCache(deps: RepoStateDeps): RepoStateCache {
  const repositories = new LRUCache<string, WatchedRepository>({
    max: deps.maxRepositories,
    dispose: repository => repository.close(),
  })
  let cleanupRegistered = false
  return {
    valuesFor(gitDir) {
      const known = repositories.get(gitDir)
      if (known !== undefined) return known
      if (!cleanupRegistered) {
        cleanupRegistered = true
        deps.registerCleanup(async () => repositories.clear())
      }
      const repository = new WatchedRepository(gitDir, deps)
      repositories.set(gitDir, repository)
      return repository
    },
  }
}
