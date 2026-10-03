/**
 * Every transcript byte reaches the disk through here, so a file this unit
 * creates is always owner-only (finding 1): directories `0700`, files `0600`.
 * An existing file keeps the mode it has.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function isMissingDirectory(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Appends `text` at once; the directory is made only when the first try finds it missing. */
export function appendPrivateSync(path: string, text: string): void {
  const fs = getFsImplementation()
  try {
    fs.appendFileSync(path, text, { mode: PRIVATE_FILE_MODE })
  } catch (error) {
    if (!isMissingDirectory(error)) throw error
    fs.mkdirSync(dirname(path), { mode: PRIVATE_DIR_MODE })
    fs.appendFileSync(path, text, { mode: PRIVATE_FILE_MODE })
  }
}

export async function appendPrivate(path: string, text: string): Promise<void> {
  try {
    await appendFile(path, text, { mode: PRIVATE_FILE_MODE })
  } catch (error) {
    if (!isMissingDirectory(error)) throw error
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
    await appendFile(path, text, { mode: PRIVATE_FILE_MODE })
  }
}

/** Replaces the whole file with `text`. */
export async function replacePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  await writeFile(path, text, { mode: PRIVATE_FILE_MODE })
}

/** The last `bytes` of the file as text, or '' when it cannot be read. */
export function readTailSync(path: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    if (length === 0) return ''
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8', 0, read)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** JSONL text for `entries`: one compact JSON object per line, each ending in LF. */
export function toJsonl(entries: readonly object[]): string {
  let text = ''
  for (const entry of entries) text += `${JSON.stringify(entry)}\n`
  return text
}
