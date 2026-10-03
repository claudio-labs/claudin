/**
 * The two byte walkers the resume loader runs on large transcripts, before it
 * parses anything:
 *   - `scanPreBoundaryMetadata` recovers the session-metadata lines written in
 *     front of the last compact boundary;
 *   - `walkChainBeforeParse` drops the messages off the live conversation chain.
 *
 * Neither parses JSON nor imports the session-storage barrel or bootstrap
 * state: the loader imports this file, and the barrel imports the loader.
 */

import { open } from 'fs/promises'
import {
  firstTopLevelMember,
  occurrences,
} from 'src/sessions/indexing/byteScan/jsonStructure.js'

/** The entry kinds the resume loader restores from the bytes before a boundary. */
const METADATA_KINDS: ReadonlySet<string> = new Set([
  'summary',
  'custom-title',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'mode',
  'worktree-state',
  'cost-state',
  'pr-link',
])
const METADATA_TYPE_MARKERS: readonly string[] = Array.from(
  METADATA_KINDS,
  kind => `"type":"${kind}"`,
)
const METADATA_MARKER_BUFS: readonly Buffer[] = METADATA_TYPE_MARKERS.map(
  text => Buffer.from(text, 'utf8'),
)
/** Longer than any marker, so a marker split by a piece seam lies within this many bytes of it. */
const METADATA_PREFIX_BOUND = 25
const SEAM_WINDOW = METADATA_PREFIX_BOUND - 1

const SCAN_PIECE_BYTES = 256 * 1024
const NEWLINE = 0x0a
const NO_BYTES = Buffer.alloc(0)

function hasMetadataMarker(bytes: Buffer): boolean {
  return METADATA_MARKER_BUFS.some(marker => bytes.includes(marker))
}

/**
 * The whole line made of `carry` (its bytes from earlier pieces, if any) and
 * `chunkBuf` (the rest of it), when the line carries a metadata marker; else
 * null. Only a line that is kept is joined.
 */
function resolveMetadataBuf(
  carry: Buffer | null,
  chunkBuf: Buffer,
): Buffer | null {
  if (carry === null) return hasMetadataMarker(chunkBuf) ? chunkBuf : null
  const seam = Buffer.concat([
    carry.subarray(-SEAM_WINDOW),
    chunkBuf.subarray(0, SEAM_WINDOW),
  ])
  const marked =
    hasMetadataMarker(carry) ||
    hasMetadataMarker(seam) ||
    hasMetadataMarker(chunkBuf)
  return marked ? Buffer.concat([carry, chunkBuf]) : null
}

function joinPieces(pieces: readonly Buffer[]): Buffer | null {
  if (pieces.length === 0) return null
  return pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces)
}

export async function scanPreBoundaryMetadata(
  filePath: string,
  endOffset: number,
): Promise<string[]> {
  const file = await open(filePath, 'r')
  try {
    const found: string[] = []
    if (!(endOffset > 0)) return found
    const piece = Buffer.allocUnsafe(Math.min(SCAN_PIECE_BYTES, endOffset))
    // Copies of the bytes of the line still open at the end of the last piece.
    const openLine: Buffer[] = []
    const keep = (rest: Buffer): void => {
      const line = resolveMetadataBuf(joinPieces(openLine), rest)
      if (line !== null) found.push(line.toString('utf8'))
      openLine.length = 0
    }

    for (let position = 0; position < endOffset; ) {
      const wanted = Math.min(piece.length, endOffset - position)
      const { bytesRead } = await file.read(piece, 0, wanted, position)
      if (bytesRead === 0) break
      position += bytesRead
      const view = piece.subarray(0, bytesRead)
      let lineStart = 0
      for (let nl = view.indexOf(NEWLINE); nl !== -1; nl = view.indexOf(NEWLINE, lineStart)) {
        keep(view.subarray(lineStart, nl))
        lineStart = nl + 1
      }
      // The piece buffer is reused by the next read, so the open line is copied.
      if (lineStart < bytesRead) openLine.push(Buffer.from(view.subarray(lineStart)))
    }
    if (openLine.length > 0) keep(NO_BYTES)
    return found
  } finally {
    await file.close()
  }
}

const QUOTE = 0x22
const PARENT_PREFIX = Buffer.from('{"parentUuid":')
const UUID_MEMBER = Buffer.from('"uuid":"')
const SIDECHAIN_MEMBER = Buffer.from('"isSidechain":true')
const UUID_LENGTH = 36

type LineSpan = {
  start: number
  /** Where the content ends, before any newline. */
  contentEnd: number
  /** Where the next line starts: past the newline, if there is one. */
  end: number
}

type MessageLink = { uuid: string; parent: string | null; sidechain: boolean }

function splitLines(buf: Buffer): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  while (start < buf.length) {
    const nl = buf.indexOf(NEWLINE, start)
    const contentEnd = nl === -1 ? buf.length : nl
    const end = nl === -1 ? buf.length : nl + 1
    spans.push({ start, contentEnd, end })
    start = end
  }
  return spans
}

/** The 36 characters of a uuid string whose opening quote is at `quoteAt`, or null. */
function quotedUuidAt(buf: Buffer, quoteAt: number, end: number): string | null {
  const close = quoteAt + 1 + UUID_LENGTH
  if (buf[quoteAt] !== QUOTE || close >= end || buf[close] !== QUOTE) return null
  return buf.toString('latin1', quoteAt + 1, close)
}

/**
 * Which of the line's `"uuid":"` hits is its own uuid: the one naming a member
 * of the outermost object. Nested messages and server-supplied records can
 * hold the same bytes, before or after it.
 */
function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  candidates: number[],
): number {
  return firstTopLevelMember(buf, lineStart, candidates)
}

function hasTopLevelMember(buf: Buffer, line: LineSpan, member: Buffer): boolean {
  const hits = occurrences(buf, member, line.start, line.contentEnd)
  return firstTopLevelMember(buf, line.start, hits) !== -1
}

/** The chain link of a message line, or null for a line the walk treats as metadata. */
function readMessageLink(buf: Buffer, line: LineSpan): MessageLink | null {
  const { start, contentEnd } = line
  const parentAt = start + PARENT_PREFIX.length
  if (parentAt > contentEnd) return null
  if (buf.compare(PARENT_PREFIX, 0, PARENT_PREFIX.length, start, parentAt) !== 0) return null

  const hits = occurrences(buf, UUID_MEMBER, start, contentEnd)
  const memberAt = pickDepthOneUuidCandidate(buf, start, hits)
  if (memberAt === -1) return null
  const uuid = quotedUuidAt(buf, memberAt + UUID_MEMBER.length - 1, contentEnd)
  if (uuid === null) return null

  return {
    uuid,
    parent: quotedUuidAt(buf, parentAt, contentEnd),
    sidechain: hasTopLevelMember(buf, line, SIDECHAIN_MEMBER),
  }
}

export function walkChainBeforeParse(buf: Buffer): Buffer {
  const lines = splitLines(buf)
  const links = lines.map(line => readMessageLink(buf, line))

  const lineOfUuid = new Map<string, number>()
  let leaf = -1
  links.forEach((link, index) => {
    if (link === null) return
    lineOfUuid.set(link.uuid, index)
    if (!link.sidechain) leaf = index
  })
  if (leaf === -1) return buf

  const chain = new Set<number>()
  const visited = new Set<string>()
  let chainBytes = 0
  for (let index: number | undefined = leaf; index !== undefined; ) {
    const link: MessageLink = links[index]!
    if (visited.has(link.uuid)) break
    visited.add(link.uuid)
    chain.add(index)
    chainBytes += lines[index]!.end - lines[index]!.start
    index = link.parent === null ? undefined : lineOfUuid.get(link.parent)
  }

  // Cutting is only worth a copy when at least half the bytes go.
  if (buf.length - chainBytes < Math.floor(buf.length / 2)) return buf

  const kept: Buffer[] = []
  lines.forEach((line, index) => {
    if (links[index] === null || chain.has(index)) kept.push(buf.subarray(line.start, line.end))
  })
  return Buffer.concat(kept)
}
