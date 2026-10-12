/**
 * How often each skill was actually invoked, read from this project's session
 * transcripts — the evidence `/skill-doctor` uses for "this description never
 * triggers".
 *
 * Two kinds of invocation, counted apart because they mean different things:
 *  - **model**: an assistant `tool_use` block named `Skill` (input.skill). This
 *    is the description doing its job; zero here is the "never triggers" signal.
 *  - **user**: a user message that starts with `<command-message>NAME` — what
 *    processSlashCommand.tsx records when someone types `/NAME`.
 *
 * Only those two shapes count. A grep for the skill name also matches tool
 * results that merely quote it (a session-corpus census overcounts ~3x that
 * way), so every candidate line is parsed and checked for its role and block
 * type. Repeated blocks — a resumed session re-records history — are counted
 * once, by tool_use id or message uuid.
 *
 * Main-session files and their sub-agents' (`<session>/subagents/*.jsonl`) are
 * both read: a skill a sub-agent invoked did trigger.
 */
import { join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

export type SkillInvocationCounts = {
  model: number
  user: number
  /** Epoch ms of the latest invocation of either kind. */
  lastAt: number | undefined
}

export type SkillUsageCensus = {
  bySkill: Map<string, SkillInvocationCounts>
  /** Main-session transcripts inside the window. */
  sessionsScanned: number
  /** Every transcript read, sub-agents included. */
  filesScanned: number
}

/** Cheap substring gates, so only candidate lines pay for a JSON.parse. */
const SKILL_TOOL_MARKER = '"name":"Skill"'
const COMMAND_MESSAGE_MARKER = '<command-message>'
const MARKERS = [SKILL_TOOL_MARKER, COMMAND_MESSAGE_MARKER].map(m => Buffer.from(m))
const NEWLINE = 0x0a
const COMMAND_MESSAGE_RE = /^<command-message>([^<]+)<\/command-message>/
const JSONL_RE = /\.jsonl$/
const LEADING_SLASH_RE = /^\//

type TranscriptLine = {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
}

async function listJsonl(dir: string): Promise<string[]> {
  const fs = getFsImplementation()
  try {
    return (await fs.readdir(dir))
      .filter(entry => entry.isFile() && JSONL_RE.test(entry.name))
      .map(entry => join(dir, entry.name))
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return []
    throw e
  }
}

function record(
  census: SkillUsageCensus,
  name: string,
  kind: 'model' | 'user',
  timestamp: unknown,
): void {
  const skill = name.trim().replace(LEADING_SLASH_RE, '')
  if (!skill) return
  const counts = census.bySkill.get(skill) ?? { model: 0, user: 0, lastAt: undefined }
  counts[kind]++
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
  if (!Number.isNaN(at) && (counts.lastAt === undefined || at > counts.lastAt)) {
    counts.lastAt = at
  }
  census.bySkill.set(skill, counts)
}

function scanLine(line: string, census: SkillUsageCensus, seen: Set<string>): void {
  const maybeTool = line.includes(SKILL_TOOL_MARKER)
  let entry: TranscriptLine
  try {
    entry = JSON.parse(line) as TranscriptLine
  } catch {
    // A torn last line of a live session; the census is best-effort.
    return
  }
  const content = entry.message?.content

  if (entry.type === 'assistant' && maybeTool && Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type !== 'tool_use' || block.name !== 'Skill') continue
      const input = block.input as { skill?: unknown } | undefined
      if (typeof input?.skill !== 'string') continue
      const id = typeof block.id === 'string' ? block.id : undefined
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      record(census, input.skill, 'model', entry.timestamp)
    }
    return
  }

  if (entry.type === 'user') {
    const first = Array.isArray(content) ? (content[0] as Record<string, unknown> | undefined) : undefined
    const text =
      typeof content === 'string'
        ? content
        : first?.type === 'text' && typeof first.text === 'string'
          ? first.text
          : undefined
    const match = text ? COMMAND_MESSAGE_RE.exec(text) : null
    if (!match?.[1]) return
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
    if (uuid) {
      if (seen.has(uuid)) return
      seen.add(uuid)
    }
    record(census, match[1], 'user', entry.timestamp)
  }
}

/**
 * Hands every line containing a marker to scanLine. The search runs on the
 * raw bytes and decodes only the matching lines: decoding a month of
 * transcripts (650 MB here) to strings is most of the cost otherwise.
 */
function scanBytes(bytes: Buffer, census: SkillUsageCensus, seen: Set<string>): void {
  const lineStarts = new Set<number>()
  for (const marker of MARKERS) {
    let at = bytes.indexOf(marker)
    while (at !== -1) {
      const start = bytes.lastIndexOf(NEWLINE, at) + 1
      const newline = bytes.indexOf(NEWLINE, at)
      const end = newline === -1 ? bytes.length : newline
      if (!lineStarts.has(start)) {
        lineStarts.add(start)
        scanLine(bytes.toString('utf8', start, end), census, seen)
      }
      at = newline === -1 ? -1 : bytes.indexOf(marker, end)
    }
  }
}

/**
 * Counts skill invocations in the transcripts under `transcriptDir` modified
 * at or after `sinceMs`. A missing directory is an empty census.
 */
export async function countSkillInvocations(options: {
  transcriptDir: string
  sinceMs: number
}): Promise<SkillUsageCensus> {
  const fs = getFsImplementation()
  const census: SkillUsageCensus = { bySkill: new Map(), sessionsScanned: 0, filesScanned: 0 }
  const seen = new Set<string>()

  const sessions = await listJsonl(options.transcriptDir)
  for (const session of sessions) {
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(session)).mtimeMs
    } catch (e: unknown) {
      logForDebugging(`[skillUsageCensus] cannot stat ${session}: ${String(e)}`)
      continue
    }
    if (mtimeMs < options.sinceMs) continue
    census.sessionsScanned++

    const subagentDir = join(session.replace(JSONL_RE, ''), 'subagents')
    for (const file of [session, ...(await listJsonl(subagentDir))]) {
      let bytes: Buffer
      try {
        bytes = await fs.readFileBytes(file)
      } catch (e: unknown) {
        logForDebugging(`[skillUsageCensus] unreadable transcript ${file}: ${String(e)}`)
        continue
      }
      census.filesScanned++
      scanBytes(bytes, census, seen)
    }
  }

  return census
}
