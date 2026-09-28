import { type FileHandle, open } from 'fs/promises'

/** The window read at each end of a file, and the least buffer a caller passes. */
export const LITE_READ_BUF_SIZE = 64 * 1024

type HeadAndTail = { head: string; tail: string }

async function readWindow(file: FileHandle, buf: Buffer, position: number): Promise<string> {
  const { bytesRead } = await file.read(buf, 0, LITE_READ_BUF_SIZE, position)
  return buf.toString('utf8', 0, bytesRead)
}

async function readBothEnds(filePath: string, fileSize: number, buf: Buffer): Promise<HeadAndTail> {
  const file = await open(filePath, 'r')
  try {
    // Each end is decoded before the next read reuses the buffer.
    const head = await readWindow(file, buf, 0)
    if (fileSize <= LITE_READ_BUF_SIZE) return { head, tail: head }
    const tail = await readWindow(file, buf, fileSize - LITE_READ_BUF_SIZE)
    return { head, tail }
  } finally {
    await file.close()
  }
}

/**
 * The first and last 64 KiB of a file, read through one caller-owned buffer.
 * The tail is placed by `fileSize`, not by the file. Never rejects: a file
 * that cannot be read, or a buffer that is too small, gives empty strings.
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<HeadAndTail> {
  if (buf.length < LITE_READ_BUF_SIZE) return { head: '', tail: '' }
  try {
    return await readBothEnds(filePath, fileSize, buf)
  } catch {
    // Listing sessions reads many files; one unreadable file lists as empty.
    return { head: '', tail: '' }
  }
}
