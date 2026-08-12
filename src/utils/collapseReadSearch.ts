import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { StructuredPatchHunk } from 'diff'
import { isAbsolute } from 'path'
import { findToolByName, type Tools } from '../Tool.js'
import { parsePatch } from '../tools/ApplyPatchTool/patchFormat.js'
import { APPLY_PATCH_TOOL_NAME } from '../tools/ApplyPatchTool/prompt.js'
import { extractBashCommentLabel } from '../tools/BashTool/commentLabel.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { RENAME_TOOL_NAME } from '../tools/RenameTool/prompt.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import { getReplPrimitiveTools } from '../tools/REPLTool/primitiveTools.js'
import {
  type BranchAction,
  type CommitKind,
  detectGitOperation,
  type PrAction,
} from '../tools/shared/gitOperationTracking.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
  WriteFileStat,
  WriteKind,
} from '../types/message.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { countAddDel } from './diffStat.js'
import { getDisplayPath } from './file.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from './memoryFileDetection.js'
import { expandPath } from './path.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemOps = feature('TEAMMEM')
  ? (require('./teamMemoryOps.js') as typeof import('./teamMemoryOps.js'))
  : null
const SNIP_TOOL_NAME = feature('HISTORY_SNIP')
  ? (
      require('../tools/SnipTool/prompt.js') as typeof import('../tools/SnipTool/prompt.js')
    ).SNIP_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Result of checking if a tool use is a search or read operation.
 */
export type SearchOrReadResult = {
  isCollapsible: boolean
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  /** True if this is a Write/Edit targeting a memory file */
  isMemoryWrite: boolean
  /**
   * True for meta-operations that should be absorbed into a collapse group
   * without incrementing any count (Snip, ToolSearch). They remain visible
   * in verbose mode via the groupMessages iteration.
   */
  isAbsorbedSilently: boolean
  /** MCP server name when this is an MCP tool */
  mcpServerName?: string
  /** Bash command that is NOT a search/read (under fullscreen mode) */
  isBash?: boolean
  /** True for Write/Edit/apply_patch/Rename outside the memory dir */
  isWrite: boolean
}

/**
 * Extract the primary file/directory path from a tool_use input.
 * Handles both `file_path` (Read/Write/Edit) and `path` (Grep/Glob).
 */
function getFilePathFromToolInput(toolInput: unknown): string | undefined {
  const input = toolInput as
    | { file_path?: string; path?: string; pattern?: string; glob?: string }
    | undefined
  return input?.file_path ?? input?.path
}

/**
 * Check if a search tool use targets memory files by examining its path, pattern, and glob.
 */
function isMemorySearch(toolInput: unknown): boolean {
  const input = toolInput as
    | { path?: string; pattern?: string; glob?: string; command?: string }
    | undefined
  if (!input) {
    return false
  }
  // Check if the search path targets a memory file or directory (Grep/Glob tools)
  if (input.path) {
    if (isAutoManagedMemoryFile(input.path) || isMemoryDirectory(input.path)) {
      return true
    }
  }
  // Check glob patterns that indicate memory file access
  if (input.glob && isAutoManagedMemoryPattern(input.glob)) {
    return true
  }
  // For shell commands (bash grep/rg, PowerShell Select-String, etc.),
  // check if the command targets memory paths
  if (input.command && isShellCommandTargetingMemory(input.command)) {
    return true
  }
  return false
}

/**
 * Check if a Write or Edit tool use targets a memory file and should be collapsed.
 */
function isMemoryWriteOrEdit(toolName: string, toolInput: unknown): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  const filePath = getFilePathFromToolInput(toolInput)
  return filePath !== undefined && isAutoManagedMemoryFile(filePath)
}

/** A file a write tool is about to touch, known from its input alone. */
type WriteTarget = { path: string; kind: WriteKind }

/** `/config` → "Collapse file writes". undefined ⇒ on. */
function isWriteCollapseEnabled(): boolean {
  return getGlobalConfig().collapseFileWritesEnabled !== false
}

// Re-parsing the envelope on every transcript re-render would cost O(patch) per
// frame. The tool_use input object is stable across renders, so key the parse
// on it — an unparsable envelope caches its empty result too.
const APPLY_PATCH_TARGETS = new WeakMap<object, WriteTarget[]>()

/**
 * A path we can name before the result arrives. Only an absolute one: a
 * relative path is resolved against the cwd at EXECUTION time, and this runs at
 * render time — after a `cd` it would invent a second path for the same file
 * and the group would list (and count) it twice. The result carries the real
 * absolute path a moment later.
 */
function stableAbsolutePath(path: string): string | null {
  // Test the RAW path: expandPath resolves a relative one against getCwd(), so
  // asking it first would hand back an absolute path and hide the problem.
  // `~` is fine — home does not move mid-session.
  if (!isAbsolute(path) && !path.startsWith('~')) {
    return null
  }
  const expanded = expandPath(path)
  return isAbsolute(expanded) ? expanded : null
}

/** null ⇒ no envelope yet (still streaming), so nothing to collapse on. */
function getApplyPatchTargets(toolInput: unknown): WriteTarget[] | null {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return null
  }
  const cached = APPLY_PATCH_TARGETS.get(toolInput)
  if (cached) {
    return cached
  }
  const { patchText } = toolInput as { patchText?: string }
  if (typeof patchText !== 'string') {
    // Don't cache: the input object is rebuilt when the streamed JSON finally
    // parses, but caching an empty list against a half-built one is a trap.
    return null
  }
  const targets: WriteTarget[] = []
  try {
    for (const hunk of parsePatch(patchText).hunks) {
      // Mirror applyPatch's own resolveHunkPath, so a hunk path lines up with
      // the absPath its result reports instead of listing twice. `movePath`
      // lives on the update member alone, hence the narrowing per branch.
      const target: { raw: string; kind: WriteKind } =
        hunk.type === 'add'
          ? { raw: hunk.path, kind: 'A' }
          : hunk.type === 'delete'
            ? { raw: hunk.path, kind: 'D' }
            : hunk.movePath
              ? { raw: hunk.movePath, kind: 'R' }
              : { raw: hunk.path, kind: 'M' }
      const path = stableAbsolutePath(target.raw)
      if (path) {
        targets.push({ path, kind: target.kind })
      }
    }
  } catch (e) {
    // Display-only fallback: the file list still arrives with the result, and
    // a patch the parser rejects is exactly the one whose result carries the
    // error. Never block the render on it.
    logForDebugging(
      `collapseReadSearch: apply_patch parse failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  APPLY_PATCH_TARGETS.set(toolInput, targets)
  return targets
}

/**
 * Files a write tool use will touch, read from its INPUT — the result may not
 * have arrived yet.
 *
 * Three states, and the difference matters: `null` = not a collapsible write,
 * so the message keeps its own block — that covers `Rename` in preview mode
 * (it writes nothing) and a write whose input is still streaming, which would
 * otherwise be absorbed into a group that cannot name it and so would vanish
 * from the transcript until its JSON finished parsing. An empty array =
 * collapsible, files not knowable yet (Rename apply lists them only in its
 * result); a non-empty one = the files, for the rows shown while it runs.
 */
function getWriteTargets(
  toolName: string,
  toolInput: unknown,
): WriteTarget[] | null {
  switch (toolName) {
    case FILE_WRITE_TOOL_NAME:
    case FILE_EDIT_TOOL_NAME: {
      const filePath = getFilePathFromToolInput(toolInput)
      if (!filePath) {
        return null
      }
      const path = stableAbsolutePath(filePath)
      // A Write that creates the file only reveals that in its result, which
      // upgrades the kind to 'A' when it lands.
      return path ? [{ path, kind: 'M' }] : []
    }
    case APPLY_PATCH_TOOL_NAME:
      return getApplyPatchTargets(toolInput)
    case RENAME_TOOL_NAME: {
      const mode = (toolInput as { mode?: string } | undefined)?.mode
      if (mode === 'preview') {
        return null
      }
      // The input carries the symbol, not the files — they arrive with the result.
      return []
    }
    default:
      return null
  }
}

// ~5 lines × ~60 cols. Generous static cap — the renderer lets Ink wrap.
const MAX_HINT_CHARS = 300

/**
 * Format a bash command for the ⎿ hint. Drops blank lines, collapses runs of
 * inline whitespace, then caps total length. Newlines are preserved so the
 * renderer can indent continuation lines under ⎿.
 */
function commandAsHint(command: string): string {
  const cleaned =
    '$ ' +
    command
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(l => l !== '')
      .join('\n')
  return cleaned.length > MAX_HINT_CHARS
    ? cleaned.slice(0, MAX_HINT_CHARS - 1) + '…'
    : cleaned
}

/**
 * Checks if a tool is a search/read operation using the tool's isSearchOrReadCommand method.
 * Also treats Write/Edit of memory files as collapsible.
 * Returns detailed information about whether it's a search or read operation.
 */
export function getToolSearchOrReadInfo(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): SearchOrReadResult {
  // REPL is absorbed silently — its inner tool calls are emitted as virtual
  // messages (isVirtual: true) via newMessages and flow through this function
  // as regular Read/Grep/Bash messages. The REPL wrapper itself contributes
  // no counts and doesn't break the group, so consecutive REPL calls merge.
  if (toolName === REPL_TOOL_NAME) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: true,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
      isWrite: false,
    }
  }

  // Memory file writes/edits are collapsible
  if (isMemoryWriteOrEdit(toolName, toolInput)) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: true,
      isAbsorbedSilently: false,
      isWrite: false,
    }
  }

  // Meta-operations absorbed silently: Snip (context cleanup) and ToolSearch
  // (lazy tool schema loading). Neither should break a collapse group or
  // contribute to its count, but both stay visible in verbose mode.
  if (
    (feature('HISTORY_SNIP') && toolName === SNIP_TOOL_NAME) ||
    (isFullscreenEnvEnabled() && toolName === TOOL_SEARCH_TOOL_NAME)
  ) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
      isWrite: false,
    }
  }

  // Writes outside the memory dir. Checked after the memory arm so a memory
  // write keeps saying "Wrote 1 memory", and before the search/read fallback
  // because none of these tools implements isSearchOrReadCommand.
  if (isWriteCollapseEnabled() && getWriteTargets(toolName, toolInput)) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: false,
      isWrite: true,
    }
  }

  // Fallback to REPL primitives: in REPL mode, Bash/Read/Grep/etc. are
  // stripped from the execution tools list, but REPL emits them as virtual
  // messages. Without the fallback they'd return isCollapsible: false and
  // vanish from the summary line.
  const tool =
    findToolByName(tools, toolName) ??
    findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool?.isSearchOrReadCommand) {
    return {
      isCollapsible: false,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: false,
      isWrite: false,
    }
  }
  // The tool's isSearchOrReadCommand method handles its own input validation via safeParse,
  // so passing the raw input is safe. The type assertion is necessary because Tool[] uses
  // the default generic which expects { [x: string]: any }, but we receive unknown at runtime.
  const result = tool.isSearchOrReadCommand(
    toolInput as { [x: string]: unknown },
  )
  const isList = result.isList ?? false
  const isCollapsible = result.isSearch || result.isRead || isList
  // Under fullscreen mode, non-search/read Bash commands are also collapsible
  // as their own category — "Ran N bash commands" instead of breaking the group.
  return {
    isCollapsible:
      isCollapsible ||
      (isFullscreenEnvEnabled() ? toolName === BASH_TOOL_NAME : false),
    isSearch: result.isSearch,
    isRead: result.isRead,
    isList,
    isREPL: false,
    isMemoryWrite: false,
    isAbsorbedSilently: false,
    isWrite: false,
    ...(tool.isMcp && { mcpServerName: tool.mcpInfo?.serverName }),
    isBash: isFullscreenEnvEnabled()
      ? !isCollapsible && toolName === BASH_TOOL_NAME
      : undefined,
  }
}

/**
 * Check if a tool_use content block is a search/read operation.
 * Returns { isSearch, isRead, isREPL } if it's a collapsible search/read, null otherwise.
 */
export function getSearchOrReadFromContent(
  content: { type: string; name?: string; input?: unknown } | undefined,
  tools: Tools,
): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
  isWrite: boolean
} | null {
  if (content?.type === 'tool_use' && content.name) {
    const info = getToolSearchOrReadInfo(content.name, content.input, tools)
    if (info.isCollapsible || info.isREPL) {
      return {
        isSearch: info.isSearch,
        isRead: info.isRead,
        isList: info.isList,
        isREPL: info.isREPL,
        isMemoryWrite: info.isMemoryWrite,
        isAbsorbedSilently: info.isAbsorbedSilently,
        mcpServerName: info.mcpServerName,
        isBash: info.isBash,
        isWrite: info.isWrite,
      }
    }
  }
  return null
}

/**
 * Checks if a tool is a search/read operation (for backwards compatibility).
 */
function isToolSearchOrRead(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): boolean {
  return getToolSearchOrReadInfo(toolName, toolInput, tools).isCollapsible
}

/**
 * Get the tool name, input, and search/read info from a message if it's a collapsible tool use.
 * Returns null if the message is not a collapsible tool use.
 */
function getCollapsibleToolInfo(
  msg: RenderableMessage,
  tools: Tools,
): {
  name: string
  input: unknown
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
  isWrite: boolean
} | null {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    const info = getSearchOrReadFromContent(content, tools)
    if (info && content?.type === 'tool_use') {
      return { name: content.name, input: content.input, ...info }
    }
  }
  if (msg.type === 'grouped_tool_use') {
    // For grouped tool uses, check the first message's input
    const firstContent = msg.messages[0]?.message.content[0]
    const info = getSearchOrReadFromContent(
      firstContent
        ? { type: 'tool_use', name: msg.toolName, input: firstContent.input }
        : undefined,
      tools,
    )
    if (info && firstContent?.type === 'tool_use') {
      return { name: msg.toolName, input: firstContent.input, ...info }
    }
  }
  return null
}

/**
 * Check if a message is assistant text that should break a group.
 */
function isTextBreaker(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'text' && content.text.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * Check if a message is a non-collapsible tool use that should break a group.
 * This includes tool uses like Edit, Write, etc.
 */
function isNonCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (
      content?.type === 'tool_use' &&
      !isToolSearchOrRead(content.name, content.input, tools)
    ) {
      return true
    }
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    if (
      firstContent?.type === 'tool_use' &&
      !isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    ) {
      return true
    }
  }
  return false
}

function isPreToolHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    msg.hookLabel === 'PreToolUse'
  )
}

/**
 * Check if a message should be skipped (not break the group, just passed through).
 * This includes thinking blocks, redacted thinking, attachments, etc.
 */
function shouldSkipMessage(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    // Skip thinking blocks and other non-text, non-tool content
    if (content?.type === 'thinking' || content?.type === 'redacted_thinking') {
      return true
    }
  }
  // Skip attachment messages
  if (msg.type === 'attachment') {
    return true
  }
  // Skip system messages
  if (msg.type === 'system') {
    return true
  }
  return false
}

/**
 * Type predicate: Check if a message is a collapsible tool use.
 */
function isCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): msg is CollapsibleMessage {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    return (
      content?.type === 'tool_use' &&
      isToolSearchOrRead(content.name, content.input, tools)
    )
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    return (
      firstContent?.type === 'tool_use' &&
      isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    )
  }
  return false
}

/**
 * Type predicate: Check if a message is a tool result for collapsible tools.
 * Returns true if ALL tool results in the message are for tracked collapsible tools.
 */
function isCollapsibleToolResult(
  msg: RenderableMessage,
  collapsibleToolUseIds: Set<string>,
): msg is CollapsibleMessage {
  if (msg.type === 'user') {
    const toolResults = msg.message.content.filter(
      (c): c is { type: 'tool_result'; tool_use_id: string } =>
        c.type === 'tool_result',
    )
    // Only return true if there are tool results AND all of them are for collapsible tools
    return (
      toolResults.length > 0 &&
      toolResults.every(r => collapsibleToolUseIds.has(r.tool_use_id))
    )
  }
  return false
}

/**
 * Get all tool use IDs from a single message (handles grouped tool uses).
 */
function getToolUseIdsFromMessage(msg: RenderableMessage): string[] {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_use') {
      return [content.id]
    }
  }
  if (msg.type === 'grouped_tool_use') {
    return msg.messages
      .map(m => {
        const content = m.message.content[0]
        return content.type === 'tool_use' ? content.id : ''
      })
      .filter(Boolean)
  }
  return []
}

/**
 * tool_use_ids whose result came back as an error. A failed write must not be
 * folded away: the collapsed group's verbose view only renders a result when
 * it resolved without error, so the failure — including a denied permission,
 * which arrives the same way — would be invisible even under Ctrl+O.
 */
function collectErroredToolUseIds(messages: RenderableMessage[]): Set<string> {
  const ids = new Set<string>()
  function scan(msg: RenderableMessage): void {
    if (msg.type !== 'user') return
    for (const content of msg.message.content) {
      const block = content as { type: string; tool_use_id?: string; is_error?: boolean }
      if (block.type === 'tool_result' && block.is_error && block.tool_use_id) {
        ids.add(block.tool_use_id)
      }
    }
  }
  for (const msg of messages) {
    scan(msg)
    if (msg.type === 'grouped_tool_use') {
      for (const resultMsg of msg.results) {
        scan(resultMsg)
      }
    }
  }
  return ids
}

/** A write whose result errored — breaks the group instead of joining it. */
function isErroredWriteToolUse(
  msg: RenderableMessage,
  tools: Tools,
  erroredToolUseIds: Set<string>,
): boolean {
  if (erroredToolUseIds.size === 0) {
    return false
  }
  if (!getCollapsibleToolInfo(msg, tools)?.isWrite) {
    return false
  }
  return getToolUseIdsFromMessage(msg).some(id => erroredToolUseIds.has(id))
}

/**
 * Get all tool use IDs from a collapsed read/search group.
 */
export function getToolUseIdsFromCollapsedGroup(
  message: CollapsedReadSearchGroup,
): string[] {
  const ids: string[] = []
  for (const msg of message.messages) {
    ids.push(...getToolUseIdsFromMessage(msg))
  }
  return ids
}

/**
 * Check if any tool in a collapsed group is in progress.
 */
export function hasAnyToolInProgress(
  message: CollapsedReadSearchGroup,
  inProgressToolUseIDs: Set<string>,
): boolean {
  return getToolUseIdsFromCollapsedGroup(message).some(id =>
    inProgressToolUseIDs.has(id),
  )
}

/**
 * Get the underlying NormalizedMessage for display (timestamp/model).
 * Handles nested GroupedToolUseMessage within collapsed groups.
 * Returns a NormalizedAssistantMessage or NormalizedUserMessage (never GroupedToolUseMessage).
 */
export function getDisplayMessageFromCollapsed(
  message: CollapsedReadSearchGroup,
): Exclude<CollapsibleMessage, { type: 'grouped_tool_use' }> {
  const firstMsg = message.displayMessage
  if (firstMsg.type === 'grouped_tool_use') {
    return firstMsg.displayMessage
  }
  return firstMsg
}

/**
 * Count the number of tool uses in a message (handles grouped tool uses).
 */
function countToolUses(msg: RenderableMessage): number {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.length
  }
  return 1
}

/**
 * Extract file paths from read tool inputs in a message.
 * Returns an array of file paths (may have duplicates if same file is read multiple times in one grouped message).
 */
function getFilePathsFromReadMessage(msg: RenderableMessage): string[] {
  const paths: string[] = []

  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_use') {
      const input = content.input as { file_path?: string } | undefined
      if (input?.file_path) {
        paths.push(input.file_path)
      }
    }
  } else if (msg.type === 'grouped_tool_use') {
    for (const m of msg.messages) {
      const content = m.message.content[0]
      if (content?.type === 'tool_use') {
        const input = content.input as { file_path?: string } | undefined
        if (input?.file_path) {
          paths.push(input.file_path)
        }
      }
    }
  }

  return paths
}

/**
 * Every write target in a message. Handles `grouped_tool_use`, which is how N
 * Edits from one assistant turn arrive (FileEditTool sets renderGroupedToolUse)
 * — reading only the first input would lose the other files.
 */
function getWriteTargetsFromMessage(
  msg: RenderableMessage,
  toolName: string,
): WriteTarget[] {
  const targets: WriteTarget[] = []
  const messages =
    msg.type === 'grouped_tool_use'
      ? msg.messages
      : msg.type === 'assistant'
        ? [msg]
        : []
  for (const m of messages) {
    const content = m.message.content[0]
    if (content?.type !== 'tool_use') continue
    for (const target of getWriteTargets(toolName, content.input) ?? []) {
      targets.push(target)
    }
  }
  return targets
}

// Delete beats create beats rename beats modify: a file created and then edited
// in the same group is still a creation, and one deleted after that is a delete.
const WRITE_KIND_RANK: Record<WriteKind, number> = { M: 0, R: 1, A: 2, D: 3 }

/**
 * Record one file touched by a write. Called twice per file: once from the
 * tool_use (path only, so the row shows up while the write runs) and once from
 * the result (which carries the line counts). Repeated edits of the same file
 * accumulate — the collapse is recomputed from scratch on every render, so this
 * never double-counts across frames.
 */
function recordWriteFile(
  group: GroupAccumulator,
  path: string,
  kind: WriteKind,
  stats?: { additions: number; deletions: number },
): void {
  const existing = group.writeFiles.get(path)
  if (!existing) {
    group.writeFiles.set(path, {
      kind,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
    })
    return
  }
  if (WRITE_KIND_RANK[kind] > WRITE_KIND_RANK[existing.kind]) {
    existing.kind = kind
  }
  if (stats) {
    existing.additions += stats.additions
    existing.deletions += stats.deletions
  }
}

/**
 * Pull the per-file line counts out of a write tool's result. Each tool reports
 * them differently: Edit/Write carry a `structuredPatch`, apply_patch and
 * Rename already ship `additions`/`deletions` per file.
 */
function applyWriteResult(
  group: GroupAccumulator,
  toolName: string,
  result: unknown,
): void {
  if (!result || typeof result !== 'object') return
  switch (toolName) {
    case FILE_EDIT_TOOL_NAME: {
      const out = result as {
        filePath?: string
        structuredPatch?: StructuredPatchHunk[]
      }
      if (out.filePath) {
        recordWriteFile(
          group,
          out.filePath,
          'M',
          countAddDel(out.structuredPatch ?? []),
        )
      }
      break
    }
    case FILE_WRITE_TOOL_NAME: {
      const out = result as {
        type?: string
        filePath?: string
        content?: string
        structuredPatch?: StructuredPatchHunk[]
      }
      if (!out.filePath) break
      const hunks = out.structuredPatch ?? []
      // A create has no patch (FileWriteTool returns `structuredPatch: []`) —
      // every line of the new file is an addition. Strip the trailing newline
      // first: `'a\nb\n'.split('\n')` ends in an empty string, which would
      // count a line that isn't there.
      const stats =
        hunks.length === 0 && out.type === 'create'
          ? {
              additions: out.content
                ? out.content.replace(/\n$/, '').split('\n').length
                : 0,
              deletions: 0,
            }
          : countAddDel(hunks)
      recordWriteFile(
        group,
        out.filePath,
        out.type === 'create' ? 'A' : 'M',
        stats,
      )
      break
    }
    case APPLY_PATCH_TOOL_NAME: {
      const out = result as {
        files?: {
          absPath?: string
          movePath?: string
          type?: string
          additions?: number
          deletions?: number
        }[]
      }
      for (const file of out.files ?? []) {
        const path = file.movePath ?? file.absPath
        if (!path) continue
        const kind: WriteKind =
          file.type === 'add'
            ? 'A'
            : file.type === 'delete'
              ? 'D'
              : file.type === 'move'
                ? 'R'
                : 'M'
        recordWriteFile(group, path, kind, {
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        })
      }
      break
    }
    case RENAME_TOOL_NAME: {
      const out = result as {
        type?: string
        files?: { absPath?: string; additions?: number; deletions?: number }[]
      }
      // A preview never reaches here (it isn't collapsible), but the union also
      // covers it — only an apply has files on disk.
      if (out.type !== 'apply') break
      for (const file of out.files ?? []) {
        if (!file.absPath) continue
        // 'M', not 'R': the tool renames a symbol, so every file it touches is
        // modified in place. 'R' is for a file that changed path, which only
        // apply_patch's `Move to:` produces.
        recordWriteFile(group, file.absPath, 'M', {
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        })
      }
      break
    }
    default:
      break
  }
}

/**
 * Apply every write result carried by a tool_result message to the group.
 * Mirrors scanBashResultForGitOps: the id → tool name map is what tells us how
 * to read `toolUseResult`.
 */
function applyWriteResultsFromMessage(
  msg: CollapsibleMessage,
  group: GroupAccumulator,
): void {
  if (msg.type !== 'user') return
  for (const content of msg.message.content) {
    if (content.type !== 'tool_result') continue
    const toolName = group.writeToolNames.get(content.tool_use_id)
    if (toolName) {
      applyWriteResult(group, toolName, msg.toolUseResult)
    }
  }
}

/**
 * Scan a bash tool result for commit SHAs and PR URLs and push them into the
 * group accumulator. Called only for results whose tool_use_id was recorded
 * in bashCommands (non-search/read bash).
 */
function scanBashResultForGitOps(
  msg: CollapsibleMessage,
  group: GroupAccumulator,
): void {
  if (msg.type !== 'user') return
  const out = msg.toolUseResult as
    | { stdout?: string; stderr?: string }
    | undefined
  if (!out?.stdout && !out?.stderr) return
  // git push writes the ref update to stderr — scan both streams.
  const combined = (out.stdout ?? '') + '\n' + (out.stderr ?? '')
  for (const c of msg.message.content) {
    if (c.type !== 'tool_result') continue
    const command = group.bashCommands?.get(c.tool_use_id)
    if (!command) continue
    const { commit, push, branch, pr } = detectGitOperation(command, combined)
    if (commit) group.commits?.push(commit)
    if (push) group.pushes?.push(push)
    if (branch) group.branches?.push(branch)
    if (pr) group.prs?.push(pr)
    if (commit || push || branch || pr) {
      group.gitOpBashCount = (group.gitOpBashCount ?? 0) + 1
    }
  }
}

type GroupAccumulator = {
  messages: CollapsibleMessage[]
  searchCount: number
  readFilePaths: Set<string>
  // Count of read operations that don't have file paths (e.g., Bash cat commands)
  readOperationCount: number
  // Count of directory-listing operations (ls, tree, du)
  listCount: number
  toolUseIds: Set<string>
  // Memory file operation counts (tracked separately from regular counts)
  memorySearchCount: number
  memoryReadFilePaths: Set<string>
  memoryWriteCount: number
  // Team memory file operation counts (tracked separately)
  teamMemorySearchCount?: number
  teamMemoryReadFilePaths?: Set<string>
  teamMemoryWriteCount?: number
  // Non-memory search patterns for display beneath the collapsed summary
  nonMemSearchArgs: string[]
  /** Most recently added non-memory operation, pre-formatted for display */
  latestDisplayHint: string | undefined
  // MCP tool calls (tracked separately so display says "Queried slack" not "Read N files")
  mcpCallCount?: number
  mcpServerNames?: Set<string>
  // Bash commands that aren't search/read (tracked separately for "Ran N bash commands")
  bashCount?: number
  // Files written by Write/Edit/apply_patch/Rename, in first-touch order (Map
  // preserves insertion order, which is what the ⎿ list renders).
  writeFiles: Map<string, { kind: WriteKind; additions: number; deletions: number }>
  // Write tool_use_id → tool name, so the tool_result can be read with the
  // right shape (mirrors bashCommands).
  writeToolNames: Map<string, string>
  // Bash tool_use_id → command string, so tool results can be scanned for
  // commit SHAs / PR URLs (surfaced as "committed abc123, created PR #42")
  bashCommands?: Map<string, string>
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  gitOpBashCount?: number
  // PreToolUse hook timing absorbed from hook summary messages
  hookTotalMs: number
  hookCount: number
  hookInfos: StopHookInfo[]
  // relevant_memories attachments absorbed into this group (auto-injected
  // memories, not explicit Read calls). Paths mirrored into readFilePaths +
  // memoryReadFilePaths so the inline "recalled N memories" text is accurate.
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

function createEmptyGroup(): GroupAccumulator {
  const group: GroupAccumulator = {
    messages: [],
    searchCount: 0,
    readFilePaths: new Set(),
    readOperationCount: 0,
    listCount: 0,
    toolUseIds: new Set(),
    memorySearchCount: 0,
    memoryReadFilePaths: new Set(),
    memoryWriteCount: 0,
    nonMemSearchArgs: [],
    latestDisplayHint: undefined,
    hookTotalMs: 0,
    hookCount: 0,
    hookInfos: [],
    writeFiles: new Map(),
    writeToolNames: new Map(),
  }
  if (feature('TEAMMEM')) {
    group.teamMemorySearchCount = 0
    group.teamMemoryReadFilePaths = new Set()
    group.teamMemoryWriteCount = 0
  }
  group.mcpCallCount = 0
  group.mcpServerNames = new Set()
  if (isFullscreenEnvEnabled()) {
    group.bashCount = 0
    group.bashCommands = new Map()
    group.commits = []
    group.pushes = []
    group.branches = []
    group.prs = []
    group.gitOpBashCount = 0
  }
  return group
}

function createCollapsedGroup(
  group: GroupAccumulator,
): CollapsedReadSearchGroup {
  const firstMsg = group.messages[0]!
  // When file-path-based reads exist, use unique file count (Set.size) only.
  // Adding bash operation count on top would double-count — e.g. Read(README.md)
  // followed by Bash(wc -l README.md) should still show as 1 file, not 2.
  // Fall back to operation count only when there are no file-path reads (bash-only).
  const totalReadCount =
    group.readFilePaths.size > 0
      ? group.readFilePaths.size
      : group.readOperationCount
  // memoryReadFilePaths ⊆ readFilePaths (both populated from Read tool calls),
  // so this count is safe to subtract from totalReadCount at readCount below.
  // Absorbed relevant_memories attachments are NOT in readFilePaths — added
  // separately after the subtraction so readCount stays correct.
  const toolMemoryReadCount = group.memoryReadFilePaths.size
  const memoryReadCount =
    toolMemoryReadCount + (group.relevantMemories?.length ?? 0)
  // Non-memory read file paths: exclude memory and team memory paths
  const teamMemReadPaths = feature('TEAMMEM')
    ? group.teamMemoryReadFilePaths
    : undefined
  const nonMemReadFilePaths = [...group.readFilePaths].filter(
    p =>
      !group.memoryReadFilePaths.has(p) && !(teamMemReadPaths?.has(p) ?? false),
  )
  const teamMemSearchCount = feature('TEAMMEM')
    ? (group.teamMemorySearchCount ?? 0)
    : 0
  const teamMemReadCount = feature('TEAMMEM')
    ? (group.teamMemoryReadFilePaths?.size ?? 0)
    : 0
  const teamMemWriteCount = feature('TEAMMEM')
    ? (group.teamMemoryWriteCount ?? 0)
    : 0
  const result: CollapsedReadSearchGroup = {
    type: 'collapsed_read_search',
    // Subtract memory + team memory counts so regular counts only reflect non-memory operations
    searchCount: Math.max(
      0,
      group.searchCount - group.memorySearchCount - teamMemSearchCount,
    ),
    readCount: Math.max(
      0,
      totalReadCount - toolMemoryReadCount - teamMemReadCount,
    ),
    listCount: group.listCount,
    // REPL operations are intentionally not collapsed (see isCollapsible: false at line 32),
    // so replCount in collapsed groups is always 0. The replCount field is kept for
    // sub-agent progress display in AgentTool/UI.tsx which has a separate code path.
    replCount: 0,
    memorySearchCount: group.memorySearchCount,
    memoryReadCount,
    memoryWriteCount: group.memoryWriteCount,
    readFilePaths: nonMemReadFilePaths,
    searchArgs: group.nonMemSearchArgs,
    latestDisplayHint: group.latestDisplayHint,
    messages: group.messages,
    displayMessage: firstMsg,
    uuid: `collapsed-${firstMsg.uuid}` as UUID,
    timestamp: firstMsg.timestamp,
  }
  if (feature('TEAMMEM')) {
    result.teamMemorySearchCount = teamMemSearchCount
    result.teamMemoryReadCount = teamMemReadCount
    result.teamMemoryWriteCount = teamMemWriteCount
  }
  if ((group.mcpCallCount ?? 0) > 0) {
    result.mcpCallCount = group.mcpCallCount
    result.mcpServerNames = [...(group.mcpServerNames ?? [])]
  }
  if (isFullscreenEnvEnabled()) {
    if ((group.bashCount ?? 0) > 0) {
      result.bashCount = group.bashCount
      result.gitOpBashCount = group.gitOpBashCount
    }
    if ((group.commits?.length ?? 0) > 0) result.commits = group.commits
    if ((group.pushes?.length ?? 0) > 0) result.pushes = group.pushes
    if ((group.branches?.length ?? 0) > 0) result.branches = group.branches
    if ((group.prs?.length ?? 0) > 0) result.prs = group.prs
  }
  if (group.hookCount > 0) {
    result.hookTotalMs = group.hookTotalMs
    result.hookCount = group.hookCount
    result.hookInfos = group.hookInfos
  }
  if (group.relevantMemories && group.relevantMemories.length > 0) {
    result.relevantMemories = group.relevantMemories
  }
  if (group.writeFiles.size > 0) {
    result.writeFileStats = [...group.writeFiles].map(([path, stat]) => ({
      path,
      ...stat,
    }))
  }
  return result
}

/**
 * Collapse consecutive Read/Search operations into summary groups.
 *
 * Rules:
 * - Groups consecutive search/read tool uses (Grep, Glob, Read, and Bash search/read commands)
 * - Includes their corresponding tool results in the group
 * - Breaks groups when assistant text appears
 */
export function collapseReadSearchGroups(
  messages: RenderableMessage[],
  tools: Tools,
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  const erroredToolUseIds = collectErroredToolUseIds(messages)
  let currentGroup = createEmptyGroup()
  let deferredSkippable: RenderableMessage[] = []

  function flushGroup(): void {
    if (currentGroup.messages.length === 0) {
      return
    }
    result.push(createCollapsedGroup(currentGroup))
    for (const deferred of deferredSkippable) {
      result.push(deferred)
    }
    deferredSkippable = []
    currentGroup = createEmptyGroup()
  }

  for (const msg of messages) {
    if (isErroredWriteToolUse(msg, tools, erroredToolUseIds)) {
      // Its result lands on the next message, which no longer matches any id in
      // the group and therefore breaks it too — error and diff stay together.
      flushGroup()
      result.push(msg)
    } else if (isCollapsibleToolUse(msg, tools)) {
      // This is a collapsible tool use - type predicate narrows to CollapsibleMessage
      const toolInfo = getCollapsibleToolInfo(msg, tools)!

      if (toolInfo.isMemoryWrite) {
        // Memory file write/edit — check if it's team memory
        const count = countToolUses(msg)
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemoryWriteOrEdit(toolInfo.name, toolInfo.input)
        ) {
          currentGroup.teamMemoryWriteCount =
            (currentGroup.teamMemoryWriteCount ?? 0) + count
        } else {
          currentGroup.memoryWriteCount += count
        }
      } else if (toolInfo.isAbsorbedSilently) {
        // Snip/ToolSearch absorbed silently — no count, no summary text.
        // Hidden from the default view but still shown in verbose mode
        // (Ctrl+O) via the groupMessages iteration in CollapsedReadSearchContent.
      } else if (toolInfo.isWrite) {
        // Files come from the input so the row appears while the write runs;
        // the line counts arrive with the result.
        for (const target of getWriteTargetsFromMessage(msg, toolInfo.name)) {
          recordWriteFile(currentGroup, target.path, target.kind)
        }
        for (const id of getToolUseIdsFromMessage(msg)) {
          currentGroup.writeToolNames.set(id, toolInfo.name)
        }
        if (msg.type === 'grouped_tool_use') {
          // applyGrouping consumed the user messages that held these results,
          // so they never reach the tool_result branch below.
          for (const resultMsg of msg.results) {
            applyWriteResult(currentGroup, toolInfo.name, resultMsg.toolUseResult)
          }
        }
      } else if (toolInfo.mcpServerName) {
        // MCP search/read — counted separately so the summary says
        // "Queried slack N times" instead of "Read N files".
        const count = countToolUses(msg)
        currentGroup.mcpCallCount = (currentGroup.mcpCallCount ?? 0) + count
        currentGroup.mcpServerNames?.add(toolInfo.mcpServerName)
        const input = toolInfo.input as { query?: string } | undefined
        if (input?.query) {
          currentGroup.latestDisplayHint = `"${input.query}"`
        }
      } else if (isFullscreenEnvEnabled() && toolInfo.isBash) {
        // Non-search/read Bash command — counted separately so the summary
        // says "Ran N bash commands" instead of breaking the group.
        const count = countToolUses(msg)
        currentGroup.bashCount = (currentGroup.bashCount ?? 0) + count
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          // Prefer the stripped `# comment` if present (it's what Claude wrote
          // for the human — same trigger as the comment-as-label tool-use render).
          currentGroup.latestDisplayHint =
            extractBashCommentLabel(input.command) ??
            commandAsHint(input.command)
          // Remember tool_use_id → command so the result (arriving next) can
          // be scanned for commit SHA / PR URL.
          for (const id of getToolUseIdsFromMessage(msg)) {
            currentGroup.bashCommands?.set(id, input.command)
          }
        }
      } else if (toolInfo.isList) {
        // Directory-listing bash commands (ls, tree, du) — counted separately
        // so the summary says "Listed N directories" instead of "Read N files".
        currentGroup.listCount += countToolUses(msg)
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          currentGroup.latestDisplayHint = commandAsHint(input.command)
        }
      } else if (toolInfo.isSearch) {
        // Use the isSearch flag from the tool to properly categorize bash search commands
        const count = countToolUses(msg)
        currentGroup.searchCount += count
        // Check if the search targets memory files (via path or glob pattern)
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemorySearch(toolInfo.input)
        ) {
          currentGroup.teamMemorySearchCount =
            (currentGroup.teamMemorySearchCount ?? 0) + count
        } else if (isMemorySearch(toolInfo.input)) {
          currentGroup.memorySearchCount += count
        } else {
          // Regular (non-memory) search — collect pattern for display
          const input = toolInfo.input as { pattern?: string } | undefined
          if (input?.pattern) {
            currentGroup.nonMemSearchArgs.push(input.pattern)
            currentGroup.latestDisplayHint = `"${input.pattern}"`
          }
        }
      } else {
        // For reads, track unique file paths instead of counting operations
        const filePaths = getFilePathsFromReadMessage(msg)
        for (const filePath of filePaths) {
          currentGroup.readFilePaths.add(filePath)
          if (feature('TEAMMEM') && teamMemOps?.isTeamMemFile(filePath)) {
            currentGroup.teamMemoryReadFilePaths?.add(filePath)
          } else if (isAutoManagedMemoryFile(filePath)) {
            currentGroup.memoryReadFilePaths.add(filePath)
          } else {
            // Non-memory file read — update display hint
            currentGroup.latestDisplayHint = getDisplayPath(filePath)
          }
        }
        // If no file paths found (e.g., Bash read commands like ls, cat), count the operations
        if (filePaths.length === 0) {
          currentGroup.readOperationCount += countToolUses(msg)
          // Use the Bash command as the display hint (truncated for readability)
          const input = toolInfo.input as { command?: string } | undefined
          if (input?.command) {
            currentGroup.latestDisplayHint = commandAsHint(input.command)
          }
        }
      }

      // Track tool use IDs for matching results
      for (const id of getToolUseIdsFromMessage(msg)) {
        currentGroup.toolUseIds.add(id)
      }

      currentGroup.messages.push(msg)
    } else if (isCollapsibleToolResult(msg, currentGroup.toolUseIds)) {
      currentGroup.messages.push(msg)
      // Scan bash results for commit SHAs / PR URLs to surface in the summary
      if (isFullscreenEnvEnabled() && currentGroup.bashCommands?.size) {
        scanBashResultForGitOps(msg, currentGroup)
      }
      if (currentGroup.writeToolNames.size > 0) {
        applyWriteResultsFromMessage(msg, currentGroup)
      }
    } else if (currentGroup.messages.length > 0 && isPreToolHookSummary(msg)) {
      // Absorb PreToolUse hook summaries into the group instead of deferring
      currentGroup.hookCount += msg.hookCount
      currentGroup.hookTotalMs +=
        msg.totalDurationMs ??
        msg.hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
      currentGroup.hookInfos.push(...msg.hookInfos)
    } else if (
      currentGroup.messages.length > 0 &&
      msg.type === 'attachment' &&
      msg.attachment.type === 'relevant_memories'
    ) {
      // Absorb auto-injected memory attachments so "recalled N memories"
      // renders inline with "ran N bash commands" instead of as a separate
      // ⏺ block. Do NOT add paths to readFilePaths/memoryReadFilePaths —
      // that would poison the readOperationCount fallback (bash-only reads
      // have no paths; adding memory paths makes readFilePaths.size > 0 and
      // suppresses the fallback). createCollapsedGroup adds .length to
      // memoryReadCount after the readCount subtraction instead.
      currentGroup.relevantMemories ??= []
      currentGroup.relevantMemories.push(...msg.attachment.memories)
    } else if (shouldSkipMessage(msg)) {
      // Don't flush the group for skippable messages (thinking, attachments, system)
      // If a group is in progress, defer these messages to output after the collapsed group
      // This preserves the visual ordering where the collapsed badge appears at the position
      // of the first tool use, not displaced by intervening skippable messages.
      // Exception: nested_memory attachments are pushed through even during a group so
      // ⎿ Loaded lines cluster tightly instead of being split by the badge's marginTop.
      if (
        currentGroup.messages.length > 0 &&
        !(msg.type === 'attachment' && msg.attachment.type === 'nested_memory')
      ) {
        deferredSkippable.push(msg)
      } else {
        result.push(msg)
      }
    } else if (isTextBreaker(msg)) {
      // Assistant text breaks the group
      flushGroup()
      result.push(msg)
    } else if (isNonCollapsibleToolUse(msg, tools)) {
      // Non-collapsible tool use breaks the group
      flushGroup()
      result.push(msg)
    } else {
      // User messages with non-collapsible tool results break the group
      flushGroup()
      result.push(msg)
    }
  }

  flushGroup()
  return result
}

/**
 * Generate a summary text for search/read/REPL counts.
 * @param searchCount Number of search operations
 * @param readCount Number of read operations
 * @param isActive Whether the group is still in progress (use present tense) or completed (use past tense)
 * @param replCount Number of REPL executions (optional)
 * @param memoryCounts Optional memory file operation counts
 * @returns Summary text like "Searching for 3 patterns, reading 2 files, REPL'd 5 times…"
 */
export function getSearchReadSummaryText(
  searchCount: number,
  readCount: number,
  isActive: boolean,
  replCount: number = 0,
  memoryCounts?: {
    memorySearchCount: number
    memoryReadCount: number
    memoryWriteCount: number
    teamMemorySearchCount?: number
    teamMemoryReadCount?: number
    teamMemoryWriteCount?: number
  },
  listCount: number = 0,
  writeCount: number = 0,
): string {
  const parts: string[] = []

  // Memory operations first
  if (memoryCounts) {
    const { memorySearchCount, memoryReadCount, memoryWriteCount } =
      memoryCounts
    if (memoryReadCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Recalling'
          : 'recalling'
        : parts.length === 0
          ? 'Recalled'
          : 'recalled'
      parts.push(
        `${verb} ${memoryReadCount} ${memoryReadCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    if (memorySearchCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Searching'
          : 'searching'
        : parts.length === 0
          ? 'Searched'
          : 'searched'
      parts.push(`${verb} memories`)
    }
    if (memoryWriteCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Writing'
          : 'writing'
        : parts.length === 0
          ? 'Wrote'
          : 'wrote'
      parts.push(
        `${verb} ${memoryWriteCount} ${memoryWriteCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    // Team memory operations
    if (feature('TEAMMEM') && teamMemOps) {
      teamMemOps.appendTeamMemorySummaryParts(memoryCounts, isActive, parts)
    }
  }

  if (writeCount > 0) {
    // Leads the tool parts for the same reason it does in the collapsed badge:
    // what the agent changed outranks what it looked at.
    const writeVerb = isActive
      ? parts.length === 0
        ? 'Editing'
        : 'editing'
      : parts.length === 0
        ? 'Edited'
        : 'edited'
    parts.push(
      `${writeVerb} ${writeCount} ${writeCount === 1 ? 'file' : 'files'}`,
    )
  }

  if (searchCount > 0) {
    const searchVerb = isActive
      ? parts.length === 0
        ? 'Searching for'
        : 'searching for'
      : parts.length === 0
        ? 'Searched for'
        : 'searched for'
    parts.push(
      `${searchVerb} ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`,
    )
  }

  if (readCount > 0) {
    const readVerb = isActive
      ? parts.length === 0
        ? 'Reading'
        : 'reading'
      : parts.length === 0
        ? 'Read'
        : 'read'
    parts.push(`${readVerb} ${readCount} ${readCount === 1 ? 'file' : 'files'}`)
  }

  if (listCount > 0) {
    const listVerb = isActive
      ? parts.length === 0
        ? 'Listing'
        : 'listing'
      : parts.length === 0
        ? 'Listed'
        : 'listed'
    parts.push(
      `${listVerb} ${listCount} ${listCount === 1 ? 'directory' : 'directories'}`,
    )
  }

  if (replCount > 0) {
    const replVerb = isActive ? "REPL'ing" : "REPL'd"
    parts.push(`${replVerb} ${replCount} ${replCount === 1 ? 'time' : 'times'}`)
  }

  const text = parts.join(', ')
  return isActive ? `${text}…` : text
}

/**
 * How many FILES a run of write tool uses touched — not how many calls it made.
 * A sub-agent's progress line and the collapsed badge describe the same work, so
 * they have to agree: two Edits of one file are one file, and one apply_patch
 * over five files is five. A write whose files are not knowable from its input
 * (Rename lists them only in its result) counts as one, because it did touch
 * something and reporting zero would erase it from the line.
 *
 * Unlike the badge, this cannot drop a write whose result came back an error:
 * the progress streams it feeds carry tool_uses, and one call site counts before
 * any result exists.
 */
export function countWriteFiles(
  writes: readonly { toolName: string; input: unknown }[],
): number {
  const paths = new Set<string>()
  let unknown = 0
  for (const { toolName, input } of writes) {
    const targets = getWriteTargets(toolName, input)
    if (targets && targets.length > 0) {
      for (const target of targets) {
        paths.add(target.path)
      }
    } else {
      unknown++
    }
  }
  return paths.size + unknown
}

/**
 * Summarize a list of recent tool activities into a compact description.
 * Rolls up trailing consecutive search/read operations using pre-computed
 * isSearch/isRead classifications from recording time. Falls back to the
 * last activity's description for non-collapsible tool uses.
 */
export function summarizeRecentActivities(
  activities: readonly {
    toolName?: string
    input?: unknown
    activityDescription?: string
    isSearch?: boolean
    isRead?: boolean
    isWrite?: boolean
  }[],
): string | undefined {
  if (activities.length === 0) {
    return undefined
  }
  // Count trailing search/read/write activities from the end of the list
  let searchCount = 0
  let readCount = 0
  let writeUses = 0
  const writes: { toolName: string; input: unknown }[] = []
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!
    if (activity.isSearch) {
      searchCount++
    } else if (activity.isRead) {
      readCount++
    } else if (activity.isWrite) {
      writeUses++
      if (activity.toolName) {
        writes.push({ toolName: activity.toolName, input: activity.input })
      }
    } else {
      break
    }
  }
  // The gate counts tool USES, so one apply_patch over five files does not
  // start summarizing on its own — but the text it produces counts files.
  const collapsibleCount = searchCount + readCount + writeUses
  if (collapsibleCount >= 2) {
    return getSearchReadSummaryText(
      searchCount,
      readCount,
      true,
      0,
      undefined,
      0,
      countWriteFiles(writes),
    )
  }
  // Fall back to most recent activity with a description (some tools like
  // SendMessage don't implement getActivityDescription, so search backward)
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]?.activityDescription) {
      return activities[i]!.activityDescription
    }
  }
  return undefined
}
