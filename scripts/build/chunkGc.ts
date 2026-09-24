import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * GC for dist/chunks in a checkout build.
 *
 * Dev builds name chunks `<Name>-<buildId>-<hash>.mjs`, where buildId is a
 * base36 timestamp shared by every chunk of one `bun run build` and the hash
 * disambiguates chunks within it. Files are bucketed by buildId (a generation)
 * and everything outside the newest `keepRecent` generations is pruned —
 * EXCEPT a generation a running CLI still leases (src/platform/chunkLease.ts).
 * A session lazy-imports its chunks at call time, so pruning its generation by
 * recency alone killed its next slash command with `Cannot find module`, three
 * builds after it started.
 *
 * Release-build chunks (`<Name>-<version>-<hash>.mjs`) don't match the pattern
 * and are left alone — they only exist where dist/ starts empty anyway.
 */
const DEV_CHUNK_RE = /-([0-9a-z]{8,})-[a-z0-9]+\.mjs(?:\.map)?$/

/** Where running CLIs lease their generation: one file per pid, holding it. */
export const LEASE_DIR = '.leases'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The generations live processes lease; a dead process's lease is removed. */
function leasedGenerations(chunksDir: string): Set<string> {
  const leases = join(chunksDir, LEASE_DIR)
  const leased = new Set<string>()
  if (!existsSync(leases)) return leased
  for (const name of readdirSync(leases)) {
    const pid = Number(name)
    const path = join(leases, name)
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      leased.add(readFileSync(path, 'utf8').trim())
    } else {
      rmSync(path, { force: true })
    }
  }
  return leased
}

export function pruneChunkGenerations(
  chunksDir: string,
  keepRecent = 3,
): { pruned: number; prunedGenerations: number; kept: string[] } {
  if (!existsSync(chunksDir)) return { pruned: 0, prunedGenerations: 0, kept: [] }
  const buckets = new Map<string, string[]>()
  for (const file of readdirSync(chunksDir)) {
    const m = file.match(DEV_CHUNK_RE)
    if (!m) continue
    const id = m[1]!
    const arr = buckets.get(id) ?? []
    arr.push(file)
    buckets.set(id, arr)
  }
  const keep = new Set(
    [...buckets.keys()]
      .sort((a, b) => parseInt(b, 36) - parseInt(a, 36))
      .slice(0, keepRecent),
  )
  for (const generation of leasedGenerations(chunksDir)) {
    if (buckets.has(generation)) keep.add(generation)
  }
  let pruned = 0
  for (const [id, files] of buckets) {
    if (keep.has(id)) continue
    for (const file of files) {
      rmSync(join(chunksDir, file), { force: true })
      pruned++
    }
  }
  return { pruned, prunedGenerations: buckets.size - keep.size, kept: [...keep] }
}
