/**
 * What a memory fork may do. The extraction fork and the dream's
 * consolidation fork run under this policy, unattended and steered by
 * conversation content, so it is a short allow-list:
 *   - Read, Grep and Glob, anywhere;
 *   - Bash, when the Bash tool itself calls the command read-only;
 *   - Edit and Write, on a path inside the memory directory it was given.
 * Everything else is denied, whatever path it names.
 */
import { isAbsolute, normalize, sep } from 'path'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/shared/types/permissions.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import type { Tool } from 'src/tools/Tool.js'

type ToolInput = Record<string, unknown>

/** The parts of a tool the policy looks at: its name, and for Bash its own read-only verdict. */
export type ToolUnderReview = Pick<Tool, 'name' | 'inputSchema' | 'isReadOnly'>

/**
 * True for an absolute path that lies inside `directory` once `..` segments
 * are resolved. Lexical only: a symlink inside the directory is not followed.
 * The directory's trailing separator is part of the check, so a sibling
 * whose name extends the directory's is outside.
 */
export function isInsideDirectory(filePath: unknown, directory: string): boolean {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false
  const root = normalize(directory)
  return normalize(filePath).startsWith(root.endsWith(sep) ? root : root + sep)
}

function allow(input: ToolInput): PermissionDecision<ToolInput> {
  return { behavior: 'allow', updatedInput: input }
}

function deny(message: string): PermissionDecision<ToolInput> {
  return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
}

function whatIsAllowed(memoryDir: string): string {
  return `A memory fork may use ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME} and ${GLOB_TOOL_NAME} on any path, read-only ${BASH_TOOL_NAME} commands, and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} on files inside ${memoryDir}.`
}

/** Bash answers for itself: its schema must accept the input and it must call the command read-only. */
function shellCommandOnlyReads(tool: ToolUnderReview, input: ToolInput): boolean {
  try {
    const parsed = tool.inputSchema.safeParse(input)
    return parsed.success && tool.isReadOnly(parsed.data)
  } catch (error) {
    logError(error)
    return false
  }
}

export function decideMemoryForkToolUse(
  tool: ToolUnderReview,
  input: ToolInput,
  memoryDir: string,
): PermissionDecision<ToolInput> {
  switch (tool.name) {
    case FILE_READ_TOOL_NAME:
    case GREP_TOOL_NAME:
    case GLOB_TOOL_NAME:
      return allow(input)
    case BASH_TOOL_NAME:
      return shellCommandOnlyReads(tool, input)
        ? allow(input)
        : deny(`A memory fork may only run read-only ${BASH_TOOL_NAME} commands.`)
    case FILE_EDIT_TOOL_NAME:
    case FILE_WRITE_TOOL_NAME:
      return isInsideDirectory(input.file_path, memoryDir)
        ? allow(input)
        : deny(`${tool.name} is limited to files inside the memory directory. ${whatIsAllowed(memoryDir)}`)
    default:
      return deny(`${tool.name} is not available to a memory fork. ${whatIsAllowed(memoryDir)}`)
  }
}

/** The permission function a memory fork runs with, fenced to `memoryDir`. */
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool, input) => decideMemoryForkToolUse(tool, input, memoryDir)
}
