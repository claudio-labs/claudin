import { readFile, rename, writeFile } from 'fs/promises'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

/**
 * Write a session's PID record owner-only (it carries the inbox token), to a
 * sibling that is then renamed into place — a session reading the directory
 * never sees a half-written record.
 */
export async function writePidRecord(
  pidFile: string,
  record: Record<string, unknown>,
): Promise<void> {
  const staging = `${pidFile}.${process.pid}.tmp`
  await writeFile(staging, jsonStringify(record), { mode: 0o600 })
  await rename(staging, pidFile)
}

let tail: Promise<unknown> = Promise.resolve()

/**
 * Merge `patch` into the record. Patches run one at a time: two
 * read-modify-write cycles at once would each write back a record missing
 * the other's field. A failed patch rejects for its caller without stopping
 * the ones queued behind it.
 */
export function patchPidRecord(
  pidFile: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const run = tail.then(async () => {
    const current = jsonParse(await readFile(pidFile, 'utf8')) as Record<string, unknown>
    await writePidRecord(pidFile, { ...current, ...patch })
  })
  // The failure is the caller's, via `run`; the chain only has to survive it.
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
