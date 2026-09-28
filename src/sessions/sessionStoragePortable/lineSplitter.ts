const LF = 0x0a

/** Receives each line in pieces, in stream order. A line's last piece ends with its LF, if it has one. */
export type LineReceiver = {
  lineStart(offset: number): void
  linePiece(piece: Buffer): void
  lineEnd(): void
}

/**
 * Cuts a byte stream into lines. Where the stream's chunks begin and end
 * changes only how many pieces a line arrives in, never the lines themselves.
 * A piece is valid only during the call, because the reader reuses its buffer.
 */
export class LineSplitter {
  private readonly receiver: LineReceiver
  private offset = 0
  private inLine = false

  constructor(receiver: LineReceiver) {
    this.receiver = receiver
  }

  push(chunk: Buffer): void {
    let from = 0
    while (from < chunk.length) {
      if (!this.inLine) {
        this.receiver.lineStart(this.offset + from)
        this.inLine = true
      }
      const newline = chunk.indexOf(LF, from)
      const to = newline === -1 ? chunk.length : newline + 1
      this.receiver.linePiece(chunk.subarray(from, to))
      if (newline !== -1) {
        this.receiver.lineEnd()
        this.inLine = false
      }
      from = to
    }
    this.offset += chunk.length
  }

  /** Ends a last line that has no LF. */
  finish(): void {
    if (!this.inLine) return
    this.inLine = false
    this.receiver.lineEnd()
  }
}
