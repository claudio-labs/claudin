import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * A running CLI's claim on the dist/chunks generation it booted from.
 *
 * A checkout build names its chunks `<Name>-<generation>-<hash>.mjs` and loads
 * them lazily, at call time, and every `bun run build` prunes old generations
 * (scripts/build/chunkGc.ts). Kept by recency alone, the generation a long
 * session booted from was deleted under it three builds later, and its next
 * slash command died with `Cannot find module`. The GC keeps any generation a
 * live process leases here.
 *
 * Only a checkout build leases: a release build names its chunks by version,
 * and the compiled binary carries them inside the executable.
 */
const DEV_CHUNK_RE = /-([0-9a-z]{8,})-[a-z0-9]+\.mjs$/
/** Mirrors LEASE_DIR in scripts/build/chunkGc.ts. */
const LEASE_DIR = '.leases'

/**
 * Writes `<chunks>/.leases/<pid>` holding the generation of the chunk
 * `moduleUrl` names, and returns its path — or null when the module is not a
 * dev chunk on disk, or the lease cannot be written.
 */
export function writeChunkLease(moduleUrl: string, pid: number): string | null {
  let modulePath: string
  try {
    modulePath = fileURLToPath(moduleUrl)
  } catch {
    return null
  }
  const generation = DEV_CHUNK_RE.exec(basename(modulePath))?.[1]
  const chunksDir = dirname(modulePath)
  if (!generation || basename(chunksDir) !== 'chunks') return null
  const lease = join(chunksDir, LEASE_DIR, String(pid))
  try {
    mkdirSync(dirname(lease), { recursive: true })
    writeFileSync(lease, generation)
  } catch {
    return null
  }
  return lease
}

/** Leases this process's generation for as long as it runs. */
export function holdChunkLease(): void {
  const lease = writeChunkLease(import.meta.url, process.pid)
  if (lease) process.once('exit', () => rmSync(lease, { force: true }))
}
