/**
 * The dream digest — what the consolidation fork is handed about the period
 * since the last consolidation, so it judges decisions with data instead of
 * grepping transcripts.
 *
 * Three sources, all already on disk:
 *   - plan files (`.claudin/plans/`): their `## Context` and
 *     `## Agreed Decisions`, plus a blast radius counted from the `files:`
 *     lines of `## Tasks` — a plan touching three slices or adding files is a
 *     structural candidate, a one-file plan almost never is;
 *   - the session index: `firstPrompt`, `customTitle` and `summary` per
 *     session, as getSessionFilesLite derives them from the head and tail of
 *     each transcript — `firstPrompt` is the user's own prompt text, clipped
 *     to `promptChars`; the transcript body, where a paste may hold a secret,
 *     is never handed over — only the memory files the session wrote, read
 *     from its tool calls (memoryWrites.ts), and, apart, the memory files
 *     that changed in the period without a session to show for it;
 *   - the commit subjects since then, filtered to `feat`, `refactor` and
 *     breaking (`!`) — the `type(scope)!:` convention git-conventions.md
 *     already enforces is the impact classifier the team maintains for free.
 *
 * Beside them, from one scan of the memory dirs (memoryScan.ts, uncapped),
 * the memories changed in the period with no session to show for it, and
 * those past their `expires:` date, with what the dream does with one:
 * re-verify it. And, unless CLAUDIN_MEMORY_HYGIENE=0, what the hygiene pass
 * of the audit finds (memoryHygiene.ts) — near-duplicates, user memories
 * outside the global dir, open contradictions, indexes over their cap,
 * oversized memories — each with what the dream does about it.
 *
 * buildDreamDigest is pure over injected inputs and capped so the digest stays
 * a few KB; collectDreamDigest is the I/O half, and each source that fails to
 * read is simply left out.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { readMemoryWrites } from 'src/memory/autoDream/memoryWrites.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import { auditHygiene } from 'src/memory/memdir/memoryAudit.js'
import { isExpired, localDay } from 'src/memory/memdir/memoryExpires.js'
import { type HygieneFinding, isMemoryHygieneEnabled } from 'src/memory/memdir/memoryHygiene.js'
import { type MemoryHeader, scanMemoryFiles } from 'src/memory/memdir/memoryScan.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { relativeIfInside } from 'src/shared/fs/path.js'
import { logError } from 'src/shared/log.js'
import { execFileNoThrow } from 'src/shared/proc/execFileNoThrow.js'
import {
  enrichLogs,
  getSessionFilesLite,
} from 'src/sessions/indexing/liteMetadata.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'

type DigestPlan = { path: string; mtimeMs: number; content: string }

type DigestSession = {
  sessionId: string
  mtimeMs: number
  firstPrompt: string
  customTitle?: string
  summary?: string
  /** The memory files the session's main agent wrote (absolute). */
  memoryWrites?: string[]
}

type DigestExpired = { path: string; expires: string }

export type DreamDigestInputs = {
  sinceMs: number
  plans: DigestPlan[]
  sessions: DigestSession[]
  commitSubjects: string[]
  expired?: DigestExpired[]
  /** Memory files modified in the period (absolute), whoever wrote them. */
  changedMemories?: string[]
  /**
   * What the hygiene pass found, when memory hygiene is on; undefined when
   * it is off, which also keeps the old rule for expired memories.
   */
  hygiene?: HygieneFinding[]
  /** What a memory path is shown relative to (relativeIfInside). */
  cwd: string
}

export type DreamDigestCaps = {
  plansChars: number
  planChars: number
  sessionsChars: number
  promptChars: number
  commitsChars: number
  expiredChars: number
  /** Memory files named per session before the rest are counted. */
  writesPerSession: number
  changedChars: number
  hygieneChars: number
}

export const DEFAULT_DIGEST_CAPS: DreamDigestCaps = {
  plansChars: 5_000,
  planChars: 1_800,
  sessionsChars: 2_000,
  promptChars: 200,
  commitsChars: 1_500,
  expiredChars: 1_000,
  writesPerSession: 5,
  changedChars: 800,
  hygieneChars: 2_500,
}

const SECTION_HEADING_RE = /^## +(.+?)\s*$/
const FILES_LINE_RE = /^\s*-\s*files:\s*(.+)$/i
const NEW_FILE_MARKER_RE = /\((novo|new)\)/i
const IMPACTFUL_COMMIT_RE = /^(feat|refactor)(\(|!|:)|^\w+(\([^)]*\))?!:/

/** `src/memory/x.ts` → `memory`; `scripts/x` → `scripts`; `.claudin/x` → `.claudin`. */
function sliceOf(filePath: string): string {
  const parts = filePath.split('/').filter(p => p.length > 0)
  if (parts[0] === 'src' && parts.length > 1) return parts[1]!
  return parts[0] ?? filePath
}

/**
 * Counts what a plan touches from the `files:` sub-bullets of its `## Tasks`
 * section: distinct files, the slices they fall in, and how many are marked
 * new (`(novo)` / `(new)`). A path written as `a → b` (a move) counts once.
 */
export function summarizePlanBlastRadius(content: string): {
  files: number
  slices: string[]
  newFiles: number
} {
  const files = new Set<string>()
  const slices = new Set<string>()
  let newFiles = 0
  let inTasks = false
  for (const line of content.split('\n')) {
    const heading = SECTION_HEADING_RE.exec(line)
    if (heading) {
      inTasks = heading[1]!.toLowerCase() === 'tasks'
      continue
    }
    if (!inTasks) continue
    const match = FILES_LINE_RE.exec(line)
    if (!match) continue
    for (const raw of match[1]!.split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      if (NEW_FILE_MARKER_RE.test(entry)) newFiles++
      const path = entry
        .split('→')[0]!
        .replace(/\s*\(.*\)\s*$/, '')
        .trim()
      if (!path) continue
      files.add(path)
      slices.add(sliceOf(path))
    }
  }
  return { files: files.size, slices: [...slices].sort(), newFiles }
}

/** The body of `## Context` and `## Agreed Decisions`, empty when absent. */
export function extractPlanSections(content: string): {
  context: string
  decisions: string
} {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const line of content.split('\n')) {
    const heading = SECTION_HEADING_RE.exec(line)
    if (heading) {
      current = heading[1]!.toLowerCase()
      sections.set(current, [])
      continue
    }
    if (current !== null) sections.get(current)!.push(line)
  }
  const body = (name: string): string =>
    (sections.get(name) ?? []).join('\n').trim()
  return { context: body('context'), decisions: body('agreed decisions') }
}

export function isImpactfulCommitSubject(subject: string): boolean {
  return IMPACTFUL_COMMIT_RE.test(subject.trim())
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

function clipBlock(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function renderPlan(plan: DigestPlan, caps: DreamDigestCaps): string {
  const radius = summarizePlanBlastRadius(plan.content)
  const { context, decisions } = extractPlanSections(plan.content)
  const header = `- \`${plan.path}\` — ${radius.files} files across ${radius.slices.length} slices (${radius.slices.join(', ') || 'none listed'}), ${radius.newFiles} new`
  const budget = Math.max(0, caps.planChars - header.length)
  const parts: string[] = [header]
  if (context) {
    parts.push(`  Context: ${clipBlock(context, Math.floor(budget / 3))}`)
  }
  if (decisions) {
    parts.push(
      `  Agreed Decisions:\n${clipBlock(decisions, budget - (parts[1]?.length ?? 0))
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n')}`,
    )
  }
  return parts.join('\n')
}

function renderSession(session: DigestSession, caps: DreamDigestCaps, cwd: string): string {
  const title = session.customTitle ? `${clip(session.customTitle, 80)} — ` : ''
  const summary = session.summary
    ? ` · summary: ${clip(session.summary, caps.promptChars)}`
    : ''
  const writes = session.memoryWrites ?? []
  const named = writes.slice(0, caps.writesPerSession).map(p => relativeIfInside(p, cwd))
  const more = writes.length > named.length ? ` and ${writes.length - named.length} more` : ''
  const written = named.length > 0 ? `\n  memories written: ${named.join(', ')}${more}` : ''
  return `- ${session.sessionId.slice(0, 8)} · ${title}"${clip(session.firstPrompt, caps.promptChars)}"${summary}${written}`
}

/** Fills `lines` from `items` until the character cap; returns how many were left out. */
function takeUnderCap(items: string[], cap: number): { kept: string[]; left: number } {
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    if (used + item.length + 1 > cap) break
    kept.push(item)
    used += item.length + 1
  }
  return { kept, left: items.length - kept.length }
}

export function buildDreamDigest(
  inputs: DreamDigestInputs,
  caps: DreamDigestCaps = DEFAULT_DIGEST_CAPS,
): string {
  const since = new Date(inputs.sinceMs).toISOString()
  const out: string[] = [
    `## Decision sources since ${inputs.sinceMs > 0 ? since : 'the beginning'}`,
    '',
    'Judge each candidate against the decisions bar (impact class + why outside the diff + what changes for a teammate). A plan with a small blast radius or a session whose prompt is routine work is usually not one.',
  ]

  const plans = inputs.plans
    .filter(p => p.mtimeMs > inputs.sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (plans.length > 0) {
    const rendered = plans.map(p => renderPlan(p, caps))
    const { kept, left } = takeUnderCap(rendered, caps.plansChars)
    out.push('', `### Plans modified (${plans.length}) — blast radius from their Tasks`, ...kept)
    if (left > 0) {
      out.push(
        `Also modified, not expanded here (read them if the ones above suggest a pattern): ${plans
          .slice(kept.length)
          .map(p => `\`${p.path}\``)
          .join(', ')}`,
      )
    }
  }

  const sessions = inputs.sessions
    .filter(s => s.mtimeMs > inputs.sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (sessions.length > 0) {
    const rendered = sessions.map(s => renderSession(s, caps, inputs.cwd))
    const { kept, left } = takeUnderCap(rendered, caps.sessionsChars)
    out.push('', `### Session prompts (${sessions.length})`, ...kept)
    if (left > 0) out.push(`…and ${left} more sessions.`)
  }

  const attributed = new Set(sessions.flatMap(s => s.memoryWrites ?? []))
  const unattributed = (inputs.changedMemories ?? []).filter(p => !attributed.has(p))
  if (unattributed.length > 0) {
    const { kept, left } = takeUnderCap(
      unattributed.map(p => `- ${relativeIfInside(p, inputs.cwd)}`),
      caps.changedChars,
    )
    out.push('', `### Memories also changed in this period (${unattributed.length}) — by a background pass or by hand, no session to show for it`, ...kept)
    if (left > 0) out.push(`…and ${left} more.`)
  }

  const commits = inputs.commitSubjects.filter(isImpactfulCommitSubject)
  if (commits.length > 0) {
    const { kept, left } = takeUnderCap(
      commits.map(c => `- ${clip(c, 120)}`),
      caps.commitsChars,
    )
    out.push('', `### Commits — feat / refactor / breaking (${commits.length})`, ...kept)
    if (left > 0) out.push(`…and ${left} more.`)
  }

  if (plans.length === 0 && sessions.length === 0 && commits.length === 0 && unattributed.length === 0) {
    out.push('', 'Nothing was modified in this period beyond the current session.')
  }

  const expired = inputs.expired ?? []
  // With hygiene on, a snapshot is folded and deleted (the prompt's Phase 3)
  const snapshot = inputs.hygiene === undefined ? '' : ' A dated measurement or status (a census, a bench, a PR): fold it and delete it, as Phase 3 says.'
  if (expired.length > 0) {
    const { kept, left } = takeUnderCap(
      expired.map(e => `- \`${e.path}\` — expired ${e.expires}`),
      caps.expiredChars,
    )
    out.push(
      '',
      `## Memories past their \`expires:\` date (${expired.length})`,
      '',
      `Re-verify each against what you see now.${snapshot} ${snapshot ? 'Anything else still true' : 'Still true'}: move its \`expires:\` forward, or drop the key if it no longer has an end. Contradicted: fix or delete it like any drifted fact (outside the global dir). Unsure: leave it as it is and name it in your summary. An expired date alone${snapshot ? ', on a memory that is not a snapshot,' : ''} is never a reason to delete.`,
      ...kept,
    )
    if (left > 0) out.push(`…and ${left} more.`)
  }

  const hygiene = inputs.hygiene ?? []
  if (hygiene.length > 0) {
    const rel = (path: string) => `\`${relativeIfInside(path, inputs.cwd)}\``
    const lines = hygiene.map(f => {
      switch (f.kind) {
        case 'near-duplicate':
          return `- near-duplicate: ${rel(f.path)} (${f.scope}) reads like ${rel(f.other.path)} (${f.other.scope}, ${f.score})`
        case 'misplaced-type':
          return `- user memory outside the global dir: ${rel(f.path)} (${f.scope})`
        case 'open-contradiction':
          return `- contradiction: ${rel(f.path)} (${f.scope}) contradicts ${f.targets.map(t => `\`${t}\``).join(', ')}`
        case 'index-over-cap':
          return `- index over its cap: ${rel(f.path)}, ${f.lines} lines and ${f.bytes} bytes${f.shortened ? `, ${f.shortened} entries load without their hook` : ''}`
        case 'oversize':
          return `- oversized: ${rel(f.path)} (${f.scope}), ${Math.round(f.bytes / 1024)} KB read whole on every recall`
      }
    })
    const { kept, left } = takeUnderCap(lines, caps.hygieneChars)
    out.push(
      '',
      `## Memory hygiene (${hygiene.length})`,
      '',
      'What the audit found without judging it. Decide each from the files and the code, as Phases 3 and 4 say; a contradiction you settle loses its `contradicts:` key.',
      ...kept,
    )
    if (left > 0) out.push(`…and ${left} more.`)
  }

  return out.join('\n')
}

export type DreamDigestDeps = {
  listPlans(sinceMs: number): Promise<DigestPlan[]>
  listSessions(sessionIds: readonly string[]): Promise<DigestSession[]>
  commitSubjectsSince(sinceMs: number): Promise<string[]>
  /** Every memory file's header, across the memory dirs. */
  listMemoryHeaders(): Promise<MemoryHeader[]>
  /** What the hygiene pass finds across the memory dirs; absent, none. */
  listHygieneFindings?(): Promise<HygieneFinding[]>
}

async function listPlansOnDisk(sinceMs: number): Promise<DigestPlan[]> {
  const dir = getPlansDirectory()
  const names = await readdir(dir)
  const plans: DigestPlan[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(dir, name)
    const info = await stat(path)
    if (!info.isFile() || info.mtimeMs <= sinceMs) continue
    plans.push({
      path,
      mtimeMs: info.mtimeMs,
      content: await readFile(path, 'utf8'),
    })
  }
  return plans
}

async function listSessionsFromIndex(
  sessionIds: readonly string[],
): Promise<DigestSession[]> {
  if (sessionIds.length === 0) return []
  const wanted = new Set(sessionIds)
  const lite = (await getSessionFilesLite(getProjectDir(getOriginalCwd()))).filter(
    log => log.sessionId !== undefined && wanted.has(log.sessionId),
  )
  const { logs } = await enrichLogs(lite, 0, lite.length)
  const dirs = getMemoryDirs()
  return Promise.all(
    logs.map(async log => ({
      sessionId: log.sessionId ?? '',
      mtimeMs: log.modified.getTime(),
      firstPrompt: log.firstPrompt,
      customTitle: log.customTitle,
      summary: log.summary,
      memoryWrites: log.fullPath
        ? await readMemoryWrites(log.fullPath, getOriginalCwd(), dirs).catch(error => {
            logError(error)
            return []
          })
        : [],
    })),
  )
}

async function commitSubjectsFromGit(sinceMs: number): Promise<string[]> {
  const args = ['log', '--format=%s', '--no-merges']
  if (sinceMs > 0) args.push(`--since=${new Date(sinceMs).toISOString()}`)
  const { stdout, code } = await execFileNoThrow('git', args)
  if (code !== 0) return []
  return stdout.split('\n').filter(line => line.trim().length > 0)
}

async function memoryHeadersOnDisk(): Promise<MemoryHeader[]> {
  const signal = new AbortController().signal
  const headers: MemoryHeader[] = []
  for (const dir of getMemoryDirs()) {
    headers.push(
      ...(await scanMemoryFiles(dir.root, signal, { recursive: dir.scope === 'team', limit: Infinity })),
    )
  }
  return headers
}


const defaultDreamDigestDeps: DreamDigestDeps = {
  listPlans: listPlansOnDisk,
  listSessions: listSessionsFromIndex,
  commitSubjectsSince: commitSubjectsFromGit,
  listMemoryHeaders: memoryHeadersOnDisk,
  listHygieneFindings: () => auditHygiene(getMemoryDirs()),
}

/**
 * A source that fails to read is left out — the dream runs without it, and
 * the failure goes to the debug log rather than blocking a consolidation.
 */
async function orEmpty<T>(source: Promise<T[]>): Promise<T[]> {
  try {
    return await source
  } catch (error) {
    logError(error)
    return []
  }
}

export async function collectDreamDigest(
  sinceMs: number,
  sessionIds: readonly string[],
  deps: DreamDigestDeps = defaultDreamDigestDeps,
): Promise<string> {
  const hygieneOn = isMemoryHygieneEnabled()
  const [plans, sessions, commitSubjects, headers, hygiene] = await Promise.all([
    orEmpty(deps.listPlans(sinceMs)),
    orEmpty(deps.listSessions(sessionIds)),
    orEmpty(deps.commitSubjectsSince(sinceMs)),
    orEmpty(deps.listMemoryHeaders()),
    hygieneOn && deps.listHygieneFindings ? orEmpty(deps.listHygieneFindings()) : Promise.resolve([]),
  ])
  const today = localDay()
  const expired = headers.flatMap(h =>
    h.expires !== null && isExpired(h.expires, today) ? [{ path: h.filePath, expires: h.expires }] : [],
  )
  const changedMemories = headers.filter(h => h.mtimeMs > sinceMs).map(h => h.filePath)
  return buildDreamDigest({
    sinceMs,
    plans,
    sessions,
    commitSubjects,
    expired,
    changedMemories,
    ...(hygieneOn ? { hygiene } : {}),
    cwd: getOriginalCwd(),
  })
}
