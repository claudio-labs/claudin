// Glyph set for the tool row header (AssistantToolUseMessage): one icon per
// tool before its name, and for a single-file tool the file-type icon before
// the path. Mirrors getFooterGroupSegments() in tasks/footerGroupIcons.ts —
// every Nerd Font codepoint lives here, and on a terminal without a Nerd Font
// getToolRowIcons() returns nothing, so the row renders exactly as before.
//
// All nf-md-* (supplementary PUA): footerGroupIcons.ts records nf-fa-*
// codepoints painting blank on a JetBrainsMono Nerd Font. Where a tool has a
// footer group (agents, mcp, containers, workflows), it reuses that icon.

import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import {
  LIST_WORKFLOWS_TOOL_NAME,
  WORKFLOW_RUN_TOOL_NAME,
  WORKFLOW_STATUS_TOOL_NAME,
} from 'src/tools/AgentWorkflow/constants.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
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
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
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
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import type { Tool } from 'src/tools/Tool.js'
import { getFileTypeIcon, getFileTypeIconColor } from 'src/terminal/fileIcons.js'
import type { HexColor } from 'src/terminal/ink/styles.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'

const CONSOLE = '\u{f018d}' // nf-md-console
const FILE_DOCUMENT = '\u{f09ee}' // nf-md-file_document_outline
const FILE_EDIT = '\u{f0dc9}' // nf-md-file_document_edit_outline
const FILE_PLUS = '\u{f0eed}' // nf-md-file_plus_outline
const MAGNIFY = '\u{f0349}' // nf-md-magnify
const FILE_SEARCH = '\u{f0c7d}' // nf-md-file_search_outline
const WEB = '\u{f059f}' // nf-md-web
const ROBOT = '\u{f06a9}' // nf-md-robot — the footer's agents icon
const PUZZLE = '\u{f0431}' // nf-md-puzzle — the footer's mcp icon
const SOURCE_BRANCH = '\u{f062c}' // nf-md-source_branch
const LIST_CHECKS = '\u{f0756}' // nf-md-format_list_checks
const HAMMER_WRENCH = '\u{f1323}' // nf-md-hammer_wrench
const FLASK = '\u{f0096}' // nf-md-flask_outline
const CODE_TAGS_CHECK = '\u{f0694}' // nf-md-code_tags_check
const DOCKER = '\u{f0868}' // nf-md-docker — the footer's containers icon
const MAP = '\u{f0982}' // nf-md-map_outline
const LIGHTNING = '\u{f140b}' // nf-md-lightning_bolt
const TIMER_SAND = '\u{f051f}' // nf-md-timer_sand
const GRAPH = '\u{f1049}' // nf-md-graph — the footer's workflows icon
const CHAT_QUESTION = '\u{f1739}' // nf-md-chat_question_outline
// Any tool not in the table, so every tool row carries an icon and the names
// line up.
const TOOLS = '\u{f1064}' // nf-md-tools

const TOOL_ICONS: Record<string, string> = {
  [BASH_TOOL_NAME]: CONSOLE,
  [POWERSHELL_TOOL_NAME]: CONSOLE,
  [FILE_READ_TOOL_NAME]: FILE_DOCUMENT,
  [FILE_EDIT_TOOL_NAME]: FILE_EDIT,
  [APPLY_PATCH_TOOL_NAME]: FILE_EDIT,
  [NOTEBOOK_EDIT_TOOL_NAME]: FILE_EDIT,
  [FILE_WRITE_TOOL_NAME]: FILE_PLUS,
  [GREP_TOOL_NAME]: MAGNIFY,
  [GLOB_TOOL_NAME]: FILE_SEARCH,
  [WEB_FETCH_TOOL_NAME]: WEB,
  [WEB_SEARCH_TOOL_NAME]: WEB,
  [AGENT_TOOL_NAME]: ROBOT,
  [LEGACY_AGENT_TOOL_NAME]: ROBOT,
  [SEND_MESSAGE_TOOL_NAME]: ROBOT,
  [LIST_AGENTS_TOOL_NAME]: ROBOT,
  [GIT_TOOL_NAME]: SOURCE_BRANCH,
  [TASK_CREATE_TOOL_NAME]: LIST_CHECKS,
  [TASK_UPDATE_TOOL_NAME]: LIST_CHECKS,
  [TASK_GET_TOOL_NAME]: LIST_CHECKS,
  [TASK_LIST_TOOL_NAME]: LIST_CHECKS,
  [TASK_STOP_TOOL_NAME]: LIST_CHECKS,
  [TASK_OUTPUT_TOOL_NAME]: LIST_CHECKS,
  [TODO_WRITE_TOOL_NAME]: LIST_CHECKS,
  [BUILD_TOOL_NAME]: HAMMER_WRENCH,
  [RUN_TESTS_TOOL_NAME]: FLASK,
  [TYPECHECK_TOOL_NAME]: CODE_TAGS_CHECK,
  [CONTAINER_TOOL_NAME]: DOCKER,
  [ENTER_PLAN_MODE_TOOL_NAME]: MAP,
  [EXIT_PLAN_MODE_TOOL_NAME]: MAP,
  [SKILL_TOOL_NAME]: LIGHTNING,
  [MONITOR_TOOL_NAME]: TIMER_SAND,
  [WAITFOR_TOOL_NAME]: TIMER_SAND,
  [WORKFLOW_RUN_TOOL_NAME]: GRAPH,
  [LIST_WORKFLOWS_TOOL_NAME]: GRAPH,
  [WORKFLOW_STATUS_TOOL_NAME]: GRAPH,
  [ASK_USER_QUESTION_TOOL_NAME]: CHAT_QUESTION,
}

// The input field naming the one file a single-file tool works on. A batch
// Read (`file_paths`) names several, so it gets no file icon.
const FILE_PATH_FIELDS: Record<string, string> = {
  [FILE_READ_TOOL_NAME]: 'file_path',
  [FILE_EDIT_TOOL_NAME]: 'file_path',
  [FILE_WRITE_TOOL_NAME]: 'file_path',
  [NOTEBOOK_EDIT_TOOL_NAME]: 'notebook_path',
}

// One icon per part of a collapsed read/search line ("Searched for 2 patterns,
// read 3 files"), named after the verb the part shows. Parts a tool also
// renders as a row share that tool's icon.
export type CollapsedPartKind =
  | 'commit'
  | 'push'
  | 'branch'
  | 'pr'
  | 'create'
  | 'update'
  | 'delete'
  | 'rename'
  | 'search'
  | 'read'
  | 'list'
  | 'repl'
  | 'mcp'
  | 'bash'
  | 'memory'

const COLLAPSED_PART_ICONS: Readonly<Record<CollapsedPartKind, string>> = {
  commit: '\u{f0718}', // nf-md-source_commit
  push: '\u{f0b7e}', // nf-md-cloud_upload_outline
  branch: '\u{f062d}', // nf-md-source_merge — merged / rebased onto
  pr: '\u{f04c2}', // nf-md-source_pull
  create: FILE_PLUS,
  update: FILE_EDIT,
  delete: '\u{f1037}', // nf-md-file_remove_outline
  rename: '\u{f1031}', // nf-md-file_move_outline
  search: MAGNIFY,
  read: FILE_DOCUMENT,
  list: '\u{f0dcf}', // nf-md-folder_open_outline
  repl: CONSOLE,
  mcp: PUZZLE,
  bash: CONSOLE,
  memory: '\u{f09d1}', // nf-md-brain
}

/**
 * The collapsed line's part icons, or undefined without a Nerd Font — the
 * line then keeps its leading dot column and shows no icon at all.
 */
export function getCollapsedPartIcons(
  nerdFont = hasNerdFontGlyphs(),
):
  | Readonly<Record<CollapsedPartKind, string>>
  | undefined {
  return nerdFont ? COLLAPSED_PART_ICONS : undefined
}

export type ToolRowIcons = {
  toolIcon?: string
  fileIcon?: { glyph: string; color: HexColor | undefined }
}

/**
 * The icons a tool row shows: none at all without a Nerd Font, otherwise the
 * tool's icon (MCP tools share one, unmapped tools a generic one) and, for a
 * single-file tool whose input names its file, that file's type icon and color.
 *
 * Reads env (via `hasNerdFontGlyphs`) unless given `nerdFont` — a component
 * passes `useNerdFontGlyphs()` — so callers should memoize the result.
 */
export function getToolRowIcons(
  tool: Pick<Tool, 'name' | 'isMcp'>,
  input: unknown,
  nerdFont = hasNerdFontGlyphs(),
): ToolRowIcons {
  if (!nerdFont) return {}
  const toolIcon = tool.isMcp ? PUZZLE : (TOOL_ICONS[tool.name] ?? TOOLS)
  const field = FILE_PATH_FIELDS[tool.name]
  const path =
    field && input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)[field]
      : undefined
  if (typeof path !== 'string' || path === '') return { toolIcon }
  return {
    toolIcon,
    fileIcon: { glyph: getFileTypeIcon(path), color: getFileTypeIconColor(path) },
  }
}
