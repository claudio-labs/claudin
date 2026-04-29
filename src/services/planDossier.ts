import { randomUUID } from 'crypto'
import { rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getEffectiveContextWindowSize } from './compact/autoCompact.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { isENOENT } from '../utils/errors.js'
import { getFileModificationTimeAsync } from '../utils/file.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { logError } from '../utils/log.js'
import { getPlanFilePath } from '../utils/plans.js'

const DOSSIER_VERSION = 1 as const

export const HARD_CAP_PCT = 0.25

export const SUBAGENT_BUDGET_PCT: Record<string, number> = {
  'claudio-dev': 0.25,
  'general-purpose': 0.2,
  __customDefault: 0.2,
  Explore: 0,
}

const TIER1_BUDGET_PCT = 0.7
const TIER2_BUDGET_PCT = 0.2
const STRUCTURAL_SUMMARY_BYTES = 500
const DEFAULT_BYTES_PER_TOKEN = 4

export type ReadEntry = {
  source: 'Read'
  path: string
  content: string
  mtime: number
  capturedAt: string
  isNew?: boolean
  isNonText?: boolean
  kind?: 'text' | 'image' | 'notebook' | 'pdf'
  isPartial?: boolean
  range?: { startLine: number; endLine: number; totalLines: number }
  reason?: string
  isStale?: boolean
}

export type GrepEntry = {
  source: 'Grep'
  pattern: string
  paths: string[]
  contentExcerpt?: string
  matchSummary: string
  capturedAt: string
}

export type GlobEntry = {
  source: 'Glob'
  pattern: string
  paths: string[]
  matchSummary: string
  capturedAt: string
}

export type DossierEntry = ReadEntry | GrepEntry | GlobEntry

export type Dossier = {
  version: typeof DOSSIER_VERSION
  planSlug: string
  planContent: string
  filesToEdit: string[]
  capturedAt: string
  entries: DossierEntry[]
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: Record<string, unknown>
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  content?: unknown
}

type WalkMessage = {
  type?: string
  message?: { role?: string; content?: unknown }
}

const NOTEBOOK_EXTENSIONS = new Set(['ipynb'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const PDF_EXTENSIONS = new Set(['pdf'])

export function getDossierPath(planSlug: string): string {
  // Derive from getPlanFilePath() so the dossier follows whatever base dir
  // the user has configured (settings.plansDirectory, ~/.claude/plans, etc).
  // We replace the final {slug}.md with {slug}.dossier.json inside the same
  // directory rather than recomputing it — this keeps the two paths in sync.
  const planPath = getPlanFilePath()
  const base = dirname(planPath)
  return join(base, `${planSlug}.dossier.json`)
}

function detectKindFromPath(path: string): ReadEntry['kind'] {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'text'
  const ext = path.slice(dot + 1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (NOTEBOOK_EXTENSIONS.has(ext)) return 'notebook'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  return 'text'
}

function extractTextFromToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: { type?: string; text?: string }) =>
          b?.type === 'text' && typeof b.text === 'string',
      )
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
  }
  return ''
}

function getMessageContent(msg: WalkMessage): unknown {
  return msg.message?.content ?? null
}

function findLatestEnterPlanModeIndex(messages: WalkMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = getMessageContent(messages[i]!)
    if (!Array.isArray(content)) continue
    for (const block of content as ToolUseBlock[]) {
      if (block?.type === 'tool_use' && block.name === ENTER_PLAN_MODE_TOOL_NAME) {
        return i
      }
    }
  }
  return -1
}

function buildToolResultIndex(
  messages: WalkMessage[],
  startIndex: number,
): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>()
  for (let i = startIndex; i < messages.length; i++) {
    const content = getMessageContent(messages[i]!)
    if (!Array.isArray(content)) continue
    for (const block of content as ToolResultBlock[]) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, block)
      }
    }
  }
  return map
}

type ParsedReadResult = {
  content: string
  isPartial?: boolean
  range?: ReadEntry['range']
}

function parseReadToolResult(resultText: string): ParsedReadResult {
  // Read tool prepends `<offset>→` line markers via addLineNumbers.
  // First numbered line tells us the starting line number; we also try to
  // recover totals if a "(file has N total lines)" footer exists.
  const lines = resultText.split('\n')
  let startLine: number | undefined
  let endLine: number | undefined
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)→/)
    if (match) {
      const n = parseInt(match[1]!, 10)
      if (startLine === undefined) startLine = n
      endLine = n
    }
  }
  const totalMatch = resultText.match(/\(file has (\d+) total lines?\)/i)
  const totalLines = totalMatch ? parseInt(totalMatch[1]!, 10) : undefined

  if (
    startLine !== undefined &&
    endLine !== undefined &&
    totalLines !== undefined &&
    (startLine > 1 || endLine < totalLines)
  ) {
    return {
      content: resultText,
      isPartial: true,
      range: { startLine, endLine, totalLines },
    }
  }
  return { content: resultText }
}

async function buildReadEntry(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock | undefined,
  filesToEdit: Set<string>,
  capturedAt: string,
): Promise<ReadEntry | null> {
  const filePath = toolUse.input?.['file_path']
  if (typeof filePath !== 'string' || filePath.length === 0) return null

  const kind = detectKindFromPath(filePath)
  let mtime = 0
  let isNew = false
  try {
    mtime = await getFileModificationTimeAsync(filePath)
  } catch (error) {
    if (isENOENT(error) && filesToEdit.has(filePath)) {
      isNew = true
    } else if (!isENOENT(error)) {
      logError(error)
    }
  }

  if (kind !== 'text') {
    return {
      source: 'Read',
      path: filePath,
      content: '',
      mtime,
      capturedAt,
      kind,
      isNonText: true,
    }
  }

  if (isNew || !toolResult) {
    return {
      source: 'Read',
      path: filePath,
      content: '',
      mtime,
      capturedAt,
      kind: 'text',
      ...(isNew && { isNew: true }),
    }
  }

  const text = extractTextFromToolResult(toolResult.content)
  const parsed = parseReadToolResult(text)
  return {
    source: 'Read',
    path: filePath,
    content: parsed.content,
    mtime,
    capturedAt,
    kind: 'text',
    ...(parsed.isPartial && { isPartial: true, range: parsed.range }),
  }
}

function summarizeGrepResultPaths(text: string, mode: string): string[] {
  if (mode === 'files_with_matches') {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && line.startsWith('/'))
  }
  if (mode === 'content') {
    const seen = new Set<string>()
    for (const line of text.split('\n')) {
      const colon = line.indexOf(':')
      if (colon > 0 && line.startsWith('/')) {
        seen.add(line.slice(0, colon))
      }
    }
    return Array.from(seen)
  }
  return []
}

function buildGrepEntry(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock | undefined,
  capturedAt: string,
): GrepEntry | null {
  const pattern = toolUse.input?.['pattern']
  if (typeof pattern !== 'string') return null
  const mode =
    typeof toolUse.input?.['output_mode'] === 'string'
      ? (toolUse.input!['output_mode'] as string)
      : 'files_with_matches'
  const text = toolResult ? extractTextFromToolResult(toolResult.content) : ''
  const paths = summarizeGrepResultPaths(text, mode)
  const isContentMode = mode === 'content'
  const matchCount = isContentMode
    ? text.split('\n').filter(l => l.length > 0).length
    : paths.length
  const matchSummary = isContentMode
    ? `${matchCount} matches in ${paths.length} files`
    : `${paths.length} files`
  return {
    source: 'Grep',
    pattern,
    paths,
    matchSummary,
    capturedAt,
    ...(isContentMode &&
      text.length > 0 && {
        contentExcerpt: text.slice(0, 1_000),
      }),
  }
}

function buildGlobEntry(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock | undefined,
  capturedAt: string,
): GlobEntry | null {
  const pattern = toolUse.input?.['pattern']
  if (typeof pattern !== 'string') return null
  const text = toolResult ? extractTextFromToolResult(toolResult.content) : ''
  const paths = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && l.startsWith('/'))
  return {
    source: 'Glob',
    pattern,
    paths,
    matchSummary: `${paths.length} paths`,
    capturedAt,
  }
}

export async function buildDossierFromMessages(
  messages: WalkMessage[],
  planContent: string,
  filesToEdit: string[],
  planSlug: string,
): Promise<Dossier> {
  const capturedAt = new Date().toISOString()
  const enterIndex = findLatestEnterPlanModeIndex(messages)
  const startIndex = enterIndex < 0 ? 0 : enterIndex + 1
  const resultsByToolUseId = buildToolResultIndex(messages, startIndex)
  const filesToEditSet = new Set(filesToEdit)

  const reads = new Map<string, ReadEntry>()
  const greps: GrepEntry[] = []
  const globs: GlobEntry[] = []

  for (let i = startIndex; i < messages.length; i++) {
    const content = getMessageContent(messages[i]!)
    if (!Array.isArray(content)) continue
    for (const block of content as ToolUseBlock[]) {
      if (block?.type !== 'tool_use') continue
      const toolResult = block.id ? resultsByToolUseId.get(block.id) : undefined
      if (block.name === FILE_READ_TOOL_NAME) {
        const entry = await buildReadEntry(
          block,
          toolResult,
          filesToEditSet,
          capturedAt,
        )
        if (entry) reads.set(entry.path, entry)
      } else if (block.name === GREP_TOOL_NAME) {
        const entry = buildGrepEntry(block, toolResult, capturedAt)
        if (entry) greps.push(entry)
      } else if (block.name === GLOB_TOOL_NAME) {
        const entry = buildGlobEntry(block, toolResult, capturedAt)
        if (entry) globs.push(entry)
      }
    }
  }

  // filesToEdit can include paths the user/model never opened — surface them
  // so the sub-agent knows about them. isNew check via fs.access.
  for (const path of filesToEdit) {
    if (reads.has(path)) continue
    let mtime = 0
    let isNew = false
    try {
      mtime = await getFileModificationTimeAsync(path)
    } catch (error) {
      if (isENOENT(error)) {
        isNew = true
      } else {
        logError(error)
      }
    }
    reads.set(path, {
      source: 'Read',
      path,
      content: '',
      mtime,
      capturedAt,
      kind: detectKindFromPath(path),
      ...(isNew && { isNew: true }),
    })
  }

  const entries: DossierEntry[] = [...reads.values(), ...greps, ...globs]

  return {
    version: DOSSIER_VERSION,
    planSlug,
    planContent,
    filesToEdit,
    capturedAt,
    entries,
  }
}

export async function serializeDossier(dossier: Dossier): Promise<void> {
  const path = getDossierPath(dossier.planSlug)
  const tmp = `${path}.${randomUUID()}.tmp`
  const payload = JSON.stringify(dossier)
  await writeFile(tmp, payload, 'utf-8')
  await rename(tmp, path)
}

export async function loadDossier(planSlug: string): Promise<Dossier | null> {
  const path = getDossierPath(planSlug)
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (error) {
    if (isENOENT(error)) return null
    logError(error)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logError(error)
    try {
      await unlink(path)
    } catch (deleteError) {
      if (!isENOENT(deleteError)) logError(deleteError)
    }
    return null
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== DOSSIER_VERSION
  ) {
    return null
  }
  return parsed as Dossier
}

export async function deleteDossier(planSlug: string): Promise<void> {
  const path = getDossierPath(planSlug)
  try {
    await unlink(path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
  }
}

const revalidateCache = new Map<string, Promise<Dossier>>()

export function clearRevalidateCache(planSlug?: string): void {
  if (planSlug === undefined) {
    revalidateCache.clear()
    return
  }
  revalidateCache.delete(planSlug)
}

// Per-agent plan slug registry: lets tools running inside a sub-agent find
// the dossier slug that was inherited from the parent. Without this, an
// AgentTool call nested deeper than the top level would re-resolve via
// getPlan()/getPlanSlug() against the child's own session id and miss the
// parent's plan entirely.
const agentPlanSlugRegistry = new Map<string, string>()

export function setAgentPlanSlug(agentId: string, planSlug: string): void {
  agentPlanSlugRegistry.set(agentId, planSlug)
}

export function getAgentPlanSlug(agentId: string): string | undefined {
  return agentPlanSlugRegistry.get(agentId)
}

export function clearAgentPlanSlug(agentId: string): void {
  agentPlanSlugRegistry.delete(agentId)
}

async function revalidateEntry(entry: DossierEntry): Promise<DossierEntry> {
  if (entry.source !== 'Read') return entry
  if (entry.isNew || entry.isNonText) return entry
  try {
    const currentMtime = await stat(entry.path).then(s => Math.floor(s.mtimeMs))
    if (currentMtime > entry.mtime) {
      return { ...entry, isStale: true, content: '' }
    }
    return entry
  } catch (error) {
    if (isENOENT(error)) {
      return { ...entry, isStale: true, content: '' }
    }
    logError(error)
    return entry
  }
}

export function revalidateDossier(dossier: Dossier): Promise<Dossier> {
  const cached = revalidateCache.get(dossier.planSlug)
  if (cached) return cached
  const promise = (async () => {
    const entries = await Promise.all(dossier.entries.map(revalidateEntry))
    return { ...dossier, entries }
  })()
  revalidateCache.set(dossier.planSlug, promise)
  return promise
}

export function dossierBudgetTokens(
  subagentType: string,
  model: string,
): number {
  const explicit = SUBAGENT_BUDGET_PCT[subagentType]
  const fallback = SUBAGENT_BUDGET_PCT.__customDefault!
  const pct = Math.min(explicit ?? fallback, HARD_CAP_PCT)
  return Math.floor(getEffectiveContextWindowSize(model) * pct)
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / DEFAULT_BYTES_PER_TOKEN)
}

function renderReadEntryFull(entry: ReadEntry): string {
  if (entry.isStale) {
    return `[STALE: ${entry.path} — file changed since plan was made. Re-read if needed]`
  }
  if (entry.isNew) {
    return `[NEW FILE: ${entry.path} — to be created]`
  }
  if (entry.isNonText) {
    return `[NON-TEXT: ${entry.path} (${entry.kind ?? 'binary'}) — re-read if you need its bytes]`
  }
  const header = entry.isPartial && entry.range
    ? `--- ${entry.path} (PARTIAL READ: lines ${entry.range.startLine}-${entry.range.endLine} of ${entry.range.totalLines}. Re-read for full file if needed)`
    : `--- ${entry.path}`
  return `${header}\n${entry.content}`
}

function renderEntryReference(entry: DossierEntry): string {
  if (entry.source === 'Read') {
    if (entry.isStale) {
      return `- ${entry.path} (Read, STALE — re-read if needed)`
    }
    if (entry.isNew) return `- ${entry.path} (Read, NEW FILE)`
    if (entry.isNonText) {
      return `- ${entry.path} (Read, ${entry.kind ?? 'non-text'} — re-read if needed)`
    }
    if (entry.isPartial && entry.range) {
      return `- ${entry.path} (Read, partial lines ${entry.range.startLine}-${entry.range.endLine} of ${entry.range.totalLines})`
    }
    return `- ${entry.path} (Read${entry.reason ? `: ${entry.reason}` : ''})`
  }
  if (entry.source === 'Grep') {
    return `- Grep "${entry.pattern}" → ${entry.matchSummary}`
  }
  return `- Glob "${entry.pattern}" → ${entry.matchSummary}`
}

function buildStructuralSummary(entry: ReadEntry): string {
  // Best-effort: keep the first ~25 non-blank lines as a structural sketch.
  // This preserves imports + top-level signatures without burning tokens on
  // bodies. Cap by STRUCTURAL_SUMMARY_BYTES to stay predictable.
  const lines = entry.content.split('\n')
  const sketch: string[] = []
  let bytes = 0
  for (const line of lines) {
    if (line.trim().length === 0) continue
    bytes += line.length + 1
    if (bytes > STRUCTURAL_SUMMARY_BYTES) break
    sketch.push(line)
  }
  return `--- ${entry.path} (structural summary — body elided)\n${sketch.join('\n')}\n[…body omitted to fit budget]`
}

type RenderedTier1 = {
  rendered: string[]
  used: number
  truncated: ReadEntry[]
}

function renderTier1(
  willEdit: ReadEntry[],
  budgetChars: number,
): RenderedTier1 {
  const lightweight = willEdit.filter(
    e => e.isStale || e.isNew || e.isNonText,
  )
  const heavy = willEdit
    .filter(e => !e.isStale && !e.isNew && !e.isNonText)
    .sort((a, b) => a.content.length - b.content.length)

  const rendered: string[] = []
  let used = 0

  for (const entry of lightweight) {
    const block = renderReadEntryFull(entry)
    rendered.push(block)
    used += block.length + 1
  }

  const remaining: ReadEntry[] = []
  for (const entry of heavy) {
    const block = renderReadEntryFull(entry)
    if (used + block.length + 1 <= budgetChars) {
      rendered.push(block)
      used += block.length + 1
    } else {
      remaining.push(entry)
    }
  }

  // Tier 3 degrade: replace the largest remaining with structural summary
  // until we either fit or run out of entries to degrade.
  const degraded: ReadEntry[] = remaining.sort(
    (a, b) => b.content.length - a.content.length,
  )
  const truncated: ReadEntry[] = []
  for (const entry of degraded) {
    const summary = buildStructuralSummary(entry)
    if (used + summary.length + 1 <= budgetChars) {
      rendered.push(summary)
      used += summary.length + 1
    } else {
      truncated.push(entry)
    }
  }

  return { rendered, used, truncated }
}

export type RenderResult = {
  text: string
  tokensInjected: number
  truncatedPaths: string[]
}

export function renderDossierForSubagent(
  dossier: Dossier,
  subagentType: string,
  model: string,
): RenderResult | null {
  if (subagentType === 'Explore') return null
  const budgetTokens = dossierBudgetTokens(subagentType, model)
  if (budgetTokens <= 0) return null

  const budgetChars = budgetTokens * DEFAULT_BYTES_PER_TOKEN
  const willEditSet = new Set(dossier.filesToEdit)

  const willEditEntries = dossier.entries.filter(
    (e): e is ReadEntry => e.source === 'Read' && willEditSet.has(e.path),
  )
  const otherReads = dossier.entries.filter(
    (e): e is ReadEntry => e.source === 'Read' && !willEditSet.has(e.path),
  )
  const greps = dossier.entries.filter(
    (e): e is GrepEntry => e.source === 'Grep',
  )
  const globs = dossier.entries.filter(
    (e): e is GlobEntry => e.source === 'Glob',
  )

  const tier1Budget = Math.floor(budgetChars * TIER1_BUDGET_PCT)
  const tier2Budget = Math.floor(budgetChars * TIER2_BUDGET_PCT)

  const tier1 = renderTier1(willEditEntries, tier1Budget)

  const tier2Lines: string[] = []
  let tier2Used = 0
  const tier2Candidates: DossierEntry[] = [...otherReads, ...greps, ...globs]
  for (const entry of tier2Candidates) {
    const line = renderEntryReference(entry)
    const cost = line.length + 1
    if (tier2Used + cost > tier2Budget) break
    tier2Lines.push(line)
    tier2Used += cost
  }

  const filesToEditList = dossier.filesToEdit.length > 0
    ? dossier.filesToEdit.join(', ')
    : '(none)'
  const referencePaths = otherReads.map(e => e.path).join(', ') || '(none)'

  const truncatedPaths = tier1.truncated.map(e => e.path)
  const truncationWarning = truncatedPaths.length > 0
    ? `\n[dossier truncated: ${truncatedPaths.length} willEdit file(s) over budget — sub-agent may need to re-read: ${truncatedPaths.join(', ')}]`
    : ''

  const tier1Text = tier1.rendered.join('\n')
  const tier2Text = tier2Lines.length > 0
    ? `\n--- Other explored files & searches ---\n${tier2Lines.join('\n')}`
    : ''

  const text = `<plan-dossier>
The user accepted a plan after exploration. Files explored during planning are
attached below. Trust their content unless you have reason to suspect changes.
Do NOT call Read/Grep/Glob redundantly on these paths.

If a file is marked STALE, it changed since the plan was made — re-read it.

Files to edit (full content provided): ${filesToEditList}
Other explored files (reference only): ${referencePaths}

Plan:
${dossier.planContent}

--- Dossier entries ---
${tier1Text}${tier2Text}${truncationWarning}
</plan-dossier>`

  return {
    text,
    tokensInjected: approxTokens(text),
    truncatedPaths,
  }
}
