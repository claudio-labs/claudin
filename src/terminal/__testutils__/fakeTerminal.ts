/**
 * A terminal to mount an Ink tree in a test. The input side passes for a TTY
 * in raw mode, so a component that reads keys mounts without Ink's raw-mode
 * error; the output side records everything the renderer writes.
 *
 * The renderer brackets each frame in DEC synchronized-update markers
 * (CSI ? 2026 h … CSI ? 2026 l). What a user would be looking at is therefore
 * the last complete bracket that painted anything.
 */
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const BEGIN_FRAME = '\u001B[?2026h'
const END_FRAME = '\u001B[?2026l'

export type FakeTerminal = {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  /** Sends raw input, the way a keypress or a paste arrives. */
  type: (input: string) => void
  /** The last painted frame, without escape codes. */
  screen: () => string
  /** Every byte written so far, escape codes included. */
  transcript: () => string
  close: () => void
}

export function createFakeTerminal(size: { columns?: number } = {}): FakeTerminal {
  const keyboard = new PassThrough()
  const display = new PassThrough()
  Object.assign(keyboard, {
    isTTY: true,
    setRawMode: () => keyboard,
    ref: () => keyboard,
    unref: () => keyboard,
  })
  Object.assign(display, { columns: size.columns ?? 80 })

  let written = ''
  display.setEncoding('utf8')
  display.on('data', (chunk: string) => {
    written += chunk
  })

  return {
    stdin: keyboard as unknown as NodeJS.ReadStream,
    stdout: display as unknown as NodeJS.WriteStream,
    type: input => {
      keyboard.write(input)
    },
    screen: () => stripAnsi(lastPaintedFrame(written)),
    transcript: () => written,
    close: () => {
      keyboard.end()
      display.end()
    },
  }
}

/**
 * The last complete frame that painted something. A frame still being written
 * has no closing marker yet and is skipped; a stream with no markers at all is
 * returned whole.
 */
export function lastPaintedFrame(stream: string): string {
  const complete = stream
    .split(BEGIN_FRAME)
    .slice(1)
    .filter(chunk => chunk.includes(END_FRAME))
    .map(chunk => chunk.slice(0, chunk.indexOf(END_FRAME)))
  return complete.findLast(frame => frame.trim() !== '') ?? stream
}
