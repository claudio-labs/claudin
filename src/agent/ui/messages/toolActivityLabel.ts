// The spinner's verb while tools run: what the agent is doing, in at most
// three words — "Editing Spinner.tsx", "Searching useBlink", "Running bun
// test" — in place of the random verb. Read off the calls' own input, so it
// costs no request and changes as the calls do. Mirrors toolRowIcons.ts: one
// entry per tool, MCP tools share one, anything else gets a generic one.
//
// Not Tool.getActivityDescription: that is a progress line's sentence
// ("Running <the command's description>"), so it can't promise three words,
// and cutting it to three drops the object. Here each tool names its object
// the short way: the file's name, the command's program and subcommand.

import path from 'node:path'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import {
  LIST_WORKFLOWS_TOOL_NAME,
  WORKFLOW_RUN_TOOL_NAME,
  WORKFLOW_STATUS_TOOL_NAME,
} from 'src/tools/AgentWorkflow/constants.js'
import { APPLY_PATCH_TOOL_NAME, LEGACY_APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'
import { CONTAINER_TOOL_NAME } from 'src/tools/ContainerTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from 'src/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { LIST_AGENTS_TOOL_NAME } from 'src/tools/ListAgentsTool/constants.js'
import { LSP_TOOL_NAME } from 'src/tools/LSPTool/prompt.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import { RENAME_TOOL_NAME } from 'src/tools/RenameTool/prompt.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from 'src/tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from 'src/tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from 'src/tools/TaskListTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from 'src/tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from 'src/tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from 'src/tools/TaskUpdateTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from 'src/tools/TodoWriteTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/constants.js'
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'

const MAX_WORDS = 3
// A path, pattern or name longer than this is cut, so the label stays short
// even when its one word is a 200-character regex.
const MAX_OBJECT_CHARS = 28

export type ToolCall = { name: string; input: unknown }
type Input = Record<string, unknown>

type Activity = {
  verb: string
  // Plural noun for several calls of this tool at once ("Reading 3 files").
  noun?: string
  object?: (input: Input) => string | undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function fileName(value: unknown): string | undefined {
  const file = text(value)
  return file && path.basename(file)
}

function fileCount(files: unknown): string | undefined {
  return Array.isArray(files) && files.length > 0
    ? files.length === 1
      ? fileName(files[0])
      : `${files.length} files`
    : undefined
}

// A Patch names its files in `*** Add|Update|Delete File: <path>` headers.
function patchFiles(patchText: unknown): string | undefined {
  const files = [
    ...(text(patchText) ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
  ].map(match => match[1]!)
  return fileCount(files)
}

// The program a command runs and its subcommand — "bun test", "git status" —
// from the first link of a chain that is not a `cd`, past VAR=value
// prefixes. A runner's `run`/`exec` gives way to what it runs.
function commandHead(command: unknown): string | undefined {
  const segments = (text(command) ?? '')
    .split(/&&|\|\||;|\|/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const segment = segments.find(s => !/^cd(\s|$)/.test(s)) ?? segments[0]
  const tokens = (segment ?? '').split(/\s+/).filter(token => !/^\w+=/.test(token))
  if (!tokens[0]) return undefined
  const program = path.basename(tokens[0])
  const isWord = (token: string | undefined) => token !== undefined && /^[a-z][\w:-]*$/i.test(token)
  const sub = ['run', 'exec'].includes(tokens[1] ?? '') && isWord(tokens[2]) ? tokens[2] : tokens[1]
  return isWord(sub) ? `${program} ${sub}` : program
}

function host(url: unknown): string | undefined {
  try {
    return new URL(text(url) ?? '').hostname || undefined
  } catch {
    return undefined
  }
}

const FILES = 'files'
const reading: Activity = { verb: 'Reading', noun: FILES, object: i => fileName(i.file_path) ?? fileCount(i.file_paths) }
const editing: Activity = { verb: 'Editing', noun: FILES, object: i => fileName(i.file_path) }
const patching: Activity = { verb: 'Editing', noun: FILES, object: i => patchFiles(i.patchText) }
const running: Activity = { verb: 'Running', noun: 'commands', object: i => commandHead(i.command) }
const delegating: Activity = {
  verb: 'Delegating',
  noun: 'agents',
  object: i => (text(i.subagent_type) ? `to ${text(i.subagent_type)}` : 'task'),
}
const updatingTasks: Activity = { verb: 'Updating', object: () => 'tasks' }
const waiting: Activity = { verb: 'Waiting' }
const planning: Activity = { verb: 'Planning' }
const workflow: Activity = { verb: 'Running', object: () => 'workflow' }

const ACTIVITIES: Record<string, Activity> = {
  [FILE_READ_TOOL_NAME]: reading,
  [FILE_EDIT_TOOL_NAME]: editing,
  [APPLY_PATCH_TOOL_NAME]: patching,
  [LEGACY_APPLY_PATCH_TOOL_NAME]: patching,
  [NOTEBOOK_EDIT_TOOL_NAME]: { verb: 'Editing', noun: 'notebooks', object: i => fileName(i.notebook_path) },
  [FILE_WRITE_TOOL_NAME]: { verb: 'Writing', noun: FILES, object: i => fileName(i.file_path) },
  [GREP_TOOL_NAME]: { verb: 'Searching', noun: 'patterns', object: i => text(i.pattern) },
  [GLOB_TOOL_NAME]: { verb: 'Finding', noun: 'patterns', object: i => text(i.pattern) },
  [BASH_TOOL_NAME]: running,
  [POWERSHELL_TOOL_NAME]: running,
  [GIT_TOOL_NAME]: {
    verb: 'Running',
    noun: 'commands',
    object: i => (Array.isArray(i.commands) ? commandHead(i.commands[0]) : undefined),
  },
  [WEB_FETCH_TOOL_NAME]: { verb: 'Fetching', noun: 'pages', object: i => host(i.url) },
  [WEB_SEARCH_TOOL_NAME]: { verb: 'Searching', object: () => 'web' },
  [AGENT_TOOL_NAME]: delegating,
  [LEGACY_AGENT_TOOL_NAME]: delegating,
  [SEND_MESSAGE_TOOL_NAME]: { verb: 'Messaging', object: i => text(i.to) },
  [LIST_AGENTS_TOOL_NAME]: { verb: 'Listing', object: () => 'agents' },
  [RUN_TESTS_TOOL_NAME]: { verb: 'Running', object: () => 'tests' },
  [TYPECHECK_TOOL_NAME]: { verb: 'Typechecking' },
  [BUILD_TOOL_NAME]: { verb: 'Building' },
  [CONTAINER_TOOL_NAME]: { verb: 'Running', object: () => 'container' },
  [SKILL_TOOL_NAME]: { verb: 'Running', object: i => text(i.skill) },
  [TASK_CREATE_TOOL_NAME]: updatingTasks,
  [TASK_UPDATE_TOOL_NAME]: updatingTasks,
  [TASK_GET_TOOL_NAME]: updatingTasks,
  [TASK_LIST_TOOL_NAME]: updatingTasks,
  [TASK_STOP_TOOL_NAME]: updatingTasks,
  [TASK_OUTPUT_TOOL_NAME]: updatingTasks,
  [TODO_WRITE_TOOL_NAME]: updatingTasks,
  [WAITFOR_TOOL_NAME]: waiting,
  [MONITOR_TOOL_NAME]: waiting,
  [ASK_USER_QUESTION_TOOL_NAME]: { verb: 'Asking', object: () => 'you' },
  [ENTER_PLAN_MODE_TOOL_NAME]: planning,
  [EXIT_PLAN_MODE_TOOL_NAME]: planning,
  [LSP_TOOL_NAME]: { verb: 'Querying', object: () => 'LSP' },
  [RENAME_TOOL_NAME]: { verb: 'Renaming', object: i => text(i.symbol) },
  [TOOL_SEARCH_TOOL_NAME]: { verb: 'Loading', object: () => 'tools' },
  [WORKFLOW_RUN_TOOL_NAME]: workflow,
  [LIST_WORKFLOWS_TOOL_NAME]: workflow,
  [WORKFLOW_STATUS_TOOL_NAME]: workflow,
}

function activityOf(name: string): Activity {
  // mcp__<server>__<tool>: the server is what the user knows the call by.
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1]
    return { verb: 'Calling', object: () => server || 'MCP' }
  }
  return ACTIVITIES[name] ?? { verb: 'Running', object: () => name }
}

function clip(object: string): string {
  return object.length > MAX_OBJECT_CHARS ? `${object.slice(0, MAX_OBJECT_CHARS - 1)}…` : object
}

function cap(label: string): string {
  return label.split(/\s+/).slice(0, MAX_WORDS).join(' ')
}

/** One call in at most three words. With no input yet (a call still
 *  streaming in) it is the verb alone. */
export function describeToolCall({ name, input }: ToolCall): string {
  const activity = activityOf(name)
  const object = input !== null && typeof input === 'object' ? activity.object?.(input as Input) : undefined
  return cap(object ? `${activity.verb} ${clip(object)}` : activity.verb)
}

/** Several calls at once: counted when they are the same kind of work
 *  ("Reading 3 files"), otherwise just counted ("Running 3 tools"). */
export function describeToolCalls(calls: readonly ToolCall[]): string | undefined {
  if (calls.length === 0) return undefined
  if (calls.length === 1) return describeToolCall(calls[0]!)
  const activities = calls.map(call => activityOf(call.name))
  const [first] = activities
  const alike = activities.every(a => a.verb === first!.verb && a.noun === first!.noun)
  return alike && first!.noun ? `${first!.verb} ${calls.length} ${first!.noun}` : `Running ${calls.length} tools`
}

type MessageLike = {
  type: string
  message?: { content?: unknown }
}

// The newest messages are where a running call lives; a turn rarely runs more
// than a few dozen back, and the REPL recomputes this on every message. A
// call's own progress lands after it (a sub-agent's steps, two commands'
// alternating ticks), so progress doesn't count toward the limit, or a long
// enough call would scroll out of it while it still runs.
const SCAN_LIMIT = 50

/** The calls still running, oldest first, found among the newest messages. */
export function findRunningToolCalls(
  messages: readonly MessageLike[],
  inProgressToolUseIDs: ReadonlySet<string>,
): ToolCall[] {
  if (inProgressToolUseIDs.size === 0) return []
  const calls: ToolCall[] = []
  let scanned = 0
  for (let i = messages.length - 1; i >= 0 && scanned < SCAN_LIMIT && calls.length < inProgressToolUseIDs.size; i--) {
    const message = messages[i]!
    if (message.type === 'progress') continue
    scanned++
    const content = message.type === 'assistant' ? message.message?.content : undefined
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: string; id?: string; name?: string; input?: unknown }
      if (block.type === 'tool_use' && block.id && block.name && inProgressToolUseIDs.has(block.id)) {
        calls.push({ name: block.name, input: block.input })
      }
    }
  }
  return calls.reverse()
}

/**
 * What the agent is doing right now, for the spinner: the running calls, or
 * else the call whose input is still streaming in (its verb alone), or
 * nothing — the spinner then falls back on the mode.
 */
export function describeActivity(
  messages: readonly MessageLike[],
  inProgressToolUseIDs: ReadonlySet<string>,
  streamingToolUses: readonly { contentBlock: { name: string } }[],
): string | undefined {
  const running = describeToolCalls(findRunningToolCalls(messages, inProgressToolUseIDs))
  if (running) return running
  const streaming = streamingToolUses.at(-1)?.contentBlock.name
  return streaming ? describeToolCall({ name: streaming, input: undefined }) : undefined
}
