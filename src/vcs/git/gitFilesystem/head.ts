import { join } from 'path'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'
import { isAcceptedRefName } from 'src/vcs/git/gitFilesystem/refNames.js'
import {
  filesRefStore,
  MAX_REF_READS,
  parseLooseRef,
  resolveRefToId,
} from 'src/vcs/git/gitFilesystem/refStore.js'

/** HEAD as written, before any ref is looked up. */
export type HeadState =
  | { kind: 'branch'; branch: string }
  /** A symbolic HEAD outside refs/heads/: git allows any ref, and it reads as detached. */
  | { kind: 'ref'; ref: string }
  | { kind: 'detached'; id: string }
  | { kind: 'unreadable' }

/** HEAD with its ref looked up. */
export type ResolvedHead =
  /** `id` is null on a branch with no commit yet, or whose ref cannot be resolved. */
  | { kind: 'branch'; branch: string; id: string | null }
  | { kind: 'detached'; id: string }
  | { kind: 'unreadable' }

const BRANCH_REFS = 'refs/heads/'
const UNREADABLE = { kind: 'unreadable' } as const

/** Every name is checked, so a tampered HEAD can neither leak text nor steer a path. */
function classifyTarget(target: string): HeadState {
  if (target.startsWith(BRANCH_REFS)) {
    const branch = target.slice(BRANCH_REFS.length)
    return isAcceptedRefName(branch) ? { kind: 'branch', branch } : UNREADABLE
  }
  return isAcceptedRefName(target) ? { kind: 'ref', ref: target } : UNREADABLE
}

export function parseHead(text: string | null): HeadState {
  if (text === null) return UNREADABLE
  const record = parseLooseRef(text)
  if (record.kind === 'object') return { kind: 'detached', id: record.id }
  if (record.kind === 'symbolic') return classifyTarget(record.target)
  return UNREADABLE
}

export async function readHead(gitDir: string, files: GitFiles): Promise<HeadState> {
  return parseHead(await files.readText(join(gitDir, 'HEAD')))
}

export async function resolveHead(gitDir: string, files: GitFiles): Promise<ResolvedHead> {
  const head = await readHead(gitDir, files)
  if (head.kind === 'detached' || head.kind === 'unreadable') return head
  const store = filesRefStore(gitDir, files)
  // Reading HEAD itself was the first of git's five reads.
  const readsLeft = MAX_REF_READS - 1
  if (head.kind === 'branch') {
    const id = await resolveRefToId(store, BRANCH_REFS + head.branch, readsLeft)
    return { kind: 'branch', branch: head.branch, id }
  }
  const id = await resolveRefToId(store, head.ref, readsLeft)
  return id === null ? UNREADABLE : { kind: 'detached', id }
}

/** The commit HEAD stands on, if any. */
export function headCommit(head: ResolvedHead): string | null {
  return head.kind === 'unreadable' ? null : head.id
}
