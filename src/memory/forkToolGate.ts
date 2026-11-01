/**
 * The tool gate of the background memory forks — the extraction and the
 * dream (createMemoryCanUseTool): reads anywhere, a read-only shell, writes
 * inside the memory dirs, append-only where a run is told to be, and for the
 * dream a Patch that prunes (prunePatchProblem). It lives apart from either
 * runner because both run under it.
 */
import { readFileSync } from 'fs'
import { basename } from 'path'
import { getMemoryDirs, memoryScopeOf } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME, type MemoryScope, withoutTrailingSep } from 'src/memory/memdir/memoryScopes.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { expandPath } from 'src/shared/fs/path.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isENOENT } from 'src/shared/errors.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { type Hunk, parsePatch } from 'src/tools/ApplyPatchTool/patchFormat.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import type { Tool } from 'src/tools/Tool.js'

function denyMemoryTool(tool: Tool, reason: string) {
  logForDebugging(`[autoMem] denied ${tool.name}: ${reason}`)
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: { type: 'other' as const, reason },
  }
}

/**
 * Whether an Edit or Write only adds to `filePath`: an Edit whose new text
 * keeps the old, a Write of a new file or of content that keeps the file's.
 */
function onlyAdds(toolName: string, input: Record<string, unknown>, filePath: string): boolean {
  if (toolName === FILE_EDIT_TOOL_NAME) {
    return (
      typeof input.old_string === 'string' &&
      typeof input.new_string === 'string' &&
      input.new_string.includes(input.old_string)
    )
  }
  let existing: string
  try {
    existing = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return isENOENT(e)
  }
  return typeof input.content === 'string' && input.content.includes(existing.trimEnd())
}

/** Whether `old` appears in `next` in order, other lines between: a Patch chunk that only adds. */
function keepsInOrder(old: readonly string[], next: readonly string[]): boolean {
  let at = 0
  for (const line of next) if (at < old.length && line === old[at]) at++
  return at === old.length
}

/**
 * Why a pruning Patch may not run, or null when it may: the dream merging
 * and retiring memories (memoryHygiene.ts). Every section writes a memory
 * dir; in an `appendOnly` one only an Add or an Update that keeps every line
 * it touches; no index is deleted; and a private memory is deleted only in
 * the Patch that writes another memory — the one it was merged into — since
 * the private dir has no git history to restore it from. A team delete needs
 * no survivor: git keeps it, and the commit is the review.
 */
export function prunePatchProblem(
  patchText: unknown,
  appendOnly: readonly MemoryScope[],
  cwd: string = getCwd(),
): string | null {
  if (typeof patchText !== 'string') return 'a Patch carries its sections in patchText'
  let hunks: Hunk[]
  try {
    hunks = parsePatch(patchText).hunks
  } catch (e) {
    return `the Patch does not parse: ${e instanceof Error ? e.message : String(e)}`
  }
  const written: string[] = []
  const privateDeletes: string[] = []
  for (const hunk of hunks) {
    // Resolved as the Patch tool resolves it (expandPath, `~` included), so
    // the gate judges the file the tool will write
    const abs = expandPath(hunk.path, cwd)
    const to = hunk.type === 'update' && hunk.movePath ? expandPath(hunk.movePath, cwd) : abs
    for (const path of new Set([abs, to])) {
      if (memoryScopeOf(path) === null) return `${path} is outside the memory dirs`
    }
    const scope = memoryScopeOf(abs)!
    if (appendOnly.includes(scope)) {
      const adds = hunk.type === 'add' || (hunk.type === 'update' && to === abs && hunk.chunks.every(c => keepsInOrder(c.oldLines, c.newLines)))
      if (!adds) {
        return `the ${scope} memory dir is append-only in this run: a Patch may add a memory or lines there, never remove, rewrite, move or delete one`
      }
    }
    if (hunk.type === 'delete') {
      if (basename(abs) === ENTRYPOINT_NAME) return `${ENTRYPOINT_NAME} is never deleted: remove its lines instead`
      if (scope === 'private') privateDeletes.push(abs)
    } else if (basename(to) !== ENTRYPOINT_NAME) {
      written.push(to)
    }
  }
  const alone = privateDeletes.filter(path => !written.some(other => other !== path))
  if (alone.length > 0) {
    return `a private memory is deleted only in the Patch that writes the memory it was merged into, since the private dir has no git history to restore it from: ${alone.join(', ')}`
  }
  return null
}

/** How a fork may use Patch: not at all (the extraction), or to prune (the dream). */
export type ForkPatchUse = 'none' | 'prune'

/**
 * Creates a canUseTool function that allows Read/Grep/Glob (unrestricted),
 * read-only Bash commands, and Edit/Write only within the memory directories
 * (memoryDirs.ts). Shared by extractMemories and autoDream.
 *
 * `appendOnly` scopes take an Edit or Write only when it adds: both forks
 * pass the global dir, which they may add to but never prune — one project's
 * run cannot tell that a memory every project reads is stale.
 *
 * `patch: 'prune'` also lets a Patch through when prunePatchProblem finds
 * none: the dream deleting what it merged or retired.
 */
export function createMemoryCanUseTool(
  appendOnly: readonly MemoryScope[] = [],
  { patch = 'none' }: { patch?: ForkPatchUse } = {},
): CanUseToolFn {
  return async (tool: Tool, input: Record<string, unknown>) => {
    // Allow Read/Grep/Glob unrestricted — all inherently read-only
    if (
      tool.name === FILE_READ_TOOL_NAME ||
      tool.name === GREP_TOOL_NAME ||
      tool.name === GLOB_TOOL_NAME
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // Allow Bash only for commands that pass BashTool.isReadOnly.
    // `tool` IS BashTool here — no static import needed.
    if (tool.name === BASH_TOOL_NAME) {
      const parsed = tool.inputSchema.safeParse(input)
      if (parsed.success && tool.isReadOnly(parsed.data)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return denyMemoryTool(
        tool,
        'Only read-only shell commands are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)',
      )
    }

    if (
      (tool.name === FILE_EDIT_TOOL_NAME ||
        tool.name === FILE_WRITE_TOOL_NAME) &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      const scope = typeof filePath === 'string' ? memoryScopeOf(filePath) : null
      if (scope !== null && !appendOnly.includes(scope)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      if (scope !== null) {
        return onlyAdds(tool.name, input, filePath as string)
          ? { behavior: 'allow' as const, updatedInput: input }
          : denyMemoryTool(
              tool,
              `the ${scope} memory dir is append-only in this run: add a memory or a line, never remove or rewrite one — leave a ${scope} memory this project contradicts as it is, and report it`,
            )
      }
    }

    if (tool.name === APPLY_PATCH_TOOL_NAME && patch === 'prune') {
      const problem = prunePatchProblem(input.patchText, appendOnly)
      return problem === null ? { behavior: 'allow' as const, updatedInput: input } : denyMemoryTool(tool, problem)
    }

    const where = getMemoryDirs()
      .map(dir => withoutTrailingSep(dir.root))
      .join(', ')
    return denyMemoryTool(
      tool,
      `only ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME}, and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} within ${where} are allowed`,
    )
  }
}

/**
 * The extraction fork's gate: append-only on the global dir, as the dream's
 * is — a background run in one project never rewrites or removes a memory
 * every project reads.
 */
export function createExtractionCanUseTool(): CanUseToolFn {
  return createMemoryCanUseTool(['global'])
}
