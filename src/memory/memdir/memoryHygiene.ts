/**
 * The hygiene pass of the memory audit: what lets memory grow without ever
 * being cleaned, judged without a model. The October 2026 census found the
 * team index at its cap for seven weeks while the dir grew from 138 to 257
 * files, one user fact in five places, and memories that disagreed with no
 * record of it. Five findings, all report-only (memoryAudit.ts auditFails is
 * unchanged):
 *
 * - `near-duplicate`: two memories, in any pair of scopes, whose name and
 *   description share most of their words (nearDuplicateScore).
 * - `misplaced-type`: a `type: user` memory outside the global dir while it
 *   is on. The format guard refuses a new one; this finds the ones written
 *   before the global dir existed.
 * - `open-contradiction`: a memory whose `contradicts:` names others. It
 *   stays reported until someone reconciles them and removes the key.
 * - `index-over-cap`: a `MEMORY.md` over its line or byte cap — what it
 *   costs is in fitEntrypointContent, which shortens it to load it.
 * - `oversize`: a memory body over OVERSIZE_BYTES, read whole on each recall.
 *
 * The audit runs them in every scope; the dream digest, `/memory tidy` and
 * the write-time notes (memoryFormatGuard.ts) read the same functions.
 *
 * CLAUDIN_MEMORY_HYGIENE=0 turns off every model-facing part of memory
 * hygiene — the write-time notes, the Read note on `contradicts:`, the
 * dream's hygiene digest, deletes and prompt, tidy's cross-scope merges —
 * and leaves this audit, which no model reads, as it is
 * (isMemoryHygieneEnabled). It is also each bench's base arm.
 *
 * Near-duplicate threshold, calibrated 2026-10-31 on this repo's corpus
 * (global + private + team, 291 memories, 54 pairs ≥ 0.3), hand-labelled:
 * at ≥ 0.5 two pairs, both the same fact twice (two days of one census, two
 * no-op dependabot audits); at ≥ 0.4 ten, three of them; below that mostly a
 * decision beside the bench that measured it — related, not one fact. Hence
 * 0.5: precise, and blind to what it cannot see — a fact restated in another
 * language (the five PT-BR copies of the census were in other projects), or
 * a rule kept global with its case notes in a private memory on purpose.
 */
import { basename } from 'path'
import { fitEntrypointContent } from 'src/memory/memdir/memdir.js'
import type { AuditedFile } from 'src/memory/memdir/memoryAudit.js'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME, type MemoryScope } from 'src/memory/memdir/memoryScopes.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

/** Whether the model-facing parts of memory hygiene are on (the header). */
export function isMemoryHygieneEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_MEMORY_HYGIENE)
}

/** A body past this is reported: the two found in October were 12.7 KB, read 45 times. */
export const OVERSIZE_BYTES = 8 * 1024

/** The score from which two memories are reported as one fact twice. */
export const NEAR_DUPLICATE_MIN = 0.5

type Where = { scope: MemoryScope; path: string }

type NearDuplicateFinding = Where & { kind: 'near-duplicate'; other: Where; score: number }
type MisplacedTypeFinding = Where & { kind: 'misplaced-type'; type: 'user' }
type OpenContradictionFinding = Where & { kind: 'open-contradiction'; targets: string[] }
type IndexOverCapFinding = Where & { kind: 'index-over-cap'; bytes: number; lines: number; shortened: number }
type OversizeFinding = Where & { kind: 'oversize'; bytes: number }

export type HygieneFinding =
  | NearDuplicateFinding
  | MisplacedTypeFinding
  | OpenContradictionFinding
  | IndexOverCapFinding
  | OversizeFinding

const SPLIT_RE = /[^\p{L}\p{N}]+/u
const MARKS_RE = /\p{M}+/gu
const CAMEL_RE = /([a-z])([A-Z])/g

/** Words that say nothing about which fact a memory holds, in English and Portuguese. */
const STOPWORDS = new Set(
  (
    'the a an and or of to in on for with without from by at as is are was were be been it its this that these those ' +
    'not no never always when what which who how why than then into over under after before about only every any all ' +
    'one two can must should would will use used uses using via per vs' +
    ' o os as um uma uns umas de do da dos das em no na nos nas por para com sem que e ou se nao sim ao aos sempre nunca ' +
    'quando como mais menos ja eu ele ela voce isso esse essa este esta'
  ).split(' '),
)

/** A word's comparable form: lowercase, without accents, a plural off (`-ies` → `-y`, `-s`). */
function stem(word: string): string {
  const plain = word.normalize('NFD').replace(MARKS_RE, '').toLowerCase()
  if (plain.length > 4 && plain.endsWith('ies')) return `${plain.slice(0, -3)}y`
  return plain.length > 4 && plain.endsWith('s') && !plain.endsWith('ss') ? plain.slice(0, -1) : plain
}

/** The words of a memory's file stem, its `name` and its `description` that can tell facts apart. */
export function memoryTokens(path: string, name: string | null, description: string | null): Set<string> {
  const text = [basename(path, '.md'), name ?? '', description ?? ''].join(' ').replace(CAMEL_RE, '$1 $2')
  return new Set(
    text
      .split(SPLIT_RE)
      .map(stem)
      .filter(word => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word)),
  )
}

/**
 * How much two memories' words overlap, 0 to 1: the larger of the Jaccard
 * index and 0.8 × the share of the smaller set the larger one covers, so a
 * terse memory restated inside a fuller one still scores.
 */
export function nearDuplicateScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  const jaccard = shared / (a.size + b.size - shared)
  const containment = shared / Math.min(a.size, b.size)
  return Math.max(jaccard, 0.8 * containment)
}

type Memory = Where & {
  name: string | null
  type: string | null
  contradicts: string[]
  tokens: Set<string>
  bytes: number
}

const isIndex = (path: string): boolean => basename(path) === ENTRYPOINT_NAME

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : []
}

/** A memory's frontmatter, as the hygiene checks read it. */
export function readHygieneFacts(path: string, content: string): Omit<Memory, 'scope' | 'path'> {
  const { frontmatter } = parseFrontmatter(content)
  const text = (key: string): string | null =>
    typeof frontmatter[key] === 'string' && (frontmatter[key] as string).trim() !== '' ? (frontmatter[key] as string).trim() : null
  const name = text('name')
  return {
    name,
    type: text('type'),
    contradicts: asStrings(frontmatter.contradicts),
    tokens: memoryTokens(path, name, text('description')),
    bytes: Buffer.byteLength(content),
  }
}

/**
 * The memories of `memories` whose words are close enough to `tokens` to be
 * the same fact, best first. Shared by the audit and the write-time note.
 */
export function similarMemories<T extends { tokens: ReadonlySet<string> }>(
  tokens: ReadonlySet<string>,
  memories: readonly T[],
  min: number = NEAR_DUPLICATE_MIN,
): Array<{ memory: T; score: number }> {
  return memories
    .map(memory => ({ memory, score: nearDuplicateScore(tokens, memory.tokens) }))
    .filter(hit => hit.score >= min)
    .sort((x, y) => y.score - x.score)
}

export function findHygieneFindings(files: readonly AuditedFile[], dirs: readonly MemoryDir[]): HygieneFinding[] {
  const globalOn = dirs.some(dir => dir.scope === 'global')
  const findings: HygieneFinding[] = []
  const memories: Memory[] = []
  for (const file of files) {
    if (isIndex(file.path)) {
      const fit = fitEntrypointContent(file.content)
      if (fit.overLineCap || fit.overByteCap) {
        findings.push({ kind: 'index-over-cap', scope: file.scope, path: file.path, bytes: fit.byteCount, lines: fit.lineCount, shortened: fit.shortenedEntryCount })
      }
      continue
    }
    memories.push({ scope: file.scope, path: file.path, ...readHygieneFacts(file.path, file.content) })
  }
  for (const [i, memory] of memories.entries()) {
    if (globalOn && memory.type === 'user' && memory.scope !== 'global') {
      findings.push({ kind: 'misplaced-type', scope: memory.scope, path: memory.path, type: 'user' })
    }
    if (memory.contradicts.length > 0) {
      findings.push({ kind: 'open-contradiction', scope: memory.scope, path: memory.path, targets: memory.contradicts })
    }
    if (memory.bytes > OVERSIZE_BYTES) {
      findings.push({ kind: 'oversize', scope: memory.scope, path: memory.path, bytes: memory.bytes })
    }
    for (const { memory: other, score } of similarMemories(memory.tokens, memories.slice(i + 1))) {
      findings.push({
        kind: 'near-duplicate',
        scope: memory.scope,
        path: memory.path,
        other: { scope: other.scope, path: other.path },
        score: Math.round(score * 100) / 100,
      })
    }
  }
  return findings
}
