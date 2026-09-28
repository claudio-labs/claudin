import { GrowableBytes } from 'src/sessions/sessionStoragePortable/growableBytes.js'
import { type LineReceiver, LineSplitter } from 'src/sessions/sessionStoragePortable/lineSplitter.js'
import {
  boundaryKindOf,
  LINE_KIND_PREFIX_BYTES,
  type LineKind,
  lineKind,
} from 'src/sessions/sessionStoragePortable/transcriptLine.js'

const LF = 0x0a
const LF_BYTES = Buffer.from([LF])
const HELD_LINE_CAPACITY = 512

export type TranscriptForLoad = {
  /** Where the last ordinary compact boundary starts in the file, or 0. */
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  /** A preserved-segment boundary follows the last ordinary one. */
  hasPreservedSegment: boolean
}

/**
 * Builds what resume loads from a large transcript, line by line, however the
 * file is read: everything from the last ordinary compact boundary on, with
 * every attribution snapshot taken out and the latest one after the cut moved
 * to the end. Only boundary candidates are parsed; other lines are copied.
 */
export class TranscriptLoadAssembler implements LineReceiver {
  private readonly splitter: LineSplitter
  private readonly maxBytes: number
  private output: GrowableBytes
  private latestSnapshot: Buffer | undefined
  private boundaryStartOffset = 0
  private hasPreservedSegment = false

  private lineOffset = 0
  private kind: LineKind | undefined
  // The current line's first bytes until its kind is settled, then the whole
  // line when it is a snapshot or a boundary candidate.
  private held = new GrowableBytes(Number.POSITIVE_INFINITY, HELD_LINE_CAPACITY)

  /** `maxBytes` bounds the stream, so the output is never allocated past it. */
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
    this.splitter = new LineSplitter(this)
    this.output = this.outputFrom(0)
  }

  push(chunk: Buffer): void {
    this.splitter.push(chunk)
  }

  finish(): TranscriptForLoad {
    this.splitter.finish()
    if (this.latestSnapshot) {
      if (this.output.length > 0 && this.output.lastByte() !== LF) this.output.append(LF_BYTES)
      this.output.append(this.latestSnapshot)
    }
    return {
      boundaryStartOffset: this.boundaryStartOffset,
      postBoundaryBuf: this.output.view(),
      hasPreservedSegment: this.hasPreservedSegment,
    }
  }

  lineStart(offset: number): void {
    this.lineOffset = offset
    this.kind = undefined
    // Fresh each line: a finished snapshot keeps the previous holder's bytes.
    this.held = new GrowableBytes(Number.POSITIVE_INFINITY, HELD_LINE_CAPACITY)
  }

  linePiece(piece: Buffer): void {
    let rest = piece
    if (this.kind === undefined) {
      const missing = LINE_KIND_PREFIX_BYTES - this.held.length
      this.held.append(rest.subarray(0, missing))
      rest = rest.subarray(missing)
      if (this.held.length < LINE_KIND_PREFIX_BYTES) return
      this.settleKind()
    }
    if (rest.length === 0) return
    if (this.kind === 'plain') this.output.append(rest)
    else this.held.append(rest)
  }

  lineEnd(): void {
    if (this.kind === undefined) this.settleKind()
    if (this.kind === 'snapshot') this.latestSnapshot = this.held.view()
    else if (this.kind === 'boundaryCandidate') this.acceptCandidate(this.held.view())
  }

  private settleKind(): void {
    this.kind = lineKind(this.held.view())
    if (this.kind === 'plain') this.output.append(this.held.view())
  }

  private acceptCandidate(line: Buffer): void {
    const boundary = boundaryKindOf(line)
    if (boundary === 'ordinary') {
      this.output = this.outputFrom(this.lineOffset)
      this.latestSnapshot = undefined
      this.boundaryStartOffset = this.lineOffset
      this.hasPreservedSegment = false
    } else if (boundary === 'preserved') {
      this.hasPreservedSegment = true
    }
    this.output.append(line)
  }

  // Everything from `offset` on, plus the LF that may go in before a moved snapshot.
  private outputFrom(offset: number): GrowableBytes {
    return new GrowableBytes(Math.max(0, this.maxBytes - offset) + 1)
  }
}
