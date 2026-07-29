import { realpathSync } from 'fs'

/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

// Inside a Bun-compiled standalone binary `process.argv[1]` is the in-binary
// VFS path — `/$bunfs/root/claudin` on POSIX, `B:\~BUN\root\claudin` on
// Windows — not a location on disk.
const BUN_VFS_PATH_RE = /(^|[/\\])(\$bunfs|~BUN)[/\\]/i

/**
 * Real on-disk path of the launcher that started this process.
 *
 * Every install-location check (npm global? bun global? managed local?) used to
 * read `process.argv[1]` directly. That works under Node, but the release
 * binaries are bun-compiled, where argv[1] is the in-binary VFS path and
 * therefore matches no install prefix — so every such check silently answered
 * "no" and the installation classified as `unknown`. Fall back to the resolved
 * `process.execPath`: the global bin entry is a symlink into node_modules, so
 * resolving it yields a path that carries the package location.
 */
export function getLauncherPath(): string {
  const invokedPath = process.argv[1] || ''
  if (invokedPath && !BUN_VFS_PATH_RE.test(invokedPath)) return invokedPath

  const execPath = process.execPath || ''
  if (!execPath) return invokedPath
  try {
    return realpathSync(execPath)
  } catch {
    // Deleted/inaccessible target: the unresolved path still beats the VFS one.
    return execPath
  }
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * This checks for embedded files which are present in compiled binaries.
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}
