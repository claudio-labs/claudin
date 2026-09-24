import { chmod, lstat, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'

const SOCKET_DIR_NAME = 'claudin-socks'
// sun_path holds 104 bytes on macOS and 108 on Linux, the NUL included.
const MAX_SOCKET_PATH_BYTES = 103

/**
 * Where a session's inbox socket lives: the per-user runtime dir when there is
 * one (tmpfs, already private), else the temp dir — and a short path under
 * /tmp when either would overflow sun_path.
 */
export function socketPathFor(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const preferred = join(env.XDG_RUNTIME_DIR || tmpdir(), SOCKET_DIR_NAME, `${pid}.sock`)
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred
  return join('/tmp', `${SOCKET_DIR_NAME}-${process.getuid?.() ?? 'user'}`, `${pid}.sock`)
}

export class UnsafeSocketDirError extends Error {}

/**
 * Create the socket directory owner-only, and refuse one that is not ours: in a
 * shared /tmp another user could create it first and read every socket name,
 * or swap a socket for their own.
 */
export async function ensurePrivateSocketDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stats = await lstat(dir)
  if (!stats.isDirectory()) {
    throw new UnsafeSocketDirError(`${dir} is not a directory`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new UnsafeSocketDirError(`${dir} belongs to another user`)
  }
  if ((stats.mode & 0o077) !== 0) await chmod(dir, 0o700)
}

/**
 * Whether `path` is a socket this user owns — never a symlink, which could
 * point a send at any socket on the machine.
 */
export async function isOwnedSocket(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    const uid = process.getuid?.()
    return stats.isSocket() && (uid === undefined || stats.uid === uid)
  } catch (e) {
    if (!isENOENT(e)) {
      logForDebugging(`[peers] lstat ${path} failed: ${errorMessage(e)}`)
    }
    return false
  }
}
