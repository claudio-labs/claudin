/**
 * What `tool-gaps-ab.ts` counts in each session besides cost: one counter per
 * lever of the 10-30 census branch, read off the main transcript and its
 * sub-agents' transcripts. Each counter is what that lever's gate needs.
 *
 * - Tasks (CLAUDIN_PLAN_TASK_IDS): after the plan is approved, how many
 *   ToolSearch calls loaded a Task tool, how many TaskList calls came before
 *   the first TaskUpdate, and how TaskUpdate calls made without a load fared.
 * - Outline (CLAUDIN_OUTLINE_PROSE_BY_LINES): docs Read pivoted to an outline,
 *   and how many of those were read again for their body.
 * - Processes (CLAUDIN_ADOPT_LEFTOVERS): Bash calls that manage processes by
 *   hand, TaskStop calls, results that say a process was adopted. The leak
 *   count comes from the harness, which looks after the session ends.
 * - Diff (the pivot-wording fix): pivoted diffs, ones whose text names the Git
 *   tool to a Bash reader, and `| cat` / `--no-pager` re-runs after a pivot.
 * - The Bash file-tools note (CLAUDIN_DISABLE_TOOL_REDIRECT in the combo arm):
 *   how often it fired and how often the next call took the tool it named,
 *   and the share of reads and searches made with Read/Grep/Glob.
 */

type Json = Record<string, unknown>

export type ThreadCall = { name: string; input: Json; text: string; isError: boolean }

export type Mechanisms = {
  taskToolSearchAfterPlan: number
  /** Diagnostic: those of them that loaded nothing but task-tracking tools. */
  taskOnlyToolSearchAfterPlan: number
  taskListBeforeFirstUpdate: number
  taskUpdates: number
  taskUpdateUnloadedOk: number
  taskUpdateUnloadedErr: number
  docsOutlined: number
  docsOutlineThenBody: number
  processBash: number
  taskStops: number
  adoptedNotes: number
  diffPivots: number
  diffPivotsNamingGitToBash: number
  diffCatReruns: number
  fileToolsNotes: number
  fileToolsNotesFollowed: number
  dedicatedReads: number
  bashReads: number
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('')
}

/** One thread's tool calls in order, each with its result text. */
export function threadCalls(records: readonly Json[]): ThreadCall[] {
  const calls: ThreadCall[] = []
  const byId = new Map<string, ThreadCall>()
  for (const record of records) {
    const message = record.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_use' && typeof block.id === 'string' && !byId.has(block.id)) {
        const call = { name: String(block.name), input: isRecord(block.input) ? block.input : {}, text: '', isError: false }
        byId.set(block.id, call)
        calls.push(call)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = byId.get(block.tool_use_id)
        if (!call) continue
        call.text = textOf(block.content)
        call.isError = block.is_error === true
      }
    }
  }
  return calls
}

const TASK_TOOL_RE = /\bTask(?:Update|List|Get|Create)\b/
const SELECT_RE = /^select:(.+)$/
const AUTO_OUTLINE_RE = /is large — showing a structural outline/
const NUMBERED_RE = /^\s*\d+→/m
const PROCESS_RE = /(?:^|[\s;&|(])(?:kill|pkill|pgrep|killall|fuser|lsof)\b|\bps\s+-|\bss\s+-\w*[lp]/
const PIVOT_RE = /hunks omitted|more hunks? \(\d+ lines\)/
const GIT_TOOL_HINT_RE = /Git\(\{commands/
const DIFF_RERUN_RE = /\bgit\b[^|\n]*\bdiff\b[^\n]*\|\s*cat\b|\bgit\s+--no-pager\s+diff\b/
const FILE_TOOLS_NOTE_RE = /This command only reads or searches files, and ([\w/]+) do(?:es)? that without the shell/
const BASH_READ_RE = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:cat|sed\s+-n|head|tail|grep|egrep|rg|find|ls|wc|nl)\b/
const DOCS_RE = /(?:^|\/)docs\/[^/]+\.md$/

function readPath(call: ThreadCall): string | null {
  const path = call.input.file_path
  return typeof path === 'string' ? path : null
}

function countThread(calls: readonly ThreadCall[], into: Mechanisms, isMain: boolean): void {
  const planAt = isMain ? calls.findIndex(c => c.name === 'ExitPlanMode' && !c.isError && /approved your plan/.test(c.text)) : -1
  let loaded = false
  let updated = false
  const outlined = new Set<string>()
  let pivotSeen = false
  calls.forEach((call, i) => {
    const command = typeof call.input.command === 'string' ? call.input.command : ''
    if (planAt >= 0 && i > planAt) {
      if (call.name === 'ToolSearch' && TASK_TOOL_RE.test(JSON.stringify(call.input))) {
        into.taskToolSearchAfterPlan++
        const names = SELECT_RE.exec(String(call.input.query ?? ''))?.[1]?.split(',').map(n => n.trim())
        if (names && names.every(n => TASK_TOOL_RE.test(n))) into.taskOnlyToolSearchAfterPlan++
        loaded = true
      }
      if (call.name === 'TaskList' && !updated) into.taskListBeforeFirstUpdate++
      if (call.name === 'TaskUpdate') {
        into.taskUpdates++
        if (!loaded && !updated) {
          if (call.isError) into.taskUpdateUnloadedErr++
          else into.taskUpdateUnloadedOk++
        }
        if (!call.isError) updated = true
      }
    }
    if (call.name === 'Read') {
      const path = readPath(call)
      if (path && DOCS_RE.test(path)) {
        if (AUTO_OUTLINE_RE.test(call.text)) {
          if (!outlined.has(path)) into.docsOutlined++
          outlined.add(path)
        } else if (outlined.has(path) && NUMBERED_RE.test(call.text)) {
          into.docsOutlineThenBody++
          outlined.delete(path)
        }
      }
    }
    if (call.name === 'Bash' && PROCESS_RE.test(command)) into.processBash++
    if (call.name === 'TaskStop') into.taskStops++
    if (call.name === 'Bash' && /adopted as task/.test(call.text)) into.adoptedNotes++
    if ((call.name === 'Bash' || call.name === 'Git') && PIVOT_RE.test(call.text)) {
      into.diffPivots++
      if (call.name === 'Bash' && GIT_TOOL_HINT_RE.test(call.text)) into.diffPivotsNamingGitToBash++
      pivotSeen = true
    } else if (pivotSeen && call.name === 'Bash' && DIFF_RERUN_RE.test(command)) into.diffCatReruns++
    const note = call.name === 'Bash' ? FILE_TOOLS_NOTE_RE.exec(call.text) : null
    if (note) {
      into.fileToolsNotes++
      const named = note[1]!.split('/')
      if (calls[i + 1] && named.includes(calls[i + 1]!.name)) into.fileToolsNotesFollowed++
    }
    if (call.name === 'Read' || call.name === 'Grep' || call.name === 'Glob') into.dedicatedReads++
    else if (call.name === 'Bash' && BASH_READ_RE.test(command)) into.bashReads++
  })
}

export function emptyMechanisms(): Mechanisms {
  return {
    taskToolSearchAfterPlan: 0,
    taskOnlyToolSearchAfterPlan: 0,
    taskListBeforeFirstUpdate: 0,
    taskUpdates: 0,
    taskUpdateUnloadedOk: 0,
    taskUpdateUnloadedErr: 0,
    docsOutlined: 0,
    docsOutlineThenBody: 0,
    processBash: 0,
    taskStops: 0,
    adoptedNotes: 0,
    diffPivots: 0,
    diffPivotsNamingGitToBash: 0,
    diffCatReruns: 0,
    fileToolsNotes: 0,
    fileToolsNotesFollowed: 0,
    dedicatedReads: 0,
    bashReads: 0,
  }
}

/** The counters of one session: its main thread and every sub-agent thread. */
export function mechanismsOf(main: readonly Json[], subagents: readonly (readonly Json[])[]): Mechanisms {
  const out = emptyMechanisms()
  countThread(threadCalls(main), out, true)
  for (const thread of subagents) countThread(threadCalls(thread), out, false)
  return out
}

/** Read/Grep/Glob over every read or search, in percent; NaN with none. */
export function dedicatedReadShare(m: Mechanisms): number {
  const all = m.dedicatedReads + m.bashReads
  return all === 0 ? Number.NaN : (100 * m.dedicatedReads) / all
}
