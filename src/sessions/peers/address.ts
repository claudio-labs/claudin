/**
 * Peer addresses and session names. Kept free of socket code so that
 * SendMessageTool can parse an address at tool-enumeration time without
 * loading the transport.
 */
import { createHash } from 'crypto'
import { basename } from 'path'
import { toAgentId } from 'src/shared/types/ids.js'

const UDS_SCHEME = 'uds:'

/** Parse a URI-style address into scheme + target. */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'other'
  target: string
} {
  if (to.startsWith(UDS_SCHEME)) return { scheme: 'uds', target: to.slice(UDS_SCHEME.length) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice(7) }
  // Legacy: old-code UDS senders emit bare socket paths in from=; route them
  // through the UDS branch so replies aren't silently dropped into teammate
  // routing. (No bare-session-ID fallback — bridge messaging is new enough
  // that no old senders exist, and the prefix would hijack teammate names
  // like session_manager.)
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}

/** The address a session's inbox answers to — what `from` carries. */
export function formatUdsAddress(socketPath: string): string {
  return `${UDS_SCHEME}${socketPath}`
}

const NAME_MAX_CHARS = 200
// C0/C1 controls, zero-width and bidi-override code points: a name is shown to
// a model and a human, and neither should see text that is not there.
const INVISIBLE_RE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g
const WHITESPACE_RE = /\s+/g
const REF_SUFFIX_RE = /\s\[[0-9a-f]{6,12}\]$/
const RESERVED_NAMES = new Set(['main', 'team-lead', 'user', 'system', '*'])

function cleanName(raw: string | undefined): string {
  return (raw ?? '')
    .replace(WHITESPACE_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .trim()
    .slice(0, NAME_MAX_CHARS)
}

/** A name no other address form claims, so a send can route by it. */
function isAddressableName(name: string): boolean {
  return (
    name.length > 0 &&
    !RESERVED_NAMES.has(name.toLowerCase()) &&
    !name.includes('@') &&
    parseAddress(name).scheme === 'other' &&
    !REF_SUFFIX_RE.test(name) &&
    toAgentId(name) === null
  )
}

/**
 * The name a session answers to: its own (`--name`, `/rename`), else its
 * working directory's — which is what tells parallel worktrees apart.
 */
export function sessionDisplayName(name: string | undefined, cwd: string): string {
  for (const candidate of [cleanName(name), cleanName(basename(cwd))]) {
    if (isAddressableName(candidate)) return candidate
  }
  return 'session'
}

/** A display name as another session claims it, cleaned the same way. */
export function cleanClaimedName(raw: string | undefined): string | undefined {
  const name = cleanName(raw)
  return name.length > 0 ? name : undefined
}

export function sessionRefHash(socketPath: string): string {
  return createHash('sha256').update(`session:${socketPath}`).digest('hex')
}

const REF_MIN_CHARS = 6
const REF_MAX_CHARS = 12

/** The shortest prefix of `hash`, 6 to 12 hex digits, no other hash shares. */
export function shortestUniqueRef(hash: string, all: readonly string[]): string {
  for (let length = REF_MIN_CHARS; length < REF_MAX_CHARS; length++) {
    const prefix = hash.slice(0, length)
    if (!all.some(other => other !== hash && other.startsWith(prefix))) return prefix
  }
  return hash.slice(0, REF_MAX_CHARS)
}

const NAME_WITH_REF_RE = /^(.*\S)\s+\[([0-9a-f]{6,12})\]$/

/** `claudin-goal [3fa9c1]` → name and ref; a bare name → name alone. */
export function parsePeerTarget(to: string): { name: string; ref?: string } {
  const trimmed = to.trim()
  const match = NAME_WITH_REF_RE.exec(trimmed)
  return match ? { name: match[1]!, ref: match[2]! } : { name: trimmed }
}
