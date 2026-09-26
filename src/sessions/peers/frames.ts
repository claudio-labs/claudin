/**
 * The wire format between session inboxes: one NDJSON request per
 * connection, answered by one NDJSON response. `v` is checked first, so a
 * session running a newer protocol is refused with a reason instead of a
 * schema error.
 */
import { z } from 'zod/v4'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

export const FRAME_VERSION = 1
export const MAX_FRAME_BYTES = 1024 * 1024
/** A message, not a file transfer: past this the sender is told to send a path. */
export const MESSAGE_MAX_CHARS = 100_000

/**
 * `bypass` for a session in bypassPermissions, `prompting` for every mode
 * that still stops for its user. Inbound policy compares the two ends.
 */
const PermissionClassSchema = lazySchema(() => z.enum(['bypass', 'prompting']))
export type PermissionClass = z.infer<ReturnType<typeof PermissionClassSchema>>

const common = () => ({
  v: z.literal(FRAME_VERSION),
  msg_id: z.string().min(1).max(100),
  token: z.string().min(1).max(200),
  /** The sender's own `uds:` address; absent when it has no inbox. */
  from: z.string().max(1100).optional(),
  from_name: z.string().max(400).optional(),
  from_mode: PermissionClassSchema().optional(),
  /**
   * The sender is in plan mode — still `prompting` in `from_mode`, so a
   * session that predates this field reads it as it always did.
   */
  from_plan: z.boolean().optional(),
})

const RequestFrameSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('ping'), ...common() }),
    z.object({
      type: z.literal('message'),
      ...common(),
      text: z.string().max(MESSAGE_MAX_CHARS),
      /** Set when one of the sender's subagents wrote it. */
      from_agent: z.string().max(400).optional(),
      /** Also subscribe: one notice when the receiver next goes idle. */
      notify_when_idle: z.boolean().optional(),
    }),
    z.object({
      /** A pure subscription: tell me once when you next go idle or exit. */
      type: z.literal('notify_when_idle'),
      ...common(),
    }),
    z.object({
      /** A held message's outcome, sent back to the session that sent it. */
      type: z.literal('delivery_status'),
      ...common(),
      orig_msg_id: z.string().min(1).max(100),
      status: z.enum(['delivered', 'denied', 'expired']),
    }),
    z.object({
      /** The answer to a notify_when_idle: the session went idle or is exiting. */
      type: z.literal('idle_notice'),
      ...common(),
      orig_msg_id: z.string().min(1).max(100),
      state: z.enum(['idle', 'exited', 'expired']),
      finished_at: z.number().optional(),
    }),
  ]),
)
export type RequestFrame = z.infer<ReturnType<typeof RequestFrameSchema>>

const ResponseFrameSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    outcome: z.enum(['delivered', 'held', 'refused', 'subscribed', 'pong']).optional(),
    detail: z.string().max(2000).optional(),
    /** For a send that asked notify_when_idle: whether the receiver took it. */
    subscribed: z.boolean().optional(),
  }),
)
export type ResponseFrame = z.infer<ReturnType<typeof ResponseFrameSchema>>

export function encodeFrame(frame: RequestFrame | ResponseFrame): string {
  return `${jsonStringify(frame)}\n`
}

/**
 * Reads a connection's one line: feed it each chunk, and it answers once — the
 * line, or that it outgrew `maxBytes` — then ignores whatever follows, so a
 * frame is taken once however the sender keeps writing. The chunks stay bytes
 * until the newline: a character split across two of them decodes whole, and
 * the cap counts bytes, not UTF-16 units.
 */
export function createLineReader(
  maxBytes: number = MAX_FRAME_BYTES,
): (chunk: Buffer | string) => { line: string } | { tooLarge: true } | undefined {
  const chunks: Buffer[] = []
  let size = 0
  let done = false
  return chunk => {
    if (done) return undefined
    // Sockets here never set an encoding, so a chunk arrives as bytes.
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const end = bytes.indexOf(0x0a)
    const kept = end === -1 ? bytes : bytes.subarray(0, end)
    chunks.push(kept)
    size += kept.length
    if (size > maxBytes) {
      done = true
      return { tooLarge: true }
    }
    if (end === -1) return undefined
    done = true
    return { line: Buffer.concat(chunks).toString('utf8') }
  }
}

/** Parse one request line; a reason instead of a frame when it is unusable. */
export function decodeRequest(line: string): { frame: RequestFrame } | { error: string } {
  let raw: unknown
  try {
    raw = jsonParse(line)
  } catch {
    return { error: 'not a JSON frame' }
  }
  const version =
    typeof raw === 'object' && raw !== null && 'v' in raw ? raw.v : undefined
  if (version !== FRAME_VERSION) {
    return { error: `unsupported protocol version ${String(version)}` }
  }
  const parsed = RequestFrameSchema().safeParse(raw)
  return parsed.success ? { frame: parsed.data } : { error: 'malformed frame' }
}

export function decodeResponse(line: string): ResponseFrame | undefined {
  try {
    const parsed = ResponseFrameSchema().safeParse(jsonParse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
