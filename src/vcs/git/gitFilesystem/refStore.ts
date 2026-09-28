import { join, resolve } from 'path'
import { readCommonDir } from 'src/vcs/git/gitFilesystem/gitDir.js'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'
import { isAcceptedRefName, isObjectId } from 'src/vcs/git/gitFilesystem/refNames.js'

/** What one ref name holds in a store. */
export type RefRecord =
  | { kind: 'missing' }
  | { kind: 'object'; id: string }
  | { kind: 'symbolic'; target: string }
  /** Present but not usable: git ignores such a ref, and so does every lookup here. */
  | { kind: 'broken' }

/**
 * Where refs are read from. Only git's files layout is implemented. A
 * reftable repository needs another store behind this same interface,
 * probably one that asks git itself.
 */
export type RefStore = {
  read(name: string): Promise<RefRecord>
}

/**
 * git gives up after five reads when it follows symbolic refs. Stopping at the
 * same point keeps a planted cycle (a -> b -> a) from spinning forever.
 */
export const MAX_REF_READS = 5

const SYMBOLIC_PREFIX = 'ref:'
const MISSING: RefRecord = { kind: 'missing' }
const BROKEN: RefRecord = { kind: 'broken' }

/** A loose ref file, or HEAD: `ref: <target>` (any blanks after the colon), or one full id. */
export function parseLooseRef(text: string): RefRecord {
  const content = text.trim()
  if (content.startsWith(SYMBOLIC_PREFIX)) {
    return { kind: 'symbolic', target: content.slice(SYMBOLIC_PREFIX.length).trim() }
  }
  return isObjectId(content) ? { kind: 'object', id: content } : BROKEN
}

/**
 * The `<id> <name>` line of packed-refs for exactly `name`. The header and
 * the `^<id>` lines that follow annotated tags are not entries.
 */
export function findPackedRef(text: string, name: string): RefRecord {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('#') || line.startsWith('^')) continue
    const gap = line.indexOf(' ')
    if (gap < 0 || line.slice(gap + 1) !== name) continue
    const id = line.slice(0, gap)
    return isObjectId(id) ? { kind: 'object', id } : BROKEN
  }
  return MISSING
}

/** A loose file wins; packed-refs is read only when there is none. */
async function readFromDirectory(dir: string, name: string, files: GitFiles): Promise<RefRecord> {
  const loose = await files.readText(join(dir, name))
  if (loose !== null) return parseLooseRef(loose)
  const packed = await files.readText(join(dir, 'packed-refs'))
  return packed === null ? MISSING : findPackedRef(packed, name)
}

async function searchOrder(gitDir: string, files: GitFiles): Promise<string[]> {
  const common = await readCommonDir(gitDir, files)
  return common !== null && resolve(common) !== resolve(gitDir) ? [gitDir, common] : [gitDir]
}

/**
 * The refs a git directory sees. From a linked worktree's git directory its
 * own refs (HEAD, refs/worktree/, refs/bisect/) come first, then the shared
 * ones in the common dir.
 */
export function filesRefStore(gitDir: string, files: GitFiles): RefStore {
  let directories: Promise<string[]> | undefined
  return {
    async read(name) {
      directories ??= searchOrder(gitDir, files)
      for (const dir of await directories) {
        const record = await readFromDirectory(dir, name, files)
        if (record.kind !== 'missing') return record
      }
      return MISSING
    },
  }
}

/**
 * The object id `name` leads to, following symbolic refs whose targets pass
 * the name rule, within `reads` lookups. Null for anything else.
 */
export async function resolveRefToId(
  store: RefStore,
  name: string,
  reads: number = MAX_REF_READS,
): Promise<string | null> {
  let current = name
  for (let left = reads; left > 0; left--) {
    const record = await store.read(current)
    if (record.kind === 'object') return record.id
    if (record.kind !== 'symbolic' || !isAcceptedRefName(record.target)) return null
    current = record.target
  }
  return null
}
