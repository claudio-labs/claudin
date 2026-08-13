// ---------------------------------------------------------------------------
// readFileInRange — line-oriented file reader with two code paths
// ---------------------------------------------------------------------------
//
// Returns lines [offset, offset + maxLines) from a file.
//
// Fast path (regular files < 10 MB):
//   Opens the file, stats the fd, reads the whole file with readFile(),
//   then splits lines in memory.  This avoids the per-chunk async overhead
//   of createReadStream and is ~2x faster for typical source files.
//
// Streaming path (large files, pipes, devices, etc.):
//   Uses createReadStream with manual indexOf('\n') scanning.  Content is
//   only accumulated for lines inside the requested range — lines outside
//   the range are counted (for totalLines) but discarded, so reading line
//   1 of a 100 GB file won't balloon RSS.
//
//   All event handlers (streamOnOpen/Data/End) are module-level named
//   functions with zero closures.  State lives in a StreamState object;
//   handlers access it via `this`, bound at registration time.
//
//   Lifecycle: `open`, `end`, and `error` use .once() (auto-remove).
//   `data` fires until the stream ends or is destroyed — either way the
//   stream and state become unreachable together and are GC'd.
//
//   On error (including maxBytes exceeded), stream.destroy(err) emits
//   'error' → reject (passed directly to .once('error')).
//
// Both paths strip UTF-8 BOM and \r (CRLF → LF).
//
// options.encoding overrides the default UTF-8 decode with any Encoding
// Standard label (see utils/textEncoding.ts). It changes only HOW bytes become
// characters: both paths then run the same line logic, and byte accounting
// stays in raw file bytes rather than in the re-encoded string, so maxBytes
// keeps meaning what it meant.
//
// mtime comes from fstat/stat on the already-open fd — no extra open().
//
// maxBytes behavior depends on options.truncateOnByteLimit:
//   false (default): legacy semantics — throws FileTooLargeError if the FILE
//     size (fast path) or total streamed bytes (streaming) exceed maxBytes.
//   true: caps SELECTED OUTPUT at maxBytes.  Stops at the last complete line
//     that fits; sets truncatedByBytes in the result.  Never throws.
// ---------------------------------------------------------------------------

import { createReadStream, fstat } from 'fs'
import { stat as fsStat, readFile } from 'fs/promises'
import { formatFileSize } from './format.js'
import { createTextDecoder, encodingOverride } from './textEncoding.js'

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean
}

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean; encoding?: string },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted()
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false
  const decodeAs = encodingOverride(options?.encoding)

  // stat to decide the code path and guard against OOM.
  // For regular files under 10 MB: readFile + in-memory split (fast).
  // Everything else (large files, FIFOs, devices): streaming.
  const stats = await fsStat(filePath)

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    )
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }

    // The default path reads straight to a string; only an override pays for
    // the intermediate Buffer.
    const text = decodeAs
      ? createTextDecoder(decodeAs).decode(await readFile(filePath, { signal }))
      : await readFile(filePath, { encoding: 'utf8', signal })
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
      decodeAs ? stats.size : undefined,
    )
  }

  return readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
    decodeAs,
  )
}

// ---------------------------------------------------------------------------
// Fast path — readFile + in-memory split
// ---------------------------------------------------------------------------

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
  // Raw file size, passed only when a decode override makes the string's own
  // UTF-8 length a different number from the bytes on disk.
  rawTotalBytes?: number,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  // Strip BOM.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  // Split lines, strip \r, select range.
  const selectedLines: string[] = []
  let lineIndex = 0
  let startPos = 0
  let newlinePos: number
  let selectedBytes = 0
  let truncatedByBytes = false

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true
        return false
      }
      selectedBytes = nextBytes
    }
    selectedLines.push(line)
    return true
  }

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      tryPush(line)
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  // Final fragment (no trailing newline). Only counts when non-empty —
  // cat -n semantics: a trailing '\n' does not open a phantom empty last
  // line, and an empty file has 0 lines (not 1).
  if (startPos < text.length) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      tryPush(line)
    }
    lineIndex++
  }

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: rawTotalBytes ?? Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming path — createReadStream + event handlers
// ---------------------------------------------------------------------------

type StreamState = {
  stream: ReturnType<typeof createReadStream>
  offset: number
  endLine: number
  maxBytes: number | undefined
  truncateOnByteLimit: boolean
  resolve: (value: ReadFileRangeResult) => void
  totalBytesRead: number
  selectedBytes: number
  truncatedByBytes: boolean
  currentLineIndex: number
  selectedLines: string[]
  partial: string
  isFirstChunk: boolean
  /** Last character seen was '\n' — at end-of-stream this means the file
   *  has no final unterminated line (mirrors the fast path's cat -n
   *  semantics: no phantom empty line after a trailing newline). */
  lastCharWasNewline: boolean
  /** Non-null when chunks arrive as Buffers to be decoded here rather than by
   *  the stream. Streaming-mode decode, so a multi-byte character split across
   *  a chunk boundary is held rather than mangled. */
  decoder: TextDecoder | null
  resolveMtime: (ms: number) => void
  mtimeReady: Promise<number>
}

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs)
  })
}

function streamOnData(this: StreamState, raw: string | Buffer): void {
  // Raw byte count has to come from the buffer, not from the decoded string:
  // for a UTF-16 source the two differ by about 2x, and totalBytesRead is what
  // maxBytes and totalBytes are reported in.
  let chunk: string
  let rawBytes: number
  if (this.decoder) {
    rawBytes = (raw as Buffer).length
    chunk = this.decoder.decode(raw as Buffer, { stream: true })
  } else {
    chunk = raw as string
    rawBytes = Buffer.byteLength(chunk)
  }

  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }

  if (chunk.length > 0) {
    this.lastCharWasNewline = chunk.endsWith('\n')
  }

  this.totalBytesRead += rawBytes
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    )
    return
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''

  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      let line = data.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (nextBytes > this.maxBytes) {
          // Cap hit — collapse the selection range so nothing more is
          // accumulated.  Stream continues (to count totalLines).
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
        } else {
          this.selectedBytes = nextBytes
          this.selectedLines.push(line)
        }
      } else {
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
    startPos = newlinePos + 1
  }

  // Only keep the trailing fragment when inside the selected range.
  // Outside the range we just count newlines — discarding prevents
  // unbounded memory growth on huge single-line files.
  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos)
      // In truncate mode, `partial` can grow unboundedly if the selected
      // range contains a huge single line (no newline across many chunks).
      // Once the fragment alone would overflow the remaining budget, we know
      // the completed line can never fit — set truncated, collapse the
      // selection range, and discard the fragment to stop accumulation.
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment)
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
          return
        }
      }
      this.partial = fragment
    }
  }
}

function streamOnEnd(this: StreamState): void {
  // Flush any incomplete trailing sequence the streaming decode was holding.
  // It can only produce characters, never consume any, so it belongs on the
  // end of the last partial line.
  if (this.decoder) {
    const tail = this.decoder.decode()
    if (tail.length > 0) {
      this.partial += tail
      this.lastCharWasNewline = tail.endsWith('\n')
    }
  }

  // A final unterminated line only exists when the stream had content that
  // didn't end in '\n' — mirrors the fast path (cat -n semantics): a
  // trailing newline doesn't open a phantom empty last line, and an empty
  // file has 0 lines.
  if (this.totalBytesRead > 0 && !this.lastCharWasNewline) {
    let line = this.partial
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (nextBytes > this.maxBytes) {
          this.truncatedByBytes = true
        } else {
          this.selectedLines.push(line)
        }
      } else {
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
  }

  const content = this.selectedLines.join('\n')
  const truncated = this.truncatedByBytes
  this.mtimeReady.then(mtimeMs => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    })
  })
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
  decodeAs?: string | null,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    // A decoder means the stream must hand us Buffers, so the encoding option
    // is dropped rather than set — createReadStream only speaks BufferEncoding
    // and would reject the labels this exists to support.
    const decoder = decodeAs ? createTextDecoder(decodeAs) : null
    const state: StreamState = {
      stream: createReadStream(filePath, {
        ...(decoder ? undefined : { encoding: 'utf8' as const }),
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      isFirstChunk: true,
      lastCharWasNewline: false,
      decoder,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    }
    state.mtimeReady = new Promise<number>(r => {
      state.resolveMtime = r
    })

    state.stream.once('open', streamOnOpen.bind(state))
    state.stream.on('data', streamOnData.bind(state))
    state.stream.once('end', streamOnEnd.bind(state))
    state.stream.once('error', reject)
  })
}
