/**
 * Measure how often a model spends a whole round-trip on a no-op shell command.
 *
 * Sonnet 5 uses `Bash({"command":"true","description":"noop"})` as a THINKING
 * CONTINUATION: it reads a tool result, thinks, calls the no-op, gets
 * "(No output)", thinks again, and only then issues the real Grep/Glob. The
 * no-op does nothing — but it costs a full model round-trip that re-reads the
 * whole context, so its price is the `cache_read_input_tokens` of the message
 * that carried it.
 *
 * Nothing in Claudin injects it. Every cheaper alternative is closed by the
 * prompt: text between tool calls is out (ANTI_NARRATION), and in plan mode
 * ending the turn is out too — so a tool call is the only legal emission and
 * `true` is the cheapest one.
 *
 * The three numbers it reports:
 *
 *   1. no-ops per 100 tool turns, per model   ← the rate a prompt change moves
 *   2. cache-read tokens burned on no-op turns ← what it costs
 *   3. the plan-mode split                     ← where the rate concentrates
 *
 * Baseline (2026-08-19, all projects): 33 no-ops over 14 sessions, ALL of them
 * `claude-sonnet-5`, zero on Opus. Worst session `8c8f00d6…` (legendarr): 9
 * no-ops in 186 tool turns, 1.03M cache-read tokens.
 *
 * Running it after a change:
 *
 *   bun scripts/bench/tokens/measure-noop-tool-calls.ts
 *   bun scripts/bench/tokens/measure-noop-tool-calls.ts --project=-home-viudes-projects-legendarr
 *
 * Flags:
 *   --project=<name|path>  one transcript project dir (name under projects/, or
 *                          an absolute path). Defaults to ALL of them.
 *   --model=<substring>    only count messages whose model matches
 *   --json                 machine-readable output
 *
 * Read-only. No network. No filesystem writes.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { isAbsolute, join } from 'path'
import {
  readConfigDirEnv,
  resolveClaudinConfigHomeDir,
} from '../../../src/shared/envUtils.js'

/**
 * A command that does nothing at all: bash's `true` and `:` builtins, with an
 * optional trailing comment. `true && ls` is NOT one — the model asked for real
 * work there, and counting it would inflate the rate this script exists to move.
 */
const NOOP_COMMAND_RE = /^\s*(?:true|:)\s*(?:#.*)?$/
const JSONL_SUFFIX_RE = /\.jsonl$/
const EXIT_PLAN_MODE_RE = /^ExitPlanMode/

const ENTER_PLAN_MODE_TOOL = 'EnterPlanMode'
const BASH_TOOL_NAMES = new Set(['Bash', 'BashTool'])

export function isNoopCommand(command: string): boolean {
  return NOOP_COMMAND_RE.test(command)
}

type ContentBlock = {
  type?: string
  name?: string
  input?: Record<string, unknown>
}

type Usage = {
  cache_read_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

export type TranscriptLine = {
  type?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  /**
   * Set on USER entries by the CLI. This is the reliable mode signal: the
   * plan-mode reminder itself never reaches the transcript (attachments are
   * stripped — see .claudin/rules/testing.md), so sniffing its text
   * under-counts. It is not sufficient either: entering plan mode by keybinding
   * is invisible until the NEXT user message, which is why the EnterPlanMode /
   * ExitPlanMode tool calls are tracked alongside it.
   */
  permissionMode?: string
  message?: {
    id?: string
    model?: string
    content?: unknown
    usage?: Usage
  }
}

export type SessionTally = {
  sessionId: string
  /** The model that issued the no-ops, or the session's last assistant model. */
  model: string
  noops: number
  /** Distinct assistant messages carrying at least one tool_use. */
  toolTurns: number
  /** `cache_read_input_tokens` summed over the messages that carried a no-op. */
  cacheReadWasted: number
  /** Thinking tokens on those same messages — what the round-trip bought. */
  thinkingOnNoops: number
  /** No-ops issued while plan mode was active. */
  planNoops: number
}

export type ModelTally = {
  model: string
  noops: number
  toolTurns: number
  sessions: number
  cacheReadWasted: number
  thinkingOnNoops: number
  planNoops: number
}

export type NoopCensus = {
  projectDirs: number
  sessionsScanned: number
  malformedLines: number
  byModel: ModelTally[]
  worstSessions: SessionTally[]
  totals: ModelTally
}

function blocksOf(message: TranscriptLine['message']): ContentBlock[] {
  const content = message?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/** Counts lines that were not valid JSON, rather than swallowing them. */
export type ParseTally = { malformed: number }

export function parseLines(raw: string, tally: ParseTally): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as TranscriptLine)
    } catch {
      // A truncated final line is normal for a live session; a burst of them
      // is not. Counted and reported instead of ignored.
      tally.malformed++
    }
  }
  return out
}

/**
 * Walk one session's transcript.
 *
 * A single assistant message can be split across several jsonl lines (thinking
 * on one, the tool_use on the next) under the same `message.id`, so both the
 * tool-turn count and the wasted-cache sum are keyed by message id — counting
 * lines would double-charge every message that streamed a thinking block.
 */
export function tallySession(
  sessionId: string,
  lines: readonly TranscriptLine[],
  modelFilter: string | null,
): SessionTally | null {
  const toolTurnIds = new Set<string>()
  const noopMessageIds = new Set<string>()
  let noops = 0
  let planNoops = 0
  let cacheReadWasted = 0
  let thinkingOnNoops = 0
  let noopModel: string | null = null
  let lastAssistantModel: string | null = null

  // Mode carried forward from the last user entry, overridden by the plan-mode
  // tool calls (see the comment on TranscriptLine.permissionMode).
  let userMode = 'default'
  let inPlanMode = false

  for (const line of lines) {
    if (line.isSidechain === true) continue

    if (line.type === 'user') {
      const mode = line.permissionMode
      if (typeof mode === 'string' && mode.length > 0) {
        userMode = mode
        inPlanMode = mode === 'plan'
      }
      continue
    }
    if (line.type !== 'assistant') continue

    const model = line.message?.model
    if (typeof model === 'string' && model.length > 0) lastAssistantModel = model
    if (modelFilter !== null && (model === undefined || !model.includes(modelFilter))) {
      continue
    }

    const messageId = line.message?.id ?? line.uuid ?? ''
    const blocks = blocksOf(line.message)
    let messageHasTool = false
    let messageHasNoop = false

    for (const block of blocks) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      messageHasTool = true

      if (block.name === ENTER_PLAN_MODE_TOOL) inPlanMode = true
      else if (EXIT_PLAN_MODE_RE.test(block.name)) inPlanMode = userMode === 'plan'

      if (!BASH_TOOL_NAMES.has(block.name)) continue
      const command = block.input?.['command']
      if (typeof command !== 'string' || !isNoopCommand(command)) continue

      noops++
      if (inPlanMode) planNoops++
      messageHasNoop = true
      if (noopModel === null && typeof model === 'string') noopModel = model
    }

    if (messageHasTool && messageId.length > 0) toolTurnIds.add(messageId)
    if (messageHasNoop && !noopMessageIds.has(messageId)) {
      noopMessageIds.add(messageId)
      const usage = line.message?.usage
      cacheReadWasted += usage?.cache_read_input_tokens ?? 0
      thinkingOnNoops += usage?.output_tokens_details?.thinking_tokens ?? 0
    }
  }

  const model = noopModel ?? lastAssistantModel
  if (model === null) return null
  return {
    sessionId,
    model,
    noops,
    toolTurns: toolTurnIds.size,
    cacheReadWasted,
    thinkingOnNoops,
    planNoops,
  }
}

export function aggregate(tallies: readonly SessionTally[]): NoopCensus['byModel'] {
  const byModel = new Map<string, ModelTally>()
  for (const tally of tallies) {
    const row = byModel.get(tally.model) ?? {
      model: tally.model,
      noops: 0,
      toolTurns: 0,
      sessions: 0,
      cacheReadWasted: 0,
      thinkingOnNoops: 0,
      planNoops: 0,
    }
    row.noops += tally.noops
    row.toolTurns += tally.toolTurns
    row.sessions += 1
    row.cacheReadWasted += tally.cacheReadWasted
    row.thinkingOnNoops += tally.thinkingOnNoops
    row.planNoops += tally.planNoops
    byModel.set(tally.model, row)
  }
  return [...byModel.values()].sort((a, b) => b.noops - a.noops)
}

function rate(noops: number, toolTurns: number): string {
  if (toolTurns === 0) return 'n/a'
  return ((noops * 100) / toolTurns).toFixed(2)
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
    throw error
  }
}

function listDirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

function projectsRoot(): string {
  const configHome = resolveClaudinConfigHomeDir({
    configDirEnv: readConfigDirEnv(),
  })
  return join(configHome, 'projects')
}

export function measureNoopToolCalls(options: {
  projectDirs: readonly string[]
  modelFilter: string | null
}): NoopCensus {
  const { projectDirs, modelFilter } = options
  const tally: ParseTally = { malformed: 0 }
  const sessions: SessionTally[] = []

  for (const projectDir of projectDirs) {
    for (const entry of listDirOrEmpty(projectDir)) {
      if (!entry.endsWith('.jsonl')) continue
      const raw = readFileOrNull(join(projectDir, entry))
      if (raw === null) continue
      const sessionTally = tallySession(
        entry.replace(JSONL_SUFFIX_RE, ''),
        parseLines(raw, tally),
        modelFilter,
      )
      if (sessionTally !== null) sessions.push(sessionTally)
    }
  }

  const byModel = aggregate(sessions)
  const totals: ModelTally = {
    model: '(all)',
    noops: byModel.reduce((a, m) => a + m.noops, 0),
    toolTurns: byModel.reduce((a, m) => a + m.toolTurns, 0),
    sessions: byModel.reduce((a, m) => a + m.sessions, 0),
    cacheReadWasted: byModel.reduce((a, m) => a + m.cacheReadWasted, 0),
    thinkingOnNoops: byModel.reduce((a, m) => a + m.thinkingOnNoops, 0),
    planNoops: byModel.reduce((a, m) => a + m.planNoops, 0),
  }

  return {
    projectDirs: projectDirs.length,
    sessionsScanned: sessions.length,
    malformedLines: tally.malformed,
    byModel,
    worstSessions: sessions
      .filter(s => s.noops > 0)
      .sort((a, b) => b.noops - a.noops)
      .slice(0, 10),
    totals,
  }
}

export function formatReport(census: NoopCensus): string {
  const lines: string[] = []
  lines.push('# No-op tool calls (Bash `true` / `:`)')
  lines.push(
    `corpus : ${census.sessionsScanned} sessions over ${census.projectDirs} project dir(s)`,
  )
  if (census.malformedLines > 0) {
    lines.push(`note   : ${census.malformedLines} unparseable transcript line(s) skipped`)
  }
  lines.push('')

  lines.push('## Per model')
  lines.push('  no-ops  /100 turns  tool turns   plan-mode   cache-read burned  model')
  const rows = census.byModel.filter(m => m.noops > 0)
  if (rows.length === 0) lines.push('  (no no-op calls found)')
  for (const row of rows) {
    lines.push(
      `  ${String(row.noops).padStart(6)}  ${rate(row.noops, row.toolTurns).padStart(10)}  ` +
        `${String(row.toolTurns).padStart(10)}  ${String(row.planNoops).padStart(9)}  ` +
        `${String(row.cacheReadWasted).padStart(17)}  ${row.model}`,
    )
  }
  // Named, not hidden: the totals denominator below covers these too, so a
  // reader comparing the two would otherwise see numbers that do not add up.
  const clean = census.byModel.filter(m => m.noops === 0)
  if (clean.length > 0) {
    lines.push(
      `  (${clean.length} model(s) with ZERO no-ops over ` +
        `${clean.reduce((a, m) => a + m.toolTurns, 0)} tool turns: ` +
        `${clean.map(m => m.model).join(', ')})`,
    )
  }
  lines.push('')

  lines.push('## Worst sessions')
  if (census.worstSessions.length === 0) lines.push('  (none)')
  for (const session of census.worstSessions) {
    lines.push(
      `  ${session.sessionId.slice(0, 8)}  ${String(session.noops).padStart(3)} no-ops in ` +
        `${String(session.toolTurns).padStart(4)} tool turns ` +
        `(${rate(session.noops, session.toolTurns)}/100, ${session.planNoops} in plan mode, ` +
        `${session.cacheReadWasted} cache-read)  ${session.model}`,
    )
  }
  lines.push('')

  const { totals } = census
  lines.push('## Totals')
  lines.push(
    `  ${totals.noops} no-ops in ${totals.toolTurns} tool turns = ${rate(totals.noops, totals.toolTurns)} per 100 turns`,
  )
  lines.push(
    `  ${totals.planNoops} of them in plan mode; ${totals.cacheReadWasted} cache-read tokens burned, ` +
      `${totals.thinkingOnNoops} thinking tokens bought`,
  )
  lines.push('  baseline 2026-08-19: 33 no-ops, all claude-sonnet-5  ← lower is better')
  return lines.join('\n')
}

function resolveProjectDirs(project: string | null): string[] {
  const root = projectsRoot()
  if (project !== null) {
    return [isAbsolute(project) ? project : join(root, project)]
  }
  return listDirOrEmpty(root)
    .map(entry => join(root, entry))
    .filter(path => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true)
}

export function parseArgs(argv: readonly string[]): {
  project: string | null
  modelFilter: string | null
  asJson: boolean
} {
  let project: string | null = null
  let modelFilter: string | null = null
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length)
    else if (arg.startsWith('--model=')) modelFilter = arg.slice('--model='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { project, modelFilter, asJson }
}

function main(): void {
  const argvRaw = process.argv.slice(2)
  // Allow the space-separated forms `--project X` / `--model Y` too.
  const argv: string[] = []
  for (let i = 0; i < argvRaw.length; i++) {
    const arg = argvRaw[i]!
    if ((arg === '--project' || arg === '--model') && argvRaw[i + 1] !== undefined) {
      argv.push(`${arg}=${argvRaw[++i]}`)
    } else {
      argv.push(arg)
    }
  }

  const { project, modelFilter, asJson } = parseArgs(argv)
  const projectDirs = resolveProjectDirs(project)
  if (projectDirs.length === 0) {
    throw new Error(`no transcript project dirs under ${projectsRoot()}`)
  }

  const census = measureNoopToolCalls({ projectDirs, modelFilter })
  if (asJson) {
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatReport(census)}\n`)
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
